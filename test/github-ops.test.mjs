/**
 * End-to-end tests for the GitHub tools against a fake API.
 *
 * The fake is a router over a recorded call log rather than a mock of each function, so
 * one test proves several things at once: that the plugin registers as expected, that
 * the Git Data sequence is issued in a valid order, that the release flow reaches the
 * separate uploads host, and that approval and version checks fire before anything is
 * written.
 *
 * `fetch` is replaced globally here on purpose: the client under test builds its own
 * requests with the global fetch, so injecting a client would test a different code path
 * than production.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../index.js';
const { Config, apply, inject, name } = plugin;

/** JSON response helper. */
const json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json' },
});

/**
 * Install a fake GitHub API and collect every request it receives.
 *
 * @param {object} [options] - fake behaviour switches.
 * @param {boolean} [options.existingRepo] - whether the repository already exists.
 * @param {object} [options.release] - release payload overrides for the lookup.
 * @param {string[]} [options.existingAssets] - asset names already on the release.
 * @returns {{ calls: Array<{ method: string, url: string, headers: Record<string, string>, body: string }>, restore: () => void }} the recorder.
 */
function installFakeApi({ existingRepo = false, release, existingAssets = [] } = {}) {
	const calls = [];
	const original = globalThis.fetch;
	let repoCreated = existingRepo;
	let releaseMade = release;

	globalThis.fetch = async (url, init = {}) => {
		const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
		const method = (init.method ?? 'GET').toUpperCase();
		const target = new URL(href);
		const path = target.pathname;
		const record = {
			method,
			url: href,
			headers: /** @type {Record<string, string>} */ (init.headers ?? {}),
			body: typeof init.body === 'string' ? init.body : `<${typeof init.body}>`,
		};
		calls.push(record);

		assert.equal(record.headers.Authorization, 'Bearer ghp_test_token', 'every call must carry the resolved token');

		if (target.host === 'uploads.github.com') {
			assert.ok(record.headers['Content-Length'], 'asset upload must send an explicit content-length');
			assert.equal(record.headers['Content-Type'], 'application/octet-stream');
			return json({
				id: 7001,
				name: target.searchParams.get('name'),
				browser_download_url: `https://github.com/Reduction77/demo/releases/download/v1.6.0/${target.searchParams.get('name')}`,
			}, 201);
		}

		if (path === '/rate_limit') return json({ resources: { core: { remaining: 4980, limit: 5000 } } });
		if (path === '/user') return json({ login: 'Reduction77' });

		if (path === '/user/repos' && method === 'POST') {
			const payload = JSON.parse(record.body);
			repoCreated = true;
			return json({
				name: payload.name,
				html_url: `https://github.com/Reduction77/${payload.name}`,
				private: payload.private,
				default_branch: 'main',
			}, 201);
		}

		if (path === '/repos/Reduction77/demo' && method === 'GET') {
			if (!repoCreated) return json({ message: 'Not Found' }, 404);
			return json({ name: 'demo', private: false, default_branch: 'main', html_url: 'https://github.com/Reduction77/demo' });
		}

		if (path === '/repos/Reduction77/demo/topics' && method === 'PUT') return json({ names: JSON.parse(record.body).names });

		if (path === '/repos/Reduction77/demo/git/ref/heads/main') {
			return json({ object: { sha: 'base-commit-sha' } });
		}
		if (path.startsWith('/repos/Reduction77/demo/git/ref/heads/')) {
			// Any other branch does not exist yet, which is the seeding path under test.
			return json({ message: 'Not Found' }, 404);
		}
		if (path === '/repos/Reduction77/demo/git/commits/base-commit-sha') {
			return json({ sha: 'base-commit-sha', tree: { sha: 'base-tree-sha' } });
		}
		if (path === '/repos/Reduction77/demo/git/blobs' && method === 'POST') {
			return json({ sha: `blob-${calls.filter((call) => call.url.endsWith('/git/blobs')).length}` }, 201);
		}
		if (path === '/repos/Reduction77/demo/git/trees' && method === 'POST') {
			return json({ sha: 'new-tree-sha' }, 201);
		}
		if (path === '/repos/Reduction77/demo/git/commits' && method === 'POST') {
			return json({ sha: 'new-commit-sha' }, 201);
		}
		if (path === '/repos/Reduction77/demo/git/refs/heads/main' && method === 'PATCH') {
			return json({ object: { sha: JSON.parse(record.body).sha } });
		}
		if (path === '/repos/Reduction77/demo/git/refs' && method === 'POST') {
			return json({ ref: JSON.parse(record.body).ref }, 201);
		}
		if (path === '/repos/Reduction77/demo/pulls' && method === 'POST') {
			return json({ number: 7, html_url: 'https://github.com/Reduction77/demo/pull/7' }, 201);
		}

		if (/^\/repos\/Reduction77\/demo\/git\/ref\/tags\/v[\d.]+$/u.test(path)) {
			return releaseMade === undefined ? json({ message: 'Not Found' }, 404) : json({ ref: path.split('/').pop() });
		}
		if (/^\/repos\/Reduction77\/demo\/releases\/tags\/v[\d.]+$/u.test(path)) {
			if (releaseMade === undefined) return json({ message: 'Not Found' }, 404);
			return json(releaseMade);
		}
		if (path === '/repos/Reduction77/demo/releases' && method === 'POST') {
			releaseMade = {
				id: 9001,
				html_url: 'https://github.com/Reduction77/demo/releases/tag/v1.6.0',
				tag_name: 'v1.6.0',
				upload_url: 'https://uploads.github.com/repos/Reduction77/demo/releases/9001/assets{?name,label}',
				assets: existingAssets.map((assetName, index) => ({ id: 5000 + index, name: assetName })),
			};
			return json(releaseMade, 201);
		}
		if (/^\/repos\/Reduction77\/demo\/releases\/assets\/\d+$/u.test(path) && method === 'DELETE') {
			return new Response(null, { status: 204 });
		}

		throw new Error(`fake API: unrouted ${method} ${path}`);
	};

	return {
		calls,
		restore: () => { globalThis.fetch = original; },
	};
}

