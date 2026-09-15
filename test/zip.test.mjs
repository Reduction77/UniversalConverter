/**
 * Unit tests for the hand-written ZIP writer.
 *
 * The writer's whole reason to exist is that no `zip` binary and no archiver
 * dependency are available, so the test must prove the output is readable by a
 * *different* implementation rather than by this one. It therefore shells out to
 * Python's `zipfile`, which is a standard-library, independently written reader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildArchive, collectEntries } from '../lib/gh-zip.js';

const run = promisify(execFile);

/**
 * Read an archive back with Python's zipfile and report its members.
 *
 * @param {string} archivePath - archive to inspect.
 * @returns {Promise<Array<{ name: string, size: number, crc: number }>>} member records.
 */
async function pythonList(archivePath) {
	const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    if bad is not None:
        print(json.dumps({"error": f"CRC mismatch: {bad}"}))
        sys.exit(0)
    print(json.dumps([
        {"name": i.filename, "size": i.file_size, "crc": i.CRC}
        for i in z.infolist()
    ]))
`;
	const { stdout } = await run('python3', ['-c', script, archivePath]);
	return JSON.parse(stdout);
}

test('zip: python zipfile reads back every member with a valid CRC', async () => {
	const root = await mkdtemp(join(tmpdir(), 'gh-zip-'));
	try {
		await mkdir(join(root, 'lib', 'nested'), { recursive: true });
		await writeFile(join(root, 'package.json'), '{"name":"demo","version":"1.2.3"}');
		await writeFile(join(root, 'lib', 'a.mjs'), 'export const a = 1;\n');
		await writeFile(join(root, 'lib', 'nested', 'b.txt'), 'x'.repeat(5000));
		const entries = await collectEntries({
			root,
			files: ['package.json', 'MISSING.md'],
			directories: ['lib'],
			extensions: ['.json', '.mjs', '.txt'],
			excludedDirectories: ['node_modules'],
		});
		const archive = buildArchive({ entries });
		const archivePath = join(root, 'out.zip');
		await writeFile(archivePath, archive);

		const members = await pythonList(archivePath);
		assert.equal(members.error, undefined);
		assert.deepEqual(
			members.map((member) => member.name).sort(),
			['lib/a.mjs', 'lib/nested/b.txt', 'package.json'],
		);
		// Cross-check the CRC of one member against Node's own implementation.
		const nodeCrc = (await import('node:zlib')).crc32(Buffer.from('export const a = 1;\n'));
		const found = members.find((member) => member.name === 'lib/a.mjs');
		assert.equal(found.crc >>> 0, nodeCrc >>> 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('zip: empty archive is still a valid zip', async () => {
	const root = await mkdtemp(join(tmpdir(), 'gh-zip-empty-'));
	try {
		const archivePath = join(root, 'empty.zip');
		await writeFile(archivePath, buildArchive({ entries: [] }));
		const members = await pythonList(archivePath);
		assert.deepEqual(members, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('zip: collectEntries excludes disallowed extensions and skipped directories', async () => {
	const root = await mkdtemp(join(tmpdir(), 'gh-zip-filter-'));
	try {
		await mkdir(join(root, 'lib', 'node_modules'), { recursive: true });
		await mkdir(join(root, 'config'), { recursive: true });
		await writeFile(join(root, 'lib', 'keep.mjs'), 'keep');
		await writeFile(join(root, 'lib', 'node_modules', 'dep.mjs'), 'dep');
		await writeFile(join(root, 'lib', 'secret.env'), 'TOKEN=1');
		await writeFile(join(root, 'config', 'settings.json'), '{}');
		const entries = await collectEntries({
			root,
			files: [],
			directories: ['lib', 'config'],
			extensions: ['.mjs'],
			excludedDirectories: ['node_modules'],
		});
		assert.deepEqual(entries.map((entry) => entry.stored), ['lib/keep.mjs']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
