#!/usr/bin/env node
/**
 * Read-only acceptance check against the maintainer's real repositories.
 *
 * Runs the tools that need no write scope, so a partially-scoped token can still be
 * diagnosed precisely: it reports which capability the token lacks and which it has,
 * instead of a single opaque failure.
 *
 * Reads the token from stdin and never writes, logs, or echoes it.
 */

import { describeToken, resolveToken } from '../lib/gh-http.js';
import * as plugin from '../index.js';

const OWNER = 'Reduction77';
const REPO = 'GPU_Monitor_Pro';
const WORKSPACE_DIR = '/workspace/NapCat的b站识别插件/napcat-plugin-bili-recognizer';

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

const registered = new Map();
const ctx = {
	tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } },
	credentials: {
		resolve: async () => ({ value: token, source: 'stdin' }),
		describe: async () => ({ configured: true, source: 'stdin', writable: false }),
	},
	on: () => {},
	logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

await plugin.apply(ctx, {
	tokenRef: 'GITHUB_TOKEN',
	apiBase: 'https://api.github.com',
	timeoutMs: 30000,
	uploadTimeoutMs: 600000,
	defaultOwner: OWNER,
	packTimeoutMs: 180000,
	statusFile: '',
});

const exec = (name) => ({ callId: `ro-${name}`, name, arguments: {}, signal: AbortSignal.timeout(120000) });
const results = [];
const check = async (label, run) => {
	try {
		const detail = await run();
		results.push([label, true, detail]);
	} catch (error) {
		results.push([label, false, error instanceof Error ? error.message : String(error)]);
	}
};

await check('凭据解析（不回显任何值）', async () => {
	const resolved = await resolveToken({ ctx, tokenRef: 'GITHUB_TOKEN' });
	const described = await describeToken({ ctx, tokenRef: 'GITHUB_TOKEN' });
	if (resolved === undefined) throw new Error('未解析到值');
	const leaked = JSON.stringify(described).includes(resolved.value);
	if (leaked) throw new Error('describe() 泄漏了 token 值');
	return `source=${described.source}，值已确认不出现在描述里`;
});

await check('账号与配额', async () => {
	const status = await registered.get('github_auth_status').execute({}, exec('github_auth_status'));
	if (status.valid !== true) throw new Error(status.hint ?? 'invalid');
	return `login=${status.login}，配额 ${status.remaining}/${status.limit}`;
});

await check(`读 release（${OWNER}/${REPO} v3.0.0 的 exe）`, async () => {
	const release = await registered.get('github_get_release').execute({ repo: REPO, tag: 'v3.0.0' }, exec('github_get_release'));
	if (release.assets.length === 0) throw new Error('该 tag 没有附件');
	const asset = release.assets[0];
	return `${release.assets.length} 个附件：${asset.name}（${(asset.size / 1048576).toFixed(2)} MB，下载 ${asset.downloads} 次），draft=${release.draft}`;
});

await check(`读最新 release（${OWNER}/${REPO}）`, async () => {
	const release = await registered.get('github_get_release').execute({ repo: REPO }, exec('github_get_release'));
	return `tag=${release.tag}，发布于 ${release.publishedAt?.slice(0, 10)}`;
});

await check('读取你自己的插件仓库 CHANGELOG 并抽取版本小节', async () => {
	// Exercises the same code path the release body uses, on real content.
	const { readFile } = await import('node:fs/promises');
	const { extractChangelogSection } = await import('../lib/gh-release.js');
	const changelog = await readFile(`${WORKSPACE_DIR}/CHANGELOG.md`, 'utf8');
	const section = extractChangelogSection(changelog, '1.6.0');
	if (section === undefined) throw new Error('没抽到 1.6.0 的小节');
	const firstLine = section.split('\n')[0];
	return `抽到 ${section.split('\n').length} 行，首行：${firstLine.slice(0, 60)}…`;
});

await check('版本一致性校验能抓到 UniversalConverter 的错位', async () => {
	const { checkVersionConsistency } = await import('../lib/gh-release.js');
	const verdict = checkVersionConsistency({
		tag: 'v1.0.0',
		manifestVersion: '0.3.0',
		assetName: 'UniversalConverter_v0.3.0_GitHub_Source.zip',
	});
	if (verdict.ok) throw new Error('应该判为不一致，却通过了');
	return verdict.mismatches.join('；');
});

console.log('\n真实仓库只读验收\n' + '─'.repeat(72));
let failed = 0;
for (const [label, ok, detail] of results) {
	if (!ok) failed++;
	console.log(`${ok ? '✓' : '✖'} ${label}\n    ${detail}`);
}
console.log('─'.repeat(72));
console.log(`${results.length - failed}/${results.length} 项通过`);
process.exit(failed === 0 ? 0 : 1);
