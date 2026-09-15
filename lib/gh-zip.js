/**
 * Zero-dependency ZIP writer for release packaging.
 *
 * Why hand-roll an archive format instead of shelling out:
 *
 * - The packaging path must work in a container with no `zip` binary, no `archiver`
 *   npm dependency, and no `npm install` step — the profile resolves `@deepseek-ai/*`
 *   through the harness checkout, so every third-party dependency would have to be
 *   vendored or installed into a directory the plugin does not own.
 * - Node 24 ships `zlib.crc32`, and DEFLATE via `zlib.deflateRawSync`, which are the
 *   only two primitives the format actually needs.
 *
 * The writer emits the minimal correct archive: local headers, a central directory,
 * and the end-of-central-directory record. No data descriptors, no ZIP64 (a release
 * artifact above 4 GB has no business in a release asset anyway, and the asset API
 * caps at 2 GB), and no directory entries — extractors synthesize those from the
 * stored paths.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { join, relative, sep } from 'node:path';

/**
 * The built-in implementation when this Node exposes it, else `undefined`.
 *
 * `zlib.crc32` is recent enough that a deployment on an older Node must still work,
 * and merely probing it once at load keeps the hot path free of feature checks.
 * @type {((data: NodeJS.ArrayBufferView) => number) | undefined}
 */
const builtinCrc32 = typeof zlibCrc32 === 'function' ? zlibCrc32 : undefined;

/** Local file header signature. */
const LOCAL_SIG = 0x04034b50;
/** Central directory header signature. */
const CENTRAL_SIG = 0x02014b50;
/** End of central directory signature. */
const EOCD_SIG = 0x06054b50;
/** Unix platform marker (3) shifted into the version-made-by high byte. */
const MADE_BY_UNIX = 0x031e;
/** Stored entries need only the original ZIP spec version. */
const VERSION_NEEDED = 20;

/**
 * CRC-32 fallback table, used only when `zlib.crc32` is unavailable.
 * @type {Uint32Array | undefined}
 */
let crcTable;

/**
 * Compute the CRC-32 of a buffer, preferring the built-in implementation.
 *
 * @param {Buffer} buffer - bytes to checksum.
 * @returns {number} unsigned CRC-32.
 */
function crc32(buffer) {
	if (typeof builtinCrc32 === 'function') return builtinCrc32(buffer) >>> 0;
	if (crcTable === undefined) {
		crcTable = new Uint32Array(256);
		for (let index = 0; index < 256; index++) {
			let value = index;
			for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
			crcTable[index] = value >>> 0;
		}
	}
	const table = crcTable;
	let crc = 0xffffffff;
	for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convert a Date to the MS-DOS date/time pair ZIP headers carry.
 *
 * DOS timestamps have two-second resolution and cannot represent dates before 1980;
 * anything earlier is clamped, which is what every archiver does.
 *
 * @param {Date} date - the timestamp to encode.
 * @returns {{ date: number, time: number }} packed DOS fields.
 */
function dosDateTime(date) {
	const year = Math.max(date.getFullYear(), 1980);
	return {
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
	};
}

/**
 * Recursively list every regular file under a directory.
 *
 * Symbolic links are skipped rather than followed: a link could point outside the
 * project and silently pull unrelated content into a published artifact.
 *
 * @param {string} root - directory to walk.
 * @param {string} dir - current directory.
 * @param {string[]} output - accumulator of absolute file paths.
 * @returns {Promise<string[]>} the accumulated file paths.
 */
async function walk(root, dir, output) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			await walk(root, path, output);
			continue;
		}
		if (entry.isFile()) output.push(path);
	}
	return output;
}

/**
 * Build a ZIP archive in memory from an explicit file list.
 *
 * @param {object} options - archive inputs.
 * @param {Array<{ absolute: string, stored: string, buffer: Buffer, mtime: Date }>} options.entries - files to store.
 * @returns {Buffer} the complete archive.
 */