/**
 * Build a fake plugin context that records registrations and resolves a fixed token.
 *
 * Takes an options object rather than a destructured default on purpose: a destructuring
 * default fires for an explicitly passed `undefined`, which would silently turn the
 * "no credential configured" case back into a configured one.
 *
 * @param {{ token?: string | undefined }} [options] - credential behaviour.
 * @returns {{ ctx: object, tools: Map<string, object>, hooks: Array<Function> }} the context and its records.
 */
function makeContext(options = {}) {
	const token = Object.hasOwn(options, 'token') ? options.token : 'ghp_test_token';
	/** @type {Map<string, object>} */
	const tools = new Map();
	/** @type {Array<Function>} */
	const hooks = [];
	const ctx = {
		tools: {
			register(definition_) {
				tools.set(definition_.name, definition_);
				return () => tools.delete(definition_.name);
			},
		},
		credentials: {
			resolve: async () => (token === undefined ? undefined : { value: token, source: 'file' }),
			// Mirrors the real provider: an unconfigured reference reports no source and
			// is not writable, while a configured one reports its supplying layer.
			describe: async () => (token === undefined
				? { configured: false, writable: false }
				: { configured: true, source: 'file', writable: true }),
		},
		on(event, listener) {
			if (event !== 'tools/pre-execute') throw new Error(`unexpected event ${event}`);
			hooks.push(listener);
		},
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
	};
	return { ctx, tools, hooks };
}

/**
 * Register the plugin and return its tools plus the approval hook.
 *
 * @param {object} [options] - passthrough to {@link makeContext}.
 * @returns {{ tools: Map<string, object>, hooks: Array<Function>, ctx: object }} registration records.
 */
function register(options) {
	const { ctx, tools, hooks } = makeContext(options);
	apply(ctx, /** @type {never} */ ({
		tokenRef: 'GITHUB_TOKEN',
		apiBase: 'https://api.github.com',
		timeoutMs: 30000,
		uploadTimeoutMs: 600000,
		defaultOwner: 'Reduction77',
		packTimeoutMs: 180000,
		statusFile: '',
	}));
	return { tools, hooks, ctx };
}

/**
 * Build an execution context for one tool call.
 *
 * @param {string} toolName - the tool being invoked.
 * @param {unknown} args - parsed arguments.
 * @returns {object} a minimal ToolRunContext.
 */
const execFor = (toolName, args) => ({
	callId: `call-${toolName}`,
	name: toolName,
	arguments: args,
	agent: undefined,
	signal: new AbortController().signal,
});

beforeEach(() => {
	// The credential provider reads the process environment, so a value present in the
	// ambient environment (or written by a concurrently running test) would make the
	// token-dependent tests report the wrong source.
	delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
	delete process.env.GITHUB_TOKEN;
});

test('plugin: exports the loader contract', () => {
	assert.equal(name, 'dsh-github-ops');
	assert.deepEqual(inject, ['tools', 'credentials']);
	assert.equal(typeof apply, 'function');
	assert.equal(typeof plugin.default, 'undefined');
	assert.ok(Config);
});

