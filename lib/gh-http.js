/**
 * GitHub REST v3 client for the dsh-github-ops plugin.
 *
 * Design notes that are load-bearing, not decoration:
 *
 * - **The token is resolved per operation, never cached.** `ctx.credentials.resolve`
 *   is documented as a per-call read; caching would make a rotated token invisible
 *   until restart. The resolved secret lives only in `Authorization` headers and is
 *   scrubbed from every error path by {@link redact}, because tool errors are durable,
 *   model-visible, and replayed.
 * - **File uploads stream.** A release asset may be a 68 MB executable; buffering it
 *   would put the whole thing in the heap. `openAsBlob` hands fetch a file-backed Blob
 *   that reads on demand.
 * - **Asset upload uses a different host than the REST API.** GitHub returns an
 *   `upload_url` template (`https://uploads.github.com/...{?name,label}`) that is NOT
 *   under `apiBaseUrl`; the request path therefore always takes an absolute URL, and
 *   only relative paths get prefixed.
 */

import { openAsBlob } from 'node:fs';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

/** Default REST endpoint. GitHub Enterprise Server deployments reconfigure this. */
export const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * An HTTP or transport failure carrying the status and the endpoint it came from.
 * `message` is always pre-redacted.
 */
export class GitHubApiError extends Error {
	/**
	 * @param {string} message - pre-redacted human-readable failure.
	 * @param {object} [details] - structured context.
	 * @param {number} [details.status] - HTTP status, absent on transport failures.
	 * @param {string} [details.endpoint] - method and URL actually attempted.
	 * @param {string} [details.body] - redacted response body excerpt.
	 */
	constructor(message, details = {}) {
		super(message);
		this.name = 'GitHubApiError';
		this.status = details.status;
		this.endpoint = details.endpoint;
		this.body = details.body;
	}
}

/**
 * Replace every occurrence of the live token with a fixed marker.
 *
 * Two shapes are scrubbed: the token itself, and the `Authorization` header value.
 * GitHub echoes request context in some error responses, so a naive error path can
 * leak the secret into the session log.
 *
 * @param {unknown} value - any value about to become model-visible.
 * @param {string | undefined} secret - the live token, when one was resolved.
 * @returns {string} the redacted text.
 */
export function redact(value, secret) {
	const text = typeof value === 'string' ? value : String(value);
	if (secret === undefined || secret.length === 0) return text;
	return text.split(secret).join('[REDACTED]');
}

/**
 * Resolve the GitHub token for one operation.
 *
 * Resolution goes through the harness credential provider and nowhere else. That
 * provider already layers the process environment over the managed store over the
 * `.env` fallbacks, so reading `process.env` here as well would create a second,
 * divergent precedence order — the status tool and the request path would disagree
 * about which token is live, which is exactly the failure a status tool exists to
 * prevent.
 *
 * @param {object} options - resolution inputs.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context carrying `credentials`.
 * @param {string} options.tokenRef - credential reference name, e.g. `GITHUB_TOKEN`.
 * @returns {Promise<{ value: string, source: string } | undefined>} the secret and where it came from, or `undefined` when unconfigured.
 */
export async function resolveToken({ ctx, tokenRef }) {
	const resolved = await ctx.credentials.resolve(credentialRef(tokenRef));
	if (resolved === undefined || resolved.value.trim().length === 0) return undefined;
	return { value: resolved.value.trim(), source: resolved.source };
}

/**
 * Fail loudly and actionably when no credential is configured.
 *
 * The message names the exact UI path, because the caller of this function is a model
 * reporting to a human who has to go perform the fix.
 *
 * @param {string} tokenRef - the reference name that resolved to nothing.
 * @returns {GitHubApiError} the error to throw.
 */