export function buildArchive({ entries }) {
	/** @type {Buffer[]} */
	const chunks = [];
	/** @type {Array<{ name: Buffer, crc: number, compressed: number, uncompressed: number, offset: number, dos: { date: number, time: number }, method: number }>} */
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.stored.split(sep).join('/'), 'utf8');
		const inflated = entry.buffer;
		const deflated = deflateRawSync(inflated, { level: 9 });
		// ZIP stores whichever is smaller; a stored entry needs method 0 and equal sizes.
		const useDeflate = deflated.length < inflated.length;
		const payload = useDeflate ? deflated : inflated;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(inflated);
		const dos = dosDateTime(entry.mtime);

		const header = Buffer.alloc(30);
		header.writeUInt32LE(LOCAL_SIG, 0);
		header.writeUInt16LE(VERSION_NEEDED, 4);
		header.writeUInt16LE(0, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt16LE(dos.time, 10);
		header.writeUInt16LE(dos.date, 12);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(payload.length, 18);
		header.writeUInt32LE(inflated.length, 22);
		header.writeUInt16LE(name.length, 26);
		header.writeUInt16LE(0, 28);

		chunks.push(header, name, payload);
		central.push({ name, crc, compressed: payload.length, uncompressed: inflated.length, offset, dos, method });
		offset += header.length + name.length + payload.length;
	}

	const centralStart = offset;
	for (const entry of central) {
		const header = Buffer.alloc(46);
		header.writeUInt32LE(CENTRAL_SIG, 0);
		header.writeUInt16LE(MADE_BY_UNIX, 4);
		header.writeUInt16LE(VERSION_NEEDED, 6);
		header.writeUInt16LE(0, 8);
		header.writeUInt16LE(entry.method, 10);
		header.writeUInt16LE(entry.dos.time, 12);
		header.writeUInt16LE(entry.dos.date, 14);
		header.writeUInt32LE(entry.crc, 16);
		header.writeUInt32LE(entry.compressed, 20);
		header.writeUInt32LE(entry.uncompressed, 24);
		header.writeUInt16LE(entry.name.length, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(0, 38);
		header.writeUInt32LE(entry.offset, 42);
		chunks.push(header, entry.name);
		offset += header.length + entry.name.length;
	}

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(central.length, 8);
	eocd.writeUInt16LE(central.length, 10);
	eocd.writeUInt32LE(offset - centralStart, 12);
	eocd.writeUInt32LE(centralStart, 16);
	eocd.writeUInt16LE(0, 20);
	chunks.push(eocd);

	return Buffer.concat(chunks);
}

/**
 * Collect a package directory into archive entries using an extension allowlist.
 *
 * The allowlist is the same idea as a project's own packaging script: publish code,
 * docs, and assets, never configuration, credentials, downloaded media, test output,
 * or build detritus. Directories are filtered before the walk so a large ignored tree
 * is never traversed.
 *
 * @param {object} options - collection inputs.
 * @param {string} options.root - project root.
 * @param {string[]} options.files - root-level file names to include.
 * @param {string[]} options.directories - root-level directory names to include.
 * @param {string[]} options.extensions - allowed file extensions, with the dot.
 * @param {string[]} options.excludedDirectories - directory names skipped anywhere in the tree.
 * @returns {Promise<Array<{ absolute: string, stored: string, buffer: Buffer, mtime: Date }>>} archive entries.
 */
export async function collectEntries({ root, files, directories, extensions, excludedDirectories }) {
	const allowed = new Set(extensions);
	const skipped = new Set(excludedDirectories);
	/** @type {string[]} */
	const selected = [];

	for (const name of files) {
		const path = join(root, name);
		try {
			const info = await stat(path);
			if (info.isFile()) selected.push(path);
		} catch {
			// A missing optional file (LICENSE, CHANGELOG) is not an error.
		}
	}

	for (const name of directories) {
		const path = join(root, name);
		let info;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		if (!info.isDirectory()) continue;
		const walked = await walk(path, path, []);
		for (const file of walked) {
			const segments = relative(path, file).split(sep);
			if (segments.some((segment) => skipped.has(segment))) continue;
			const dot = file.lastIndexOf('.');
			if (dot === -1) continue;
			if (!allowed.has(file.slice(dot).toLowerCase())) continue;
			selected.push(file);
		}
	}

	selected.sort((left, right) => left.localeCompare(right));
	/** @type {Array<{ absolute: string, stored: string, buffer: Buffer, mtime: Date }>} */
	const entries = [];
	for (const file of selected) {
		const [buffer, info] = await Promise.all([readFile(file), stat(file)]);
		entries.push({ absolute: file, stored: relative(root, file), buffer, mtime: info.mtime });
	}
	return entries;
}