test('plugin: registers exactly the documented tools and one approval hook', () => {
	const { tools, hooks } = register();
	assert.deepEqual([...tools.keys()].sort(), [...plugin.REGISTERED_TOOL_NAMES].sort());
	assert.equal(hooks.length, 1);
});

test('auth: reports the account and quota without leaking the token', async () => {
	const fake = installFakeApi();
	try {
		const { tools } = register();
		const result = await tools.get('github_auth_status').execute({}, execFor('github_auth_status', {}));
		assert.equal(result.valid, true);
		assert.equal(result.login, 'Reduction77');
		assert.equal(result.remaining, 4980);
		assert.ok(!JSON.stringify(result).includes('ghp_test_token'));
	} finally {
		fake.restore();
	}
});

test('auth: reports an actionable hint when no credential is configured', async () => {
	const fake = installFakeApi();
	try {
		const { tools } = register({ token: undefined });
		const result = await tools.get('github_auth_status').execute({}, execFor('github_auth_status', {}));
		assert.equal(result.configured, false, `unexpected status payload: ${JSON.stringify(result)}`);
		assert.equal(result.valid, false);
		assert.equal(result.source, 'none');
		assert.match(result.hint, /设置 → 插件 → 凭据/u);
		// An unconfigured credential must not produce a single request: a status probe
		// that reaches GitHub unauthenticated would report a misleading quota and burn
		// the anonymous rate limit.
		assert.equal(fake.calls.length, 0, 'no request may be attempted without a credential');
	} finally {
		fake.restore();
	}
});

