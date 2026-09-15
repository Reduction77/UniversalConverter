#!/usr/bin/env node
/**
 * Minimal stand-in for the GitHub REST API, so the plugin can be exercised by a real
 * harness agent without a real token or a real repository. It answers only the routes
 * the release flow needs and records every request it receives.
 *
 * It listens on 127.0.0.1 so the probe profile can point `apiBase` at it.
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 3199);
const recorded = [];

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - status code.
 * @param {unknown} body - JSON body.
 */
function send(response, status, body) {
	const text = JSON.stringify(body);
	response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
	response.end(text);
}

const server = createServer((request, response) => {
	/** @type {Buffer[]} */
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		const body = Buffer.concat(chunks).toString('utf8');
		const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
		recorded.push({ method: request.method, path: url.pathname, hasAuth: request.headers.authorization !== undefined, bodyLength: body.length });
		const path = url.pathname;

		if (path === '/user') return send(response, 200, { login: 'Reduction77' });
		if (path === '/rate_limit') return send(response, 200, { resources: { core: { remaining: 4999, limit: 5000 } } });
		if (path === '/repos/Reduction77/probe-repo') {
			return send(response, 200, { name: 'probe-repo', private: false, default_branch: 'main', html_url: 'https://github.com/Reduction77/probe-repo' });
		}
		return send(response, 404, { message: `probe api: no route for ${request.method} ${path}` });
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`probe api listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
	console.log(`probe api recorded ${recorded.length} requests:`);
	for (const entry of recorded) console.log(`  ${entry.method} ${entry.path} auth=${entry.hasAuth}`);
	server.close();
});