export function missingTokenError(tokenRef) {
	return new GitHubApiError(
		`没有可用的 GitHub 凭据：引用名 \`${tokenRef}\` 在环境变量和 DSH 凭据存储里都没有解析到值。\n`
		+ '请在 DSH 的 设置 → 插件 → 凭据 里新增一条，键名填 `GITHUB_TOKEN`，值粘贴你的 Personal Access Token。\n'
		+ 'Token 建议至少勾选 `repo`（公开与私有仓库的完整读写、建仓）；若要改 `.github/workflows/*` 需额外勾选 `workflow`。',
	);
}

/**
 * Join a path onto the API base unless it is already absolute.
 *
 * @param {string} apiBase - configured REST base, without a trailing slash.
 * @param {string} pathOrUrl - relative API path or absolute URL.
 * @returns {string} the absolute URL to request.
 */
function absolute(apiBase, pathOrUrl) {
	if (/^https?:\/\//u.test(pathOrUrl)) return pathOrUrl;
	const base = apiBase.replace(/\/+$/u, '');
	const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
	return `${base}${path}`;
}

/**
 * Parse a response body into JSON when it is JSON, else keep the raw text.
 *
 * @param {Response} response - the settled response.
 * @returns {Promise<unknown>} parsed or raw body.
 */
async function readBody(response) {
	const text = await response.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Pull a human-usable message out of a GitHub error payload.
 *
 * @param {unknown} body - parsed error body.
 * @param {string} fallback - text to use when the body carries no message.
 * @returns {string} the message.
 */
function errorMessage(body, fallback) {
	if (body !== null && typeof body === 'object' && typeof body.message === 'string') {
		const errors = Array.isArray(body.errors)
			? body.errors
				.map((entry) => (entry !== null && typeof entry === 'object' && typeof entry.message === 'string'
					? entry.message
					: JSON.stringify(entry)))
				.filter((entry) => entry.length > 0)
			: [];
		return errors.length > 0 ? `${body.message} (${errors.join('; ')})` : body.message;
	}
	if (typeof body === 'string' && body.trim().length > 0) return body.trim();
	return fallback;
}

/**
 * Build a client bound to one plugin context and configuration.
 *
 * Every method resolves the token itself, so a client instance may outlive a token
 * rotation.
 *
 * @param {object} options - client inputs.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context carrying `credentials`.
 * @param {string} options.tokenRef - credential reference name.
 * @param {string} [options.apiBase] - REST base URL.
 * @param {number} [options.timeoutMs] - default request budget.
 * @param {number} [options.uploadTimeoutMs] - asset-upload budget for large binaries.
 * @returns {object} the client.
 */
export function createClient({ ctx, tokenRef, apiBase = DEFAULT_API_BASE, timeoutMs = 30000, uploadTimeoutMs = 600000 }) {
	/**
	 * Perform one authenticated JSON request.
	 *
	 * @param {string} method - HTTP method.
	 * @param {string} pathOrUrl - relative API path or absolute URL (asset uploads).
	 * @param {object} [options] - request options.
	 * @param {unknown} [options.body] - JSON-serializable body.
	 * @param {number} [options.timeout] - override the default budget.
	 * @param {AbortSignal} [options.signal] - caller cancellation, fused with the timeout.
	 * @returns {Promise<{ status: number, body: unknown }>} the settled response.
	 */
	async function request(method, pathOrUrl, { body, timeout = timeoutMs, signal } = {}) {
		const resolved = await resolveToken({ ctx, tokenRef });
		if (resolved === undefined) throw missingTokenError(tokenRef);
		const secret = resolved.value;
		const url = absolute(apiBase, pathOrUrl);
		const timeoutSignal = AbortSignal.timeout(timeout);
		const fused = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
		/** @type {Record<string, string>} */
		const headers = {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${secret}`,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'dsh-github-ops',
		};
		/** @type {RequestInit} */
		const init = { method, headers, signal: fused };
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		let response;
		try {
			response = await fetch(url, init);
		} catch (error) {
			throw new GitHubApiError(
				redact(`请求 GitHub 失败（${method} ${url}）：${error instanceof Error ? error.message : String(error)}`, secret),
				{ endpoint: `${method} ${url}` },
			);
		}
		const parsed = await readBody(response);
		if (!response.ok) {
			throw new GitHubApiError(
				redact(
					`GitHub 返回 HTTP ${response.status}（${method} ${url}）：${errorMessage(parsed, response.statusText)}`,
					secret,
				),
				{
					status: response.status,
					endpoint: `${method} ${url}`,
					body: redact(typeof parsed === 'string' ? parsed : JSON.stringify(parsed ?? ''), secret).slice(0, 800),
				},
			);
		}
		return { status: response.status, body: parsed };
	}

	/**
	 * Upload one local file as a release asset, streaming it rather than buffering.
	 *
	 * `content-length` is set explicitly: fetch would otherwise use chunked transfer
	 * encoding, which GitHub's upload host rejects.
	 *
	 * @param {object} options - upload inputs.
	 * @param {string} options.uploadUrl - the release's `upload_url` template.
	 * @param {string} options.name - asset file name.
	 * @param {string} options.filePath - absolute path to the local file.
	 * @param {number} options.size - file size in bytes, for `content-length`.
	 * @param {string} [options.label] - optional asset label.
	 * @param {AbortSignal} [options.signal] - caller cancellation.
	 * @returns {Promise<object>} the created asset payload.
	 */
	async function uploadAsset({ uploadUrl, name, filePath, size, label, signal }) {
		const resolved = await resolveToken({ ctx, tokenRef });
		if (resolved === undefined) throw missingTokenError(tokenRef);
		const secret = resolved.value;
		// Strip the RFC 6570 template: link-template expansion is impossible here because
		// the name must arrive percent-encoded as a query parameter, which searchParams does.
		const base = uploadUrl.replace(/\{[^}]*\}$/u, '');
		const url = new URL(base);
		url.searchParams.set('name', name);
		if (label !== undefined && label.length > 0) url.searchParams.set('label', label);
		const blob = await openAsBlob(filePath);
		const timeoutSignal = AbortSignal.timeout(uploadTimeoutMs);
		const fused = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${secret}`,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(size),
					'X-GitHub-Api-Version': '2022-11-28',
					'User-Agent': 'dsh-github-ops',
				},
				body: blob,
				duplex: 'half',
				signal: fused,
			});
		} catch (error) {
			throw new GitHubApiError(
				redact(
					`上传附件失败（${name} → ${url.origin}${url.pathname}）：${error instanceof Error ? error.message : String(error)}`,
					secret,
				),
				{ endpoint: `POST ${url.origin}${url.pathname}` },
			);
		}
		const parsed = await readBody(response);
		if (!response.ok) {
			throw new GitHubApiError(
				redact(`上传附件返回 HTTP ${response.status}：${errorMessage(parsed, response.statusText)}`, secret),
				{ status: response.status, endpoint: `POST ${url.origin}${url.pathname}` },
			);
		}
		return /** @type {object} */ (parsed);
	}

	return { request, uploadAsset };
}

/**
 * Expose the resolved credential's presence and origin, never its value.
 *
 * Shares {@link resolveToken}'s path so the two can never disagree about which layer
 * supplied the live token.
 *
 * @param {object} options - describe inputs.
 * @param {import('@deepseek-ai/cordis').Context} options.ctx - plugin context.
 * @param {string} options.tokenRef - credential reference name.
 * @returns {Promise<object>} a value-free description for surfaces and models.
 */
export async function describeToken({ ctx, tokenRef }) {
	const resolved = await resolveToken({ ctx, tokenRef });
	const info = await ctx.credentials.describe(credentialRef(tokenRef));
	return {
		ref: tokenRef,
		configured: resolved !== undefined,
		source: resolved?.source ?? 'none',
		writable: info.writable,
	};
}