test('push: issues the Git Data sequence and can open a pull request', async () => {
	const fake = installFakeApi({ existingRepo: true });
	const root = await mkdtemp(join(tmpdir(), 'gh-push-'));
	try {
		await writeFile(join(root, 'a.txt'), 'alpha');
		await writeFile(join(root, 'b.txt'), 'beta');
		await writeFile(join(root, 'c.txt'), 'gamma');
		const { tools } = register();
		const result = await tools.get('github_upload_project').execute(
			{ repo: 'demo', branch: 'feature/x', dir: root, createPullRequest: true },
			execFor('github_upload_project', {}),
		);
		assert.equal(result.commitSha, 'new-commit-sha');
		assert.equal(result.createdRepository, false);
		assert.equal(result.files, 3);
		assert.equal(result.pullRequest.number, 7);
		const paths = fake.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
		assert.deepEqual(paths, [
			'GET /repos/Reduction77/demo',
			'GET /repos/Reduction77/demo/git/ref/heads/feature/x',
			'GET /repos/Reduction77/demo/git/ref/heads/main',
			'GET /repos/Reduction77/demo/git/commits/base-commit-sha',
			'POST /repos/Reduction77/demo/git/blobs',
			'POST /repos/Reduction77/demo/git/blobs',
			'POST /repos/Reduction77/demo/git/blobs',
			'POST /repos/Reduction77/demo/git/trees',
			'POST /repos/Reduction77/demo/git/commits',
			'POST /repos/Reduction77/demo/git/refs',
			'POST /repos/Reduction77/demo/pulls',
		]);
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('push: refuses to open a pull request whose head is the default branch', async () => {
	const fake = installFakeApi({ existingRepo: true });
	try {
		const { tools } = register();
		await assert.rejects(
			() => tools.get('github_upload_project').execute(
				{ repo: 'demo', branch: 'main', createPullRequest: true },
				execFor('github_upload_project', {}),
			),
			/无法再以它为 head 开 PR/u,
		);
	} finally {
		fake.restore();
	}
});

test('create repository: creates then applies topics', async () => {
	const fake = installFakeApi();
	try {
		const { tools } = register();
		const result = await tools.get('github_create_repository').execute(
			{ repo: 'demo', description: 'demo repo', topics: ['dsh-plugin', 'github'] },
			execFor('github_create_repository', {}),
		);
		assert.equal(result.url, 'https://github.com/Reduction77/demo');
		assert.deepEqual(result.topics, ['dsh-plugin', 'github']);
		// The create call must go to the personal endpoint for a personal owner.
		assert.ok(
			fake.calls.some((call) => call.method === 'POST' && call.url === 'https://api.github.com/user/repos'),
			'personal repository creation must POST /user/repos',
		);
		assert.ok(
			fake.calls.some((call) => call.method === 'PUT' && call.url.endsWith('/repos/Reduction77/demo/topics')),
			'topics must be applied through the dedicated endpoint',
		);
	} finally {
		fake.restore();
	}
});

test('create repository: refuses to touch an existing repository', async () => {
	const fake = installFakeApi({ existingRepo: true });
	try {
		const { tools } = register();
		await assert.rejects(
			() => tools.get('github_create_repository').execute({ repo: 'demo' }, execFor('github_create_repository', {})),
			/已经存在/u,
		);
	} finally {
		fake.restore();
	}
});

/**
 * Build a throwaway project whose conventions match the maintainer's repositories.
 *
 * @returns {Promise<string>} the project root.
 */
async function makeProject() {
	const root = await mkdtemp(join(tmpdir(), 'gh-rel-'));
	await mkdir(join(root, 'lib'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'napcat-plugin-bili-recognizer', version: '1.6.0' }));
	await writeFile(join(root, 'lib', 'index.mjs'), 'export const x = 1;\n');
	await writeFile(
		join(root, 'CHANGELOG.md'),
		'# 更新日志\n\n## 1.6.0\n\n- 新增自定义通知素材。\n- 修复头像被裁切。\n\n## 1.5.5\n\n- 旧版本。\n',
	);
	return root;
}

test('release: builds the artifact, checks versions, publishes, and streams the asset', async () => {
	const fake = installFakeApi();
	const root = await makeProject();
	try {
		const { tools } = register();
		const args = { repo: 'demo', tag: '1.6.0', dir: root };
		const result = await tools.get('github_release_publish').execute(args, execFor('github_release_publish', args));
		assert.equal(result.tag, 'v1.6.0');
		assert.equal(result.assetName, 'napcat-plugin-bili-recognizer-1.6.0.zip');
		assert.ok(result.assetSize > 0);
		assert.match(result.versionCheck, /通过/u);
		assert.match(result.body, /新增自定义通知素材/u, 'body must carry the changelog section');
		assert.match(result.body, /不要使用 GitHub 自动生成的 Source code/u);
		assert.match(result.builtBy, /builtin-zip/u);

		const calls = fake.calls.map((call) => `${call.method} ${new URL(call.url).host}${new URL(call.url).pathname}`);
		assert.ok(calls.includes('POST uploads.github.com/repos/Reduction77/demo/releases/9001/assets'), 'asset must go to the uploads host');
		assert.equal(calls.at(-1), 'POST uploads.github.com/repos/Reduction77/demo/releases/9001/assets');
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('release: replaces a same-named asset instead of failing', async () => {
	const fake = installFakeApi({ release: {
		id: 9001,
		html_url: 'https://github.com/Reduction77/demo/releases/tag/v1.6.0',
		upload_url: 'https://uploads.github.com/repos/Reduction77/demo/releases/9001/assets{?name,label}',
		assets: [{ id: 5000, name: 'napcat-plugin-bili-recognizer-1.6.0.zip' }],
	} });
	const root = await makeProject();
	try {
		const { tools } = register();
		const args = { repo: 'demo', tag: 'v1.6.0', dir: root };
		const result = await tools.get('github_release_publish').execute(args, execFor('github_release_publish', args));
		assert.equal(result.created, false);
		assert.equal(result.replaced, 'napcat-plugin-bili-recognizer-1.6.0.zip');
		const deleted = fake.calls.filter((call) => call.method === 'DELETE');
		assert.equal(deleted.length, 1);
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('release: refuses a version mismatch and explains every disagreement', async () => {
	const fake = installFakeApi();
	const root = await makeProject();
	try {
		const { tools } = register();
		const args = { repo: 'demo', tag: 'v2.0.0', dir: root, assetName: 'demo_v0.3.0_GitHub_Source.zip' };
		await assert.rejects(
			() => tools.get('github_release_publish').execute(args, execFor('github_release_publish', args)),
			(error) => {
				assert.match(error.message, /版本一致性校验未通过/u);
				assert.match(error.message, /tag 是 `2\.0\.0`，但 package\.json 里是 `1\.6\.0`/u);
				assert.match(error.message, /附件名里的版本是 `0\.3\.0`/u);
				return true;
			},
		);
		assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 0, 'nothing may be written after a failed check');
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('release: forceVersion bypasses the check and says so in the result', async () => {
	const fake = installFakeApi();
	const root = await makeProject();
	try {
		const { tools } = register();
		const args = { repo: 'demo', tag: 'v2.0.0', dir: root, forceVersion: true };
		const result = await tools.get('github_release_publish').execute(args, execFor('github_release_publish', args));
		assert.match(result.versionCheck, /已用 forceVersion 跳过/u);
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('release: prefers the project packaging script when dist is empty', async () => {
	const fake = installFakeApi();
	const root = await makeProject();
	try {
		await writeFile(join(root, 'pack.mjs'), [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"mkdirSync('dist', { recursive: true });",
			"writeFileSync('dist/napcat-plugin-bili-recognizer-1.6.0.zip', 'PK\\u0003\\u0004fake');",
			'',
		].join('\n'));
		await writeFile(join(root, 'package.json'), JSON.stringify({
			name: 'napcat-plugin-bili-recognizer',
			version: '1.6.0',
			scripts: { 'pack:plugin': 'node pack.mjs' },
		}));
		const { tools } = register();
		const args = { repo: 'demo', tag: 'v1.6.0', dir: root };
		const result = await tools.get('github_release_publish').execute(args, execFor('github_release_publish', args));
		assert.equal(result.builtBy, 'node pack.mjs');
		assert.equal(result.assetName, 'napcat-plugin-bili-recognizer-1.6.0.zip');
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('release: reports a packaging script that produces the wrong file name', async () => {
	const fake = installFakeApi();
	const root = await makeProject();
	try {
		await writeFile(join(root, 'pack.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/wrong-name.zip', 'x');\n");
		await writeFile(join(root, 'package.json'), JSON.stringify({
			name: 'napcat-plugin-bili-recognizer',
			version: '1.6.0',
			scripts: { 'pack:plugin': 'node pack.mjs' },
		}));
		const { tools } = register();
		const args = { repo: 'demo', tag: 'v1.6.0', dir: root };
		await assert.rejects(
			() => tools.get('github_release_publish').execute(args, execFor('github_release_publish', args)),
			/没有生成预期的 `dist\/napcat-plugin-bili-recognizer-1\.6\.0\.zip`/u,
		);
	} finally {
		fake.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test('get release: reports assets with sizes and download counts', async () => {
	const fake = installFakeApi({ release: {
		id: 9001,
		tag_name: 'v1.6.0',
		name: 'v1.6.0',
		html_url: 'https://github.com/Reduction77/demo/releases/tag/v1.6.0',
		draft: false,
		prerelease: false,
		published_at: '2026-09-15T00:00:00Z',
		body: 'notes',
		assets: [{ id: 1, name: 'a.zip', size: 429596, download_count: 3 }],
	} });
	try {
		const { tools } = register();
		const result = await tools.get('github_get_release').execute({ repo: 'demo', tag: 'v1.6.0' }, execFor('github_get_release', {}));
		assert.equal(result.tag, 'v1.6.0');
		assert.deepEqual(result.assets, [{ name: 'a.zip', size: 429596, downloads: 3 }]);
	} finally {
		fake.restore();
	}
});

test('approval: additive operations run without asking', async () => {
	const { hooks } = register();
	const hook = hooks[0];
	for (const [toolName, args] of [
		['github_create_repository', { repo: 'demo', visibility: 'public' }],
		['github_push_files', { repo: 'demo', files: [{ path: 'a.txt', content: 'x' }] }],
		['github_upload_project', { repo: 'demo' }],
		['github_release_publish', { repo: 'demo', tag: 'v1.0.0' }],
	]) {
		let delegated = false;
		const decision = await hook({ name: toolName, arguments: args }, () => {
			delegated = true;
			return Promise.resolve({ kind: 'allow' });
		});
		assert.equal(delegated, true, `${toolName} must delegate to the next listener`);
		assert.equal(decision.kind, 'allow');
	}
});

test('approval: destructive operations ask and never delegate', async () => {
	const { hooks } = register();
	const hook = hooks[0];
	for (const [toolName, args, reason] of [
		['github_push_files', { repo: 'demo', force: true, files: [] }, /force push 会覆盖/u],
		['github_upload_project', { repo: 'demo', force: true }, /force push 会覆盖/u],
		['github_release_publish', { repo: 'demo', tag: 'v1.0.0', deleteExistingTag: true }, /删除并重建 tag/u],
	]) {
		let delegated = false;
		const decision = await hook({ name: toolName, arguments: args }, () => {
			delegated = true;
			return Promise.resolve({ kind: 'allow' });
		});
		assert.equal(delegated, false, `${toolName} must not reach the next listener`);
		assert.equal(decision.kind, 'ask');
		assert.match(decision.reason, reason);
	}
});

test('approval: foreign tools are untouched', async () => {
	const { hooks } = register();
	let delegated = false;
	await hooks[0]({ name: 'bash', arguments: { command: 'rm -rf /' } }, () => {
		delegated = true;
		return Promise.resolve({ kind: 'allow' });
	});
	assert.equal(delegated, true);
});
