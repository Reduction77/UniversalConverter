/**
 * dsh-github-ops — GitHub repository and release operations for DeepSeek Harness.
 *
 * Scope: create repositories, push files, open pull requests, and publish releases with
 * binaries attached. Authentication is a DSH credential reference, never a literal
 * secret in configuration, so the value is resolved per operation and a rotation takes
 * effect without a restart.
 *
 * Everything goes through REST API v3 rather than the local `git` binary. That is a
 * deliberate trade: `git push` would need a credential helper, an interactive prompt, or
 * a token embedded in a remote URL, and a non-interactive harness has none of those —
 * while the Git Data API expresses the same commit without any of them.
 *
 * @module dsh-github-ops
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { createClient, describeToken, GitHubApiError, resolveToken } from './lib/gh-http.js';
import { buildArchive, collectEntries } from './lib/gh-zip.js';
import {
	checkVersionConsistency,
	composeBody,
	defaultAssetName,
	extractChangelogSection,
	normalizeVersion,
	readManifest,
	toTag,
} from './lib/gh-release.js';
import { decide } from './lib/gh-approval.js';

/** Plugin name, as the loader registers it. */
const name = 'dsh-github-ops';

/** Services this plugin consumes. `credentials` supplies the token; `tools` receives the tools. */
const inject = ['tools', 'credentials'];

/** Deployment configuration. */
const Config = z.object({
	tokenRef: z.string().default('GITHUB_TOKEN').description('凭据引用名，默认 GITHUB_TOKEN'),
	apiBase: z.string().default('https://api.github.com').description('REST API 基地址，GitHub Enterprise 需改'),
	timeoutMs: z.number().default(30000).description('普通请求超时（毫秒）'),
	uploadTimeoutMs: z.number().default(600000).description('附件上传超时（毫秒），大文件需放宽'),
	defaultOwner: z.string().default('').description('省略 owner 时使用的账号，留空则取当前认证用户'),
	packTimeoutMs: z.number().default(180000).description('打包脚本超时（毫秒）'),
	statusFile: z.string().default('').description('启动时写入一张状态卡片（工具清单、apiBase）的路径，留空则不写'),
});

/** Directories never walked when collecting a project for upload or packaging. */
const EXCLUDED_DIRECTORIES = [
	'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.turbo',
	'config', 'data', 'downloads', 'logs', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
];

/** Every tool this plugin registers, in load order, for the startup record and preflight. */
const REGISTERED_TOOL_NAMES = [
	'github_auth_status',
	'github_create_repository',
	'github_push_files',
	'github_upload_project',
	'github_release_publish',
	'github_get_release',
];

/** Extensions eligible for packaging, mirroring a plugin installer's contents. */
const PACKAGE_EXTENSIONS = [
	'.mjs', '.cjs', '.js', '.ts', '.css', '.html', '.md', '.json', '.txt',
	'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.yml', '.yaml', '.py', '.sh',
];

/** Root-level files a package always tries to include, when present. */
const PACKAGE_ROOT_FILES = [
	'package.json', 'index.mjs', 'index.js', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
];

/** Root-level directories a package always tries to include, when present. */
const PACKAGE_ROOT_DIRECTORIES = ['lib', 'src', 'webui', 'assets', 'docs', 'tools', 'scripts'];

/**
 * Render a structured result as model-facing text.
 *
 * @param {unknown} value - the tool's canonical value.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
function asText(value) {
	return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * Assert that an `owner`/`repo` pair is present and syntactically usable.
 *
 * @param {string | undefined} owner - repository owner.
 * @param {string | undefined} repo - repository name.
 * @returns {{ owner: string, repo: string }} the validated pair.
 */
function requireRepo(owner, repo) {
	if (owner === undefined || owner.trim().length === 0) throw new Error('缺少 owner（GitHub 用户名或组织名）');
	if (repo === undefined || repo.trim().length === 0) throw new Error('缺少 repo（仓库名）');
	return { owner: owner.trim(), repo: repo.trim() };
}

/**
 * Run a packaging command and wait for it.
 *
 * Shell-free: the command is split on whitespace and spawned directly, so a project's
 * script string cannot smuggle a shell metacharacter into execution.
 *
 * @param {object} options - execution inputs.
 * @param {string} options.command - command line from `package.json` scripts.
 * @param {string} options.cwd - project root.
 * @param {number} options.timeoutMs - budget.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 */
