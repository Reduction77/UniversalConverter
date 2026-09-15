#!/usr/bin/env node
/**
 * Preflight verification for this plugin.
 *
 * Two things are checked, and both are the kind that otherwise fail silently at boot
 * or, worse, at tool-call time:
 *
 * 1. **Loader contract.** The module must export `name`, `inject`, `Config` and `apply`,
 *    and `apply` must register the expected tools and the approval hook. A typo here
 *    produces "the tool is not in my tool list", which is hard to trace back.
 * 2. **Schema compilation.** Every tool's parameter and output schema is re-compiled by
 *    the harness's own compiler. The output schema DSL is a strict subset of JSON Schema,
 *    so an unsupported keyword is rejected at compile time rather than at runtime.
 *
 * Peer dependencies are linked from the harness checkout first, because a plugin sits in
 * its own directory during development and Node's resolution walk never reaches the
 * harness's private `node_modules`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const peerNames = ['cordis', 'dsh-credentials', 'dsh-tools', 'schemastery', 'dsh-agent', 'dsh-llm', 'dsh-invariants', 'dsh-session', 'dsh-util-values', 'dsh-user-approval'];

/**
 * Locate the installed harness checkout that owns the `dsh` binary.
 *
 * @returns {string | undefined} the checkout root, or `undefined` when `dsh` is not on PATH.
 */
function findCheckout() {
	if (process.env.DSH_CHECKOUT !== undefined && existsSync(process.env.DSH_CHECKOUT)) return process.env.DSH_CHECKOUT;
	try {
		const binary = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
		if (binary.length === 0) return undefined;
		// `dsh` is normally a symlink into the checkout, so the real path is what matters;
		// resolving the link's own directory would land on `/usr/local/bin/..`.
		const real = realpathSync(binary);
		const candidate = resolve(real, '..', '..');
		return existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-tools')) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Symlink the harness's own packages into this directory's `node_modules`.
 *
 * Links are rewritten rather than skipped so a moved checkout does not leave a dangling
 * link that resolves to a stale harness.
 *
 * @param {string} checkout - harness checkout root.
 * @returns {Promise<{ linked: number, skipped: number }>} link counts.
 */
async function linkPeers(checkout) {
	const source = join(checkout, 'node_modules', '@deepseek-ai');
	const target = join(root, 'node_modules', '@deepseek-ai');
	await mkdir(target, { recursive: true });
	let linked = 0;
	let skipped = 0;
	for (const peer of peerNames) {
		const from = join(source, peer);
		if (!existsSync(from)) {
			skipped++;
			continue;
		}
		const to = join(target, peer);
		const current = await readlink(to).catch(() => undefined);
		if (current === from) {
			skipped++;
			continue;
		}
		await rm(to, { force: true, recursive: true });
		await symlink(from, to, 'dir');
		linked++;
	}
	return { linked, skipped };
}

const checkout = findCheckout();
if (checkout === undefined) {
	console.log('⚠ 找不到 dsh checkout（DSH_CHECKOUT 未设置且 `which dsh` 失败）。跳过依赖链接；若随后报 ERR_MODULE_NOT_FOUND，请设置 DSH_CHECKOUT。');
} else {
	const { linked, skipped } = await linkPeers(checkout);
	console.log(`• harness checkout: ${checkout}`);
	console.log(`• peer links: ${linked} 新建, ${skipped} 已就绪`);
}

const failures = [];

let plugin;
try {
	plugin = await import(join(root, 'index.js'));
} catch (error) {
	console.error(`✖ 无法加载 index.js：${error.message}`);
	process.exit(1);
}

for (const key of ['name', 'inject', 'Config', 'apply']) {
	if (plugin[key] === undefined) failures.push(`缺少导出 \`${key}\``);
}
console.log(`• name: ${plugin.name}`);
console.log(`• inject: ${JSON.stringify(plugin.inject)}`);

/** Tools registered by a fake context, so `apply` can be exercised without a harness. */
const registered = new Map();
/** Approval hooks registered by a fake context. */
const hooks = [];
const ctx = {
	tools: {
		register(definition) {
			registered.set(definition.name, definition);
			return () => registered.delete(definition.name);
		},
	},
	credentials: {
		resolve: async () => undefined,
		describe: async () => ({ configured: false, writable: false }),
	},
	on(event, listener) {
		if (event === 'tools/pre-execute') hooks.push(listener);
	},
	logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

try {
	await plugin.apply(ctx, {
		tokenRef: 'GITHUB_TOKEN',
		apiBase: 'https://api.github.com',
		timeoutMs: 30000,
		uploadTimeoutMs: 600000,
		defaultOwner: '',
		packTimeoutMs: 180000,
		statusFile: '',
	});
} catch (error) {
	console.error(`✖ apply() 抛异常：${error.message}`);
	process.exit(1);
}

const expected = plugin.REGISTERED_TOOL_NAMES;
if (!Array.isArray(expected) || expected.length === 0) failures.push('REGISTERED_TOOL_NAMES 未导出或为空');
for (const name of expected ?? []) {
	if (!registered.has(name)) failures.push(`未注册工具 \`${name}\``);
}
for (const name of registered.keys()) {
	if (!expected.includes(name)) failures.push(`注册了计划外的工具 \`${name}\``);
}
if (hooks.length !== 1) failures.push(`审批钩子数量应为 1，实际 ${hooks.length}`);

// Validate the compiled schemas the way the registry does. `apply` already ran every
// author schema through the harness compiler — an unsupported keyword would have thrown
// there — so what remains worth checking is that the compiled wire schemas are in the
// enforced subset and that the argument root is an object.
const { assertSupportedJsonSchema, assertObjectJsonSchema } = await import('@deepseek-ai/dsh-tools');
for (const [name, definition] of registered) {
	try {
		assertObjectJsonSchema(definition.parameters);
		const argumentNames = Object.keys(definition.parameters.properties ?? {});
		const requiredNames = definition.parameters.required ?? [];
		for (const required of requiredNames) {
			if (!argumentNames.includes(required)) throw new Error(`required 里的 \`${required}\` 不在 properties 中`);
		}
		assertSupportedJsonSchema(definition.output.schema);
		if (typeof definition.output.render !== 'function') throw new Error('output.render 不是函数');
		console.log(`  ✓ ${name} — ${argumentNames.length} 个参数（必填 ${requiredNames.length}），输出 schema 合法`);
	} catch (error) {
		failures.push(`${name} 的 schema 校验失败：${error.message}`);
	}
}

if (failures.length > 0) {
	console.error('\n✖ preflight 未通过：');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`\n✓ preflight 通过：${registered.size} 个工具，schema 全部编译成功，审批钩子已注册。`);
