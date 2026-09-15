#!/usr/bin/env node
/**
 * Real write-path check that leaves the target repository exactly as it found it.
 *
 * `github_create_repository` needs a scope this token may not have, so the write path is
 * exercised against an existing repository instead — but only through refs this script
 * creates and then deletes:
 *
 * - a timestamped test branch, never the default branch;
 * - a timestamped tag;
 * - no release is published, because a release is externally visible and its deletion
 *   would leave `releases/tag/...` responding 404 rather than being truly gone.
 *
 * The approval gate is invoked directly for force-push classification, which needs no
 * actual force push: the point is to prove the gate fires before the operation.
 *
 * Reads the token from stdin and never writes, logs, or echoes it.
 */

import { createClient } from '../lib/gh-http.js';
import { decide } from '../lib/gh-approval.js';
import * as plugin from '../index.js';

const OWNER = 'Reduction77';
const REPO = 'UniversalConverter';
const STAMP = Date.now().toString(36);
const BRANCH = `dsh-selftest-${STAMP}`;
const TAG = `v0.0.0-dsh-selftest-${STAMP}`;

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

const ctx = {
	tools: { register: () => () => {} },
	credentials: {
		resolve: async () => ({ value: token, source: 'stdin' }),
		describe: async () => ({ configured: true, source: 'stdin', writable: false }),
	},
	on: () => {},
	logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

const client = createClient({ ctx, tokenRef: 'GITHUB_TOKEN', apiBase: 'https://api.github.com' });
const registered = new Map();
const hooks = [];
const toolCtx = {
	...ctx,
	tools: { register: (definition) => { registered.set(definition.name, definition); return () => {}; } },
	on: (event, listener) => { if (event === 'tools/pre-execute') hooks.push(listener); return () => {}; },
};

await plugin.apply(toolCtx, {
	tokenRef: 'GITHUB_TOKEN',
	apiBase: 'https://api.github.com',
	timeoutMs: 30000,
	uploadTimeoutMs: 600000,
	defaultOwner: OWNER,
	packTimeoutMs: 180000,
	statusFile: '',
});

const exec = (name, args) => ({ callId: `w-${name}`, name, arguments: args, signal: AbortSignal.timeout(120000) });
const results = [];
const check = async (label, run) => {
	try {
		results.push([label, true, await run()]);
	} catch (error) {
		results.push([label, false, error instanceof Error ? error.message : String(error)]);
	}
};

/** Bytes that would not survive a text round trip. */
const binary = Buffer.from(Array.from({ length: 3000 }, (_, index) => (index * 31) % 256));

await check('审批门：常规推送放行', async () => {
	let delegated = false;
	const decision = await hooks[0]({ name: 'github_push_files', arguments: { repo: REPO, files: [] } }, () => {
		delegated = true;
		return Promise.resolve({ kind: 'allow' });
	});
	if (!delegated || decision.kind !== 'allow') throw new Error(`delegated=${delegated} kind=${decision.kind}`);
	return '委托给下一个监听器，判定 allow';
});

await check('审批门：force push 拦下并给出理由', async () => {
	let delegated = false;
	const decision = await hooks[0](
		{ name: 'github_push_files', arguments: { repo: REPO, owner: OWNER, branch: 'main', force: true } },
		() => { delegated = true; return Promise.resolve({ kind: 'allow' }); },
	);
	if (delegated) throw new Error('不该委托');
	if (decision.kind !== 'ask') throw new Error(`kind=${decision.kind}`);
	return `未委托，判定 ask：${decision.reason.slice(0, 48)}…`;
});

await check('审批门：非本插件的工具不受影响', async () => {
	let delegated = false;
	await hooks[0]({ name: 'bash', arguments: { command: 'rm -rf /' } }, () => {
		delegated = true;
		return Promise.resolve({ kind: 'allow' });
	});
	if (!delegated) throw new Error('误拦了别的工具');
	return 'bash 未被本插件拦截';
});

await check(`推文件到临时分支 ${BRANCH}`, async () => {
	const pushed = await registered.get('github_push_files').execute({
		repo: REPO,
		owner: OWNER,
		branch: BRANCH,
		message: `selftest: ${STAMP}`,
		files: [
			{ path: 'selftest/hello.txt', content: `hello ${STAMP}\n` },
			{ path: 'selftest/nested/deep.txt', content: 'nested path check\n' },
			{ path: 'selftest/blob.bin', content: binary.toString('base64'), encoding: 'base64' },
		],
	}, exec('github_push_files', {}));
	if (pushed.files !== 3) throw new Error(`预期 3 个文件，实际 ${pushed.files}`);
	return `分支已建，commit ${String(pushed.commitSha).slice(0, 7)}，${pushed.files} 个文件`;
});

await check('二进制字节保真（经 base64 blob 传输）', async () => {
	const { body } = await client.request('GET', `/repos/${OWNER}/${REPO}/contents/selftest/blob.bin?ref=${BRANCH}`);
	const remote = Buffer.from(/** @type {{ content: string }} */ (body).content.replace(/\n/gu, ''), 'base64');
	if (!remote.equals(binary)) throw new Error(`字节不一致：本地 ${binary.length} B，远端 ${remote.length} B`);
	return `本地与远端均为 ${binary.length} B，逐字节一致`;
});

await check('嵌套路径按结构创建而非压平', async () => {
	const { body } = await client.request('GET', `/repos/${OWNER}/${REPO}/contents/selftest/nested?ref=${BRANCH}`);
	const entries = /** @type {Array<{ name: string, type: string }>} */ (body);
	if (entries[0]?.name !== 'deep.txt' || entries[0]?.type !== 'file') throw new Error(`结构不对：${JSON.stringify(entries)}`);
	return `selftest/nested/ 下是 ${entries[0].type} ${entries[0].name}`;
});

await check('拒绝把 PR 的 head 建成默认分支', async () => {
	let refused = false;
	try {
		await registered.get('github_upload_project').execute(
			{ repo: REPO, owner: OWNER, branch: 'main', createPullRequest: true },
			exec('github_upload_project', {}),
		);
	} catch (error) {
		refused = /无法再以它为 head 开 PR/u.test(error.message);
	}
	if (!refused) throw new Error('应该拒绝却没拒绝');
	return '在写入前就被拒绝（不需要真实 PR 场景）';
});

await check(`建 tag ${TAG}`, async () => {
	const { body } = await client.request('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
		body: { ref: `refs/tags/${TAG}`, sha: (await client.request('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).body.object.sha },
	});
	return `tag 指向 ${String(/** @type {{ object: { sha: string } }} */ (body).object.sha).slice(0, 7)}`;
});

// ── cleanup ─────────────────────────────────────────────────────────────────────
await check('清理：删除临时 tag 与临时分支', async () => {
	await client.request('DELETE', `/repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`);
	await client.request('DELETE', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
	return `${TAG} 与 ${BRANCH} 已删除`;
});

await check('清理确认：分支与 tag 均不可再解析', async () => {
	let branchGone = false;
	let tagGone = false;
	try {
		await client.request('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
	} catch (error) {
		branchGone = error.status === 404;
	}
	try {
		await client.request('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${TAG}`);
	} catch (error) {
		tagGone = error.status === 404;
	}
	if (!branchGone || !tagGone) throw new Error(`分支已删=${branchGone}，tag 已删=${tagGone}`);
	return '两者都返回 404，仓库回到测试前状态';
});

console.log('\n真实写链路验收（目标仓库最终状态不变）\n' + '─'.repeat(72));
let failed = 0;
for (const [label, ok, detail] of results) {
	if (!ok) failed++;
	console.log(`${ok ? '✓' : '✖'} ${label}\n    ${detail}`);
}
console.log('─'.repeat(72));
console.log(`${results.length - failed}/${results.length} 项通过`);
process.exit(failed === 0 ? 0 : 1);