function runCommand({ command, cwd, timeoutMs, signal }) {
	const [program, ...args] = command.trim().split(/\s+/u);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(program, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			rejectPromise(new Error(`打包命令超时（${timeoutMs}ms）：${command}`));
		}, timeoutMs);
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => {
			clearTimeout(timer);
			rejectPromise(new Error(`无法执行打包命令 \`${command}\`：${error.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
			else rejectPromise(new Error(`打包命令退出码 ${code}：${command}\n${stderr.trim() || stdout.trim()}`));
		});
	});
}

/**
 * Locate a release artifact, building it from source when it is absent.
 *
 * Resolution order: an explicit path, then the conventional `dist/<name>-<version>.zip`,
 * then a project-defined packaging script, then a built-in ZIP of the project's
 * publishable files. The last fallback exists so a repository without any packaging
 * script can still cut a release.
 *
 * @param {object} options - resolution inputs.
 * @param {string} options.root - project root.
 * @param {string} options.owner - repository owner, for error text.
 * @param {string} options.repo - repository name.
 * @param {string} options.tag - release tag.
 * @param {string} [options.assetPath] - explicit local path.
 * @param {boolean} options.build - whether building is permitted.
 * @param {number} options.packTimeoutMs - packaging budget.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{ path: string, name: string, size: number, built: string | undefined }>} the resolved artifact.
 */
async function resolveArtifact({ root, owner, repo, tag, assetPath, build, packTimeoutMs, signal }) {
	const version = normalizeVersion(tag);
	const manifest = await readManifest(root);
	const expectedName = manifest?.name !== undefined && version !== undefined
		? defaultAssetName({ packageName: manifest.name, version })
		: undefined;

	/**
	 * Describe one existing file as a resolved artifact.
	 * @param {string} path - artifact path.
	 * @returns {Promise<{ path: string, name: string, size: number, built: undefined }>} the artifact.
	 */
	const describeFile = async (path) => {
		const info = await stat(path);
		return { path, name: basename(path), size: info.size, built: undefined };
	};

	if (assetPath !== undefined && assetPath.trim().length > 0) {
		const path = isAbsolute(assetPath) ? assetPath : resolve(root, assetPath);
		try {
			return await describeFile(path);
		} catch {
			throw new Error(`指定的附件路径不存在或不可读：${path}`);
		}
	}

	if (expectedName !== undefined) {
		const conventional = join(root, 'dist', expectedName);
		try {
			return await describeFile(conventional);
		} catch {
			// Not built yet; fall through to the build paths.
		}
	}

	if (!build) {
		throw new Error(
			`没找到 ${expectedName === undefined ? '附件' : `\`dist/${expectedName}\``}，且 buildAsset 为 false。`
			+ '请先运行项目的打包脚本，或指定 assetPath，或把 buildAsset 设为 true 让本工具代打包。',
		);
	}

	const packScript = manifest?.scripts?.['pack:plugin'] ?? manifest?.scripts?.['package'];
	if (typeof packScript === 'string' && packScript.trim().length > 0) {
		await runCommand({ command: packScript, cwd: root, timeoutMs: packTimeoutMs, signal });
		if (expectedName !== undefined) {
			const built = join(root, 'dist', expectedName);
			try {
				const artifact = await describeFile(built);
				return { ...artifact, built: packScript };
			} catch {
				// The script ran but did not produce the conventional name; report both facts.
				throw new Error(
					`打包脚本 \`${packScript}\` 执行成功，但没有生成预期的 \`dist/${expectedName}\`。`
					+ '请检查脚本的输出文件名，或用 assetPath 明确指定。',
				);
			}
		}
	}

	if (manifest?.name === undefined || version === undefined) {
		throw new Error(
			`无法代打包：${root} 下没有可用的 package.json（name/version），也找不到打包脚本。`
			+ `请先用项目自己的方式生成 ${owner}/${repo} 的 ${tag} 附件，再用 assetPath 指给我。`,
		);
	}

	const entries = await collectEntries({
		root,
		files: PACKAGE_ROOT_FILES,
		directories: PACKAGE_ROOT_DIRECTORIES,
		extensions: PACKAGE_EXTENSIONS,
		excludedDirectories: EXCLUDED_DIRECTORIES,
	});
	if (entries.length === 0) throw new Error(`没有可打包的文件：${root}`);
	const archive = buildArchive({ entries });
	const targetName = defaultAssetName({ packageName: manifest.name, version });
	const outputDir = join(root, 'dist');
	await mkdir(outputDir, { recursive: true });
	await writeFile(join(outputDir, targetName), archive);
	const artifact = await describeFile(join(outputDir, targetName));
	return { ...artifact, built: `builtin-zip(${entries.length} files)` };
}

/**
 * Register the GitHub tools on the harness.
 *
 * Async only because the optional startup marker performs a disk write; the tool
 * registrations themselves are synchronous, so a failure in the marker cannot leave the
 * registry half-populated.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {z.infer<typeof Config>} config - deployment configuration.
 * @returns {Promise<void>} fulfillment after the optional marker write settles.
 */
