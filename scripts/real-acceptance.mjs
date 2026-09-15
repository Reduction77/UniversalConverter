#!/usr/bin/env node
/**
 * One-off real-API acceptance check for the plugin's release flow.
 *
 * The token is read from stdin and never written to disk, never logged, and never
 * included in output: the whole point of the plugin's credential design is that the
 * secret stays out of configuration and logs, so this driver has to honour the same
 * rule while it exercises the real GitHub API.
 *
 * Creates a throwaway private repository, pushes files, publishes a release with a
 * generated artifact, reads it back, and deletes the repository.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, describeToken, GitHubApiError } from '../lib/gh-http.js';
import * as plugin from '../index.js';

const REPO = `dsh-github-ops-selftest-${Date.now().toString(36)}`;
const OWNER = 'Reduction77';

/** Read the token from stdin without echoing it. */
async function readToken() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8').trim();
}

const token = await readToken();
if (token.length === 0) {
	console.error('no token on stdin');
	process.exit(2);
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const ctx = {
	tools: { register: () => () => {} },
	credentials: {
		resolve: async () => ({ value: token, source: 'stdin' }),
		describe: async () => ({ configured: true, source: 'stdin', writable: false }),
	},
	on: () => {},
	logger,
};

const client = createClient({ ctx, tokenRef: 'GITHUB_TOKEN', apiBase: 'https://api.github.com' });
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
	// Record only the endpoint shape, never headers or bodies.
	calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(href).host}${new URL(href).pathname}`);
	return realFetch(url, init);
};

/** Run the plugin's tools exactly as the harness would. */
const registered = new Map();
const toolCtx = { ...ctx, tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } } };
await plugin.apply(toolCtx, {
	tokenRef: 'GITHUB_TOKEN',
	apiBase: 'https://api.github.com',
	timeoutMs: 30000,
	uploadTimeoutMs: 600000,
	defaultOwner: OWNER,
	packTimeoutMs: 180000,
	statusFile: '',
});

const exec = (name, args) => ({ callId: `real-${name}`, name, arguments: args, signal: AbortSignal.timeout(180000) });
const results = [];
let repoCreated = false;

try {
	// ── 1. credential ────────────────────────────────────────────────────────────
	const status = await registered.get('github_auth_status').execute({}, exec('github_auth_status', {}));
	results.push(['凭据可用', status.valid === true && status.login === OWNER, `login=${status.login} 剩余配额=${status.remaining}`]);
	if (status.valid !== true) throw new Error(`凭据不可用：${status.hint}`);

	// ── 2. build a throwaway project ─────────────────────────────────────────────
	const root = await mkdtemp(join(tmpdir(), 'dsh-selftest-'));
	await mkdir(join(root, 'lib'), { recursive: true });
	await mkdir(join(root, 'dist'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: REPO, version: '0.1.0' }));
	await writeFile(join(root, 'README.md'), '# selftest\n');
	await writeFile(join(root, 'lib', 'a.mjs'), 'export const a = 1;\n');
	await writeFile(join(root, 'lib', 'b.txt'), 'x'.repeat(20000));
	// A real binary payload, to prove base64 blob transport does not corrupt bytes.
	const binary = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7) % 256));
	await writeFile(join(root, 'lib', 'blob.bin'), binary);
	await writeFile(join(root, 'CHANGELOG.md'), '# 更新日志\n\n## 0.1.0\n\n- 首个版本。\n');

	try {
		// ── 3. create + push the project ─────────────────────────────────────────
		const upload = await registered.get('github_upload_project').execute(
			{ repo: REPO, dir: root, description: 'dsh-github-ops selftest', visibility: 'private' },
			exec('github_upload_project', {}),
		);
		repoCreated = true;
		results.push(['建仓 + 推文件', upload.createdRepository === true && upload.files === 6, `私有仓库，${upload.files} 个文件，commit ${upload.commitSha.slice(0, 7)}`]);

		// ── 4. byte fidelity of a binary file ────────────────────────────────────
		const { body: remote } = await client.request('GET', `/repos/${OWNER}/${REPO}/contents/lib/blob.bin`);
		const remoteBytes = Buffer.from(/** @type {{ content: string }} */ (remote).content.replace(/\n/gu, ''), 'base64');
		results.push(['二进制字节保真', remoteBytes.equals(binary), `本地 ${binary.length} B，远端 ${remoteBytes.length} B`]);

		// ── 5. second push is additive, not a reset ──────────────────────────────
		await writeFile(join(root, 'SECOND.md'), '# second\n');
		const second = await registered.get('github_upload_project').execute(
			{ repo: REPO, dir: root, message: 'add SECOND.md' },
			exec('github_upload_project', {}),
		);
		const { body: listing } = await client.request('GET', `/repos/${OWNER}/${REPO}/contents/`);
		const names = /** @type {Array<{ name: string }>} */ (listing).map((entry) => entry.name);
		results.push(['重复上传是叠加而非重置', names.includes('README.md') && names.includes('SECOND.md'), `根目录：${names.sort().join(', ')}（${second.files} 个文件）`]);

		// ── 6. release with a generated artifact ─────────────────────────────────
		const release = await registered.get('github_release_publish').execute(
			{ repo: REPO, tag: 'v0.1.0', dir: root },
			exec('github_release_publish', {}),
		);
		results.push([
			'发 release + 上传附件',
			release.created === true && release.assetSize > 0,
			`tag=${release.tag} 附件=${release.assetName} (${release.assetSize} B) 由 ${release.builtBy} 产出`,
		]);
		results.push(['版本校验通过', /通过/u.test(release.versionCheck), release.versionCheck]);
		results.push(['正文含 CHANGELOG 小节', /首个版本/u.test(release.body), '正文抽到了 0.1.0 那一节']);

		// ── 7. the asset is downloadable and byte-identical ──────────────────────
		const assetResponse = await realFetch(release.assetUrl, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
		});
		const downloaded = Buffer.from(await assetResponse.arrayBuffer());
		const local = await readFile(join(root, 'dist', release.assetName));
		results.push([
			'附件可下载且与原文件一致',
			assetResponse.ok && downloaded.equals(local),
			`HTTP ${assetResponse.status}，${downloaded.length} B，内容一致=${downloaded.equals(local)}`,
		]);

		// ── 8. re-releasing replaces the asset ───────────────────────────────────
		const again = await registered.get('github_release_publish').execute(
			{ repo: REPO, tag: 'v0.1.0', dir: root },
			exec('github_release_publish', {}),
		);
		results.push(['重发替换同名附件', again.created === false && again.replaced === release.assetName, `替换了 ${again.replaced}`]);

		// ── 9. read-back ─────────────────────────────────────────────────────────
		const read = await registered.get('github_get_release').execute({ repo: REPO, tag: 'v0.1.0' }, exec('github_get_release', {}));
		results.push(['读回 release', read.assets.length === 1 && read.draft === false, `${read.assets.length} 个附件：${read.assets.map((asset) => asset.name).join(', ')}`]);

		// ── 10. version mismatch is refused before any write ─────────────────────
		const before = calls.length;
		let refused = false;
		try {
			await registered.get('github_release_publish').execute(
				{ repo: REPO, tag: 'v9.9.9', dir: root },
				exec('github_release_publish', {}),
			);
		} catch (error) {
			refused = /版本一致性校验未通过/u.test(error.message);
		}
		results.push(['版本错位被拒且零写入', refused && calls.length === before, `拒绝后未产生新请求（调用数 ${before} → ${calls.length}）`]);

		// ── 11. private repo without scope: uses the real 404 path ───────────────
		let missingReported = false;
		try {
			await registered.get('github_push_files').execute(
				{ repo: 'definitely-not-a-real-repo-xyz', files: [{ path: 'a.txt', content: 'x' }] },
				exec('github_push_files', {}),
			);
		} catch (error) {
			missingReported = /不存在或当前凭据无权访问/u.test(error.message);
		}
		results.push(['仓库不存在时给出可操作报错', missingReported, '提示了私有库需要 repo 权限']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
} catch (error) {
	results.push(['执行中断', false, error instanceof Error ? error.message : String(error)]);
} finally {
	// ── cleanup: the throwaway repository must not survive the test ──────────────
	if (repoCreated) {
		try {
			await client.request('DELETE', `/repos/${OWNER}/${REPO}`);
			results.push(['清理测试仓库', true, `${OWNER}/${REPO} 已删除`]);
		} catch (error) {
			results.push(['清理测试仓库', false, `删除失败，请手动删除 ${OWNER}/${REPO}：${error instanceof GitHubApiError ? error.status : String(error)}`]);
		}
	}
}

console.log('\n真实 API 验收结果\n' + '─'.repeat(72));
let failed = 0;
for (const [label, ok, detail] of results) {
	if (!ok) failed++;
	console.log(`${ok ? '✓' : '✖'} ${label}\n    ${detail}`);
}
console.log('─'.repeat(72));
console.log(`共发出 ${calls.length} 个请求；${results.length - failed}/${results.length} 项通过`);
process.exit(failed === 0 ? 0 : 1);