async function apply(ctx, config) {
	const client = createClient({
		ctx,
		tokenRef: config.tokenRef,
		apiBase: config.apiBase,
		timeoutMs: config.timeoutMs,
		uploadTimeoutMs: config.uploadTimeoutMs,
	});

	/**
	 * Resolve the effective owner for a call.
	 *
	 * @param {string | undefined} owner - requested owner.
	 * @returns {Promise<string>} the owner to operate on.
	 */
	const resolveOwner = async (owner) => {
		if (owner !== undefined && owner.trim().length > 0) return owner.trim();
		if (config.defaultOwner.trim().length > 0) return config.defaultOwner.trim();
		const { body } = await client.request('GET', '/user');
		const login = /** @type {{ login?: string }} */ (body).login;
		if (typeof login !== 'string') throw new Error('无法确定当前 GitHub 用户，请显式传 owner');
		return login;
	};

	/**
	 * Fetch one repository, returning `undefined` instead of throwing on 404.
	 *
	 * @param {string} owner - repository owner.
	 * @param {string} repo - repository name.
	 * @returns {Promise<Record<string, unknown> | undefined>} the repository payload.
	 */
	const getRepo = async (owner, repo) => {
		try {
			const { body } = await client.request('GET', `/repos/${owner}/${repo}`);
			return /** @type {Record<string, unknown>} */ (body);
		} catch (error) {
			if (error instanceof GitHubApiError && error.status === 404) return undefined;
			throw error;
		}
	};

	/**
	 * Commit a set of files to one branch through the Git Data API.
	 *
	 * The five-step sequence is `ref → commit → tree → new commit → update ref`. It is
	 * used instead of the Contents API because Contents needs one request per file and
	 * silently commits to the default branch when a branch is omitted.
	 *
	 * @param {object} options - push inputs.
	 * @param {string} options.owner - repository owner.
	 * @param {string} options.repo - repository name.
	 * @param {string} options.branch - target branch.
	 * @param {string} options.message - commit message.
	 * @param {Array<{ path: string, content?: string, localPath?: string, encoding?: string }>} options.files - files to write.
	 * @param {boolean} options.force - whether the ref update may discard the old head.
	 * @param {string} [options.baseBranch] - branch to seed from when `branch` does not exist.
	 * @param {Record<string, unknown>} [options.repository] - an already-fetched repository payload, so a caller that needed it anyway does not pay for a second round trip.
	 * @param {AbortSignal} options.signal - caller cancellation.
	 * @returns {Promise<Record<string, unknown>>} the push result.
	 */
	const pushFiles = async ({ owner, repo, branch, message, files, force, baseBranch, repository, signal }) => {
		const resolvedRepository = repository ?? await getRepo(owner, repo);
		if (resolvedRepository === undefined) {
			throw new Error(`仓库 ${owner}/${repo} 不存在或当前凭据无权访问（私有库需要 \`repo\` 权限的 token）`);
		}
		const repoInfo = {
			defaultBranch: typeof resolvedRepository.default_branch === 'string' ? resolvedRepository.default_branch : 'main',
			private: resolvedRepository.private === true,
			htmlUrl: typeof resolvedRepository.html_url === 'string' ? resolvedRepository.html_url : undefined,
		};

		/** @type {{ sha: string } | undefined} */
		let headRef;
		try {
			const { body } = await client.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
			headRef = /** @type {{ object: { sha: string } }} */ (body).object;
		} catch (error) {
			if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
		}

		/** @type {string | undefined} */
		let baseCommitSha = headRef?.sha;
		if (baseCommitSha === undefined) {
			const seed = baseBranch ?? repoInfo.defaultBranch;
			const { body } = await client.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${seed}`);
			baseCommitSha = /** @type {{ object: { sha: string } }} */ (body).object.sha;
		}

		const { body: baseCommit } = await client.request('GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
		const baseTreeSha = /** @type {{ tree: { sha: string } }} */ (baseCommit).tree.sha;

		/** @type {Array<{ path: string, mode: string, type: string, sha: string }>} */
		const treeEntries = [];
		for (const file of files) {
			if (file.path.trim().length === 0) throw new Error('files[].path 不能为空');
			/** @type {Buffer} */
			let buffer;
			if (typeof file.localPath === 'string' && file.localPath.length > 0) {
				const path = isAbsolute(file.localPath) ? file.localPath : resolve(process.cwd(), file.localPath);
				try {
					buffer = await readFile(path);
				} catch (error) {
					throw new Error(`读取本地文件失败 ${path}：${error instanceof Error ? error.message : String(error)}`);
				}
			} else if (typeof file.content === 'string') {
				buffer = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
			} else {
				throw new Error(`files[] 里 ${file.path} 既没有 content 也没有 localPath`);
			}
			const { body: blob } = await client.request('POST', `/repos/${owner}/${repo}/git/blobs`, {
				body: { content: buffer.toString('base64'), encoding: 'base64' },
				signal,
			});
			treeEntries.push({
				path: file.path.replace(/^\/+/u, ''),
				mode: '100644',
				type: 'blob',
				sha: /** @type {{ sha: string }} */ (blob).sha,
			});
		}

		const { body: tree } = await client.request('POST', `/repos/${owner}/${repo}/git/trees`, {
			body: { base_tree: baseTreeSha, tree: treeEntries },
			signal,
		});
		const { body: commit } = await client.request('POST', `/repos/${owner}/${repo}/git/commits`, {
			body: { message, tree: /** @type {{ sha: string }} */ (tree).sha, parents: [baseCommitSha] },
			signal,
		});
		const commitSha = /** @type {{ sha: string }} */ (commit).sha;

		if (headRef === undefined) {
			try {
				await client.request('POST', `/repos/${owner}/${repo}/git/refs`, {
					body: { ref: `refs/heads/${branch}`, sha: commitSha },
					signal,
				});
			} catch (error) {
				// A race with another creator surfaces as 422; retry as an update.
				if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
				await client.request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
					body: { sha: commitSha, force },
					signal,
				});
			}
		} else {
			await client.request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
				body: { sha: commitSha, force },
				signal,
			});
		}

		return {
			owner,
			repo,
			branch,
			commitSha,
			files: treeEntries.length,
			paths: treeEntries.map((entry) => entry.path),
			commitUrl: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
			private: repoInfo.private,
		};
	};

	ctx.tools.register(defineTool({
		name: 'github_auth_status',
		description:
			'Report whether the GitHub credential is usable, which account it belongs to, and the remaining API quota. '
			+ 'Never returns the token itself — only its reference name, source layer, and validity. '
			+ 'Call this first when a GitHub operation fails with an authentication error.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ref: { type: 'string', required: true, description: '凭据引用名' },
					configured: { type: 'boolean', required: true, description: '是否解析到值' },
					source: { type: 'string', required: true, description: '值来自哪一层' },
					valid: { type: 'boolean', required: true, description: 'token 是否被 GitHub 接受' },
					login: { type: 'string', description: '认证账号' },
					scopes: { type: 'string', description: 'token 的 scope 列表' },
					remaining: { type: 'integer', description: '剩余 API 配额' },
					limit: { type: 'integer', description: '配额上限' },
					hint: { type: 'string', description: '不可用时的修复建议' },
				},
			},
			render: (_args, value) => asText(value),
		},
		async execute(_args, exec) {
			const description = await describeToken({ ctx, tokenRef: config.tokenRef });
			if (!description.configured) {
				return {
					ref: config.tokenRef,
					configured: false,
					source: 'none',
					valid: false,
					hint: '在 DSH 的 设置 → 插件 → 凭据 中新增一条，键名 GITHUB_TOKEN，值填你的 Personal Access Token（至少勾选 repo；要改 .github/workflows 需再加 workflow）。',
				};
			}
			try {
				const { body } = await client.request('GET', '/user', { signal: exec.signal });
				const { body: rate } = await client.request('GET', '/rate_limit', { signal: exec.signal });
				const user = /** @type { Record<string, unknown> } */ (body);
				const limits = /** @type {{ resources?: { core?: { remaining?: number, limit?: number } } }} */ (rate);
				return {
					ref: config.tokenRef,
					configured: true,
					source: description.source ?? 'unknown',
					valid: true,
					login: typeof user.login === 'string' ? user.login : undefined,
					remaining: limits.resources?.core?.remaining,
					limit: limits.resources?.core?.limit,
				};
			} catch (error) {
				return {
					ref: config.tokenRef,
					configured: true,
					source: description.source ?? 'unknown',
					valid: false,
					hint: error instanceof Error ? error.message : String(error),
				};
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Check GitHub credential', kind: 'other' }),
	}));

	ctx.tools.register(defineTool({
		name: 'github_create_repository',
		description:
			'Create a GitHub repository. By default it is created empty (no auto README, so the first push is not a '
			+ 'non-fast-forward conflict against an unrelated initial commit). Optional topics are applied after creation, '
			+ 'because the create endpoint cannot set them.',
		parameters: {
			repo: { type: 'string', required: true, description: '仓库名，例如 my-tool' },
			owner: { type: 'string', description: '用户名或组织名，省略则用当前认证账号' },
			description: { type: 'string', description: '仓库简介' },
			visibility: { type: 'string', enum: ['public', 'private'], description: '可见性，默认 public' },
			topics: { type: 'array', items: { type: 'string' }, description: '仓库话题，例如 ["dsh-plugin","github"]' },
			initReadme: { type: 'boolean', description: '是否让 GitHub 自动建初始 README，默认 false' },
			homepage: { type: 'string', description: '仓库主页 URL' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					owner: { type: 'string', required: true },
					repo: { type: 'string', required: true },
					url: { type: 'string', required: true },
					private: { type: 'boolean', required: true },
					defaultBranch: { type: 'string', required: true },
					topics: { type: 'array', items: { type: 'string' }, description: '实际生效的话题' },
				},
			},
			render: (_args, value) => asText(value),
		},
		async execute(args, exec) {
			const owner = await resolveOwner(args.owner);
			const existing = await getRepo(owner, args.repo);
			if (existing !== undefined) {
				throw new Error(`仓库 ${owner}/${args.repo} 已经存在（${String(existing.html_url)}），未做任何改动`);
			}
			// Personal repositories live under `/user/repos` and organizations under
			// `/orgs/{org}/repos`; using the wrong one returns 404 for an owner the token
			// can otherwise write to.
			const authenticated = await resolveOwner(undefined);
			const path = owner === authenticated ? '/user/repos' : `/orgs/${owner}/repos`;
			const payload = {
				name: args.repo,
				description: args.description,
				private: args.visibility === 'private',
				has_issues: true,
				has_wiki: false,
				has_projects: false,
				auto_init: args.initReadme === true,
				homepage: args.homepage,
			};
			const { body } = await client.request('POST', path, { body: payload, signal: exec.signal });
			const created = /** @type { Record<string, unknown> } */ (body);
			/** @type {string[] | undefined} */
			let topics;
			if (Array.isArray(args.topics) && args.topics.length > 0) {
				const names = args.topics.filter((topic) => typeof topic === 'string' && topic.trim().length > 0);
				await client.request('PUT', `/repos/${owner}/${args.repo}/topics`, {
					body: { names },
					signal: exec.signal,
				});
				topics = names;
			}
			return {
				owner,
				repo: args.repo,
				url: String(created.html_url),
				private: created.private === true,
				defaultBranch: typeof created.default_branch === 'string' ? created.default_branch : 'main',
				topics,
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Create ${args.owner ?? ''}/${args.repo}`.trim(), kind: 'other' }),
	}));

	ctx.tools.register(defineTool({
		name: 'github_push_files',
		description:
			'Commit files to a GitHub branch in a single commit, creating the branch when it does not exist. '
			+ 'Each file is either inline `content`, or `localPath` pointing at a file on disk. '
			+ 'Works on an empty repository and on an existing branch. Set `force` only to overwrite remote history '
			+ '(requires approval, and the discarded commits are unrecoverable from GitHub).',
		parameters: {
			repo: { type: 'string', required: true, description: '仓库名' },
			owner: { type: 'string', description: '用户名或组织名，省略则用当前认证账号' },
			branch: { type: 'string', description: '目标分支，默认 main' },
			message: { type: 'string', description: '提交信息，默认 Update files' },
			files: {
				type: 'array',
				required: true,
				description: '要写入的文件列表',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						path: { type: 'string', required: true, description: '仓库内相对路径' },
						content: { type: 'string', description: '文件内容（文本，或 encoding=base64 时的 base64）' },
						localPath: { type: 'string', description: '本地文件路径，与 content 二选一' },
						encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'content 的编码，默认 utf8' },
					},
				},
			},
			force: { type: 'boolean', description: '允许覆盖远端历史（危险，需审批）' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					owner: { type: 'string', required: true },
					repo: { type: 'string', required: true },
					branch: { type: 'string', required: true },
					commitSha: { type: 'string', required: true },
					files: { type: 'integer', required: true },
					paths: { type: 'array', items: { type: 'string' } },
					commitUrl: { type: 'string', required: true },
					private: { type: 'boolean', required: true },
				},
			},
			render: (_args, value) => asText(value),
		},
		async execute(args, exec) {
			const owner = await resolveOwner(args.owner);
			return pushFiles({
				owner,
				repo: args.repo,
				branch: typeof args.branch === 'string' && args.branch.length > 0 ? args.branch : 'main',
				message: typeof args.message === 'string' && args.message.length > 0 ? args.message : 'Update files',
				files: args.files,
				force: args.force === true,
				signal: exec.signal,
			});
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `Push ${args.files?.length ?? 0} file(s) to ${args.repo}`,
			kind: 'other',
		}),
	}));

	ctx.tools.register(defineTool({
		name: 'github_upload_project',
		description:
			'Upload a local project directory to GitHub in one call: optionally create the repository, commit the whole '
			+ 'tree, and optionally open a pull request from the pushed branch. Binary files are sent as blobs, so images '
			+ 'and executables survive intact. Build output, dependencies, and local configuration directories are excluded.',
		parameters: {
			repo: { type: 'string', required: true, description: '仓库名' },
			dir: { type: 'string', description: '本地项目目录，默认当前工作目录' },
			owner: { type: 'string', description: '用户名或组织名，省略则用当前认证账号' },
			description: { type: 'string', description: '仓库简介（仅在需要建仓时使用）' },
			visibility: { type: 'string', enum: ['public', 'private'], description: '建仓可见性，默认 public' },
			branch: { type: 'string', description: '目标分支，默认 main' },
			message: { type: 'string', description: '提交信息' },
			createIfMissing: { type: 'boolean', description: '仓库不存在时自动创建，默认 true' },
			createPullRequest: { type: 'boolean', description: '推送后开一个 PR，默认 false' },
			force: { type: 'boolean', description: '允许覆盖远端历史（危险，需审批）' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					owner: { type: 'string', required: true },
					repo: { type: 'string', required: true },
					branch: { type: 'string', required: true },
					commitSha: { type: 'string', required: true },
					files: { type: 'integer', required: true },
					createdRepository: { type: 'boolean', required: true },
					commitUrl: { type: 'string', required: true },
					repoUrl: { type: 'string' },
					pullRequest: {
						type: 'object',
						additionalProperties: false,
						properties: {
							number: { type: 'integer' },
							url: { type: 'string' },
						},
					},
					skipped: { type: 'array', items: { type: 'string' }, description: '被排除的目录名' },
				},
			},
			render: (_args, value) => asText(value),
		},
		async execute(args, exec) {
			const owner = await resolveOwner(args.owner);
			const root = resolve(args.dir ?? process.cwd());
			const info = await stat(root).catch(() => undefined);
			if (info === undefined || !info.isDirectory()) throw new Error(`不是可读目录：${root}`);

			let createdRepository = false;
			let repository = await getRepo(owner, args.repo);
			if (repository === undefined) {
				if (args.createIfMissing === false) throw new Error(`仓库 ${owner}/${args.repo} 不存在，且 createIfMissing 为 false`);
				const { body } = await client.request('POST', '/user/repos', {
					body: {
						name: args.repo,
						description: args.description,
						private: args.visibility === 'private',
						auto_init: false,
					},
					signal: exec.signal,
				});
				repository = /** @type { Record<string, unknown> } */ (body);
				createdRepository = true;
			}

			const entries = await collectEntries({
				root,
				files: [],
				directories: ['.'],
				extensions: PACKAGE_EXTENSIONS,
				excludedDirectories: EXCLUDED_DIRECTORIES,
			});
			if (entries.length === 0) throw new Error(`${root} 下没有可上传的文件`);
			const branch = typeof args.branch === 'string' && args.branch.length > 0 ? args.branch : 'main';
			const pushed = await pushFiles({
				owner,
				repo: args.repo,
				branch,
				message: typeof args.message === 'string' && args.message.length > 0
					? args.message
					: `Upload ${basename(root)}`,
				files: entries.map((entry) => ({ path: entry.stored.split(sep).join('/'), localPath: entry.absolute })),
				force: args.force === true,
				repository,
				signal: exec.signal,
			});

			/** @type {{ number: number, url: string } | undefined} */
			let pullRequest;
			if (args.createPullRequest === true) {
				const defaultBranch = typeof repository.default_branch === 'string' ? repository.default_branch : 'main';
				if (branch === defaultBranch) {
					throw new Error(`已推送到默认分支 ${defaultBranch}，无法再以它为 head 开 PR。请改用别的分支并设 createPullRequest。`);
				}
				const { body } = await client.request('POST', `/repos/${owner}/${args.repo}/pulls`, {
					body: {
						title: args.message ?? `Upload ${basename(root)}`,
						head: branch,
						base: defaultBranch,
						body: `自动上传自本地目录 \`${root}\`，共 ${entries.length} 个文件。`,
					},
					signal: exec.signal,
				});
				const pr = /** @type { Record<string, unknown> } */ (body);
				pullRequest = { number: Number(pr.number), url: String(pr.html_url) };
			}

			return {
				owner,
				repo: args.repo,
				branch,
				commitSha: String(pushed.commitSha),
				files: entries.length,
				createdRepository,
				commitUrl: String(pushed.commitUrl),
				repoUrl: typeof repository.html_url === 'string' ? repository.html_url : undefined,
				pullRequest,
				skipped: EXCLUDED_DIRECTORIES,
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Upload project to ${args.repo}`, kind: 'other' }),
	}));

	ctx.tools.register(defineTool({
		name: 'github_release_publish',
		description:
			'Publish a GitHub release with a binary attached. Resolves the artifact from source when needed: an explicit '
			+ 'path, else the conventional `dist/<package-name>-<version>.zip`, else the project\'s own packaging script, '
			+ 'else a built-in ZIP of the publishable files. Verifies that the tag, the package.json version, and the '
			+ 'artifact name agree before publishing, because a mismatch produces a release whose download is silently '
			+ 'mislabelled. The release body defaults to the matching CHANGELOG section plus install steps.',
		parameters: {
			tag: { type: 'string', required: true, description: 'tag，例如 v1.6.0（自动补 v 前缀）' },
			repo: { type: 'string', required: true, description: '仓库名' },
			owner: { type: 'string', description: '用户名或组织名，省略则用当前认证账号' },
			dir: { type: 'string', description: '本地项目目录，用于读取 CHANGELOG 与打包附件' },
			title: { type: 'string', description: 'release 标题，默认与 tag 相同' },
			body: { type: 'string', description: 'release 正文，给了就不再自动生成' },
			assetPath: { type: 'string', description: '本地附件路径，省略则自动推导' },
			assetName: { type: 'string', description: '上传后的附件名，默认用本地文件名' },
			buildAsset: { type: 'boolean', description: '附件缺失时自动打包，默认 true' },
			draft: { type: 'boolean', description: '建为草稿，默认 false' },
			prerelease: { type: 'boolean', description: '标记为预发布，默认 false' },
			targetCommitish: { type: 'string', description: '建 tag 时的目标分支或 commit，默认仓库默认分支' },
			notesFromChangelog: { type: 'boolean', description: '从 CHANGELOG.md 抽取正文，默认 true' },
			forceVersion: { type: 'boolean', description: '跳过版本一致性校验（危险）' },
			deleteExistingTag: { type: 'boolean', description: '删除并重建已存在的 tag（危险，需审批）' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					owner: { type: 'string', required: true },
					repo: { type: 'string', required: true },
					tag: { type: 'string', required: true },
					url: { type: 'string', required: true },
					created: { type: 'boolean', required: true, description: 'release 是否新建（false 表示更新了已有 release）' },
					assetName: { type: 'string', required: true },
					assetSize: { type: 'integer', required: true },
					assetUrl: { type: 'string' },
					builtBy: { type: 'string', description: '附件由什么产出' },
					replaced: { type: 'string', description: '被替换掉的同名旧附件' },
					versionCheck: { type: 'string', required: true, description: '版本校验结论' },
					body: { type: 'string', required: true, description: '实际发布的正文' },
				},
			},
			render: (_args, value) => asText(value),
		},
		timeoutMs: config.uploadTimeoutMs + 60000,
		async execute(args, exec) {
			const owner = await resolveOwner(args.owner);
			const { repo } = requireRepo(owner, args.repo);
			const tag = toTag(args.tag);
			const version = normalizeVersion(tag);
			if (version === undefined) throw new Error(`无法解析版本号：${args.tag}`);
			const root = resolve(args.dir ?? process.cwd());
			const manifest = await readManifest(root);

			// ── artifact resolution ────────────────────────────────────────────────
			const artifact = await resolveArtifact({
				root,
				owner,
				repo,
				tag,
				assetPath: args.assetPath,
				build: args.buildAsset !== false,
				packTimeoutMs: config.packTimeoutMs,
				signal: exec.signal,
			});
			const assetName = typeof args.assetName === 'string' && args.assetName.length > 0
				? args.assetName
				: artifact.name;

			// ── version consistency ────────────────────────────────────────────────
			const check = checkVersionConsistency({
				tag,
				manifestVersion: typeof manifest?.version === 'string' ? manifest.version : undefined,
				assetName,
			});
			if (!check.ok && args.forceVersion !== true) {
				throw new Error(
					`版本一致性校验未通过，已拒绝发布：\n- ${check.mismatches.join('\n- ')}\n`
					+ '请把它们改成一致后重试；确认无误要强行发布，请显式传 forceVersion: true。',
				);
			}

			// ── tag ────────────────────────────────────────────────────────────────
			let tagExists = true;
			try {
				await client.request('GET', `/repos/${owner}/${repo}/git/ref/tags/${tag}`, { signal: exec.signal });
			} catch (error) {
				if (error instanceof GitHubApiError && error.status === 404) tagExists = false;
				else throw error;
			}
			if (tagExists && args.deleteExistingTag === true) {
				await client.request('DELETE', `/repos/${owner}/${repo}/git/refs/tags/${tag}`, { signal: exec.signal });
				tagExists = false;
			}

			// ── body ───────────────────────────────────────────────────────────────
			let section;
			if (args.notesFromChangelog !== false) {
				try {
					const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
					section = extractChangelogSection(changelog, version);
				} catch {
					section = undefined;
				}
			}
			const body = typeof args.body === 'string' && args.body.length > 0
				? args.body
				: composeBody({ tag, section, assetName });

			// ── release ────────────────────────────────────────────────────────────
			const releaseBody = {
				tag_name: tag,
				target_commitish: args.targetCommitish,
				name: typeof args.title === 'string' && args.title.length > 0 ? args.title : tag,
				body,
				draft: args.draft === true,
				prerelease: args.prerelease === true,
			};
			/** @type {Record<string, unknown>} */
			let release;
			let created = true;
			try {
				const { body: existing } = await client.request('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`, {
					signal: exec.signal,
				});
				release = /** @type {Record<string, unknown> } */ (existing);
				created = false;
			} catch (error) {
				if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
				const { body: made } = await client.request('POST', `/repos/${owner}/${repo}/releases`, {
					body: releaseBody,
					signal: exec.signal,
				});
				release = /** @type {Record<string, unknown> } */ (made);
			}

			// ── asset ──────────────────────────────────────────────────────────────
			const releaseId = Number(release.id);
			const existingAssets = Array.isArray(release.assets)
				? /** @type {Array<{ id: number, name: string }>} */ (release.assets)
				: [];
			let replaced;
			const clash = existingAssets.find((asset) => asset.name === assetName);
			if (clash !== undefined) {
				await client.request('DELETE', `/repos/${owner}/${repo}/releases/assets/${clash.id}`, { signal: exec.signal });
				replaced = clash.name;
			}
			const asset = await client.uploadAsset({
				uploadUrl: String(release.upload_url),
				name: assetName,
				filePath: artifact.path,
				size: artifact.size,
				signal: exec.signal,
			});

			return {
				owner,
				repo,
				tag,
				url: String(release.html_url),
				created,
				assetName,
				assetSize: artifact.size,
				assetUrl: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : undefined,
				builtBy: artifact.built,
				replaced,
				versionCheck: check.ok ? `通过：tag / package.json / 附件名均为 ${version}` : `已用 forceVersion 跳过：${check.mismatches.join('；')}`,
				body,
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Publish release ${args.tag}`, kind: 'other' }),
	}));

	ctx.tools.register(defineTool({
		name: 'github_get_release',
		description:
			'Read one existing release: its tag, body, asset names with sizes and download counts, and publish state. '
			+ 'Use it to inspect what is already published before re-cutting a version.',
		parameters: {
			repo: { type: 'string', required: true, description: '仓库名' },
			tag: { type: 'string', description: 'tag；省略则取最新一个 release' },
			owner: { type: 'string', description: '用户名或组织名，省略则用当前认证账号' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tag: { type: 'string', required: true },
					name: { type: 'string' },
					url: { type: 'string', required: true },
					draft: { type: 'boolean', required: true },
					prerelease: { type: 'boolean', required: true },
					publishedAt: { type: 'string' },
					body: { type: 'string' },
					assets: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string' },
								size: { type: 'integer' },
								downloads: { type: 'integer' },
							},
						},
					},
				},
			},
			render: (_args, value) => asText(value),
		},
		async execute(args, exec) {
			const owner = await resolveOwner(args.owner);
			const { repo } = requireRepo(owner, args.repo);
			const path = typeof args.tag === 'string' && args.tag.length > 0
				? `/repos/${owner}/${repo}/releases/tags/${toTag(args.tag)}`
				: `/repos/${owner}/${repo}/releases/latest`;
			const { body } = await client.request('GET', path, { signal: exec.signal });
			const release = /** @type { Record<string, unknown> } */ (body);
			const assets = Array.isArray(release.assets)
				? /** @type {Array<Record<string, unknown>>} */ (release.assets)
				: [];
			return {
				tag: String(release.tag_name),
				name: typeof release.name === 'string' ? release.name : undefined,
				url: String(release.html_url),
				draft: release.draft === true,
				prerelease: release.prerelease === true,
				publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
				body: typeof release.body === 'string' ? release.body : undefined,
				assets: assets.map((asset) => ({
					name: String(asset.name),
					size: Number(asset.size),
					downloads: Number(asset.download_count),
				})),
			};
		},
		presentCall: (args) => ({ card: 'generic', title: `Read release ${args.tag ?? 'latest'}`, kind: 'other' }),
	}));

	ctx.on('tools/pre-execute', async (exec, next) => {
		const decision = decide(exec.name, /** @type {Record<string, unknown>} */ (exec.arguments ?? {}));
		if (decision.kind === 'allow') return next();
		return decision;
	});

	// A startup marker, because the hardest failure to diagnose for a tool plugin is
	// "the tools are not in my tool list": from the outside, a plugin that never loaded
	// and one that loaded but registered nothing look identical. Written only when a
	// path is configured, so nothing touches disk by default.
	if (config.statusFile.trim().length > 0) {
		const report = {
			plugin: name,
			loadedAt: new Date().toISOString(),
			tools: REGISTERED_TOOL_NAMES,
			tokenRef: config.tokenRef,
			apiBase: config.apiBase,
			uploadTimeoutMs: config.uploadTimeoutMs,
		};
		try {
			await writeFile(config.statusFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
		} catch (error) {
			ctx.logger.warn(
				`dsh-github-ops: 无法写入 statusFile ${config.statusFile}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export { Config, REGISTERED_TOOL_NAMES, apply, inject, name };
