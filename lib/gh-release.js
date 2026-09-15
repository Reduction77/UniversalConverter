/**
 * Release conventions: version identity, artifact naming, and release-note assembly.
 *
 * These rules are extracted from the maintainer's own repository history rather than
 * invented, because a release tool that guesses will eventually publish something
 * mislabelled. The observed conventions are:
 *
 * - tags carry a `v` prefix (`v1.6.0`, `v4.1.4`), and the leading `v` is the only
 *   difference from the `package.json` version;
 * - a plugin release attaches exactly one installer ZIP named
 *   `<package-name>-<version>.zip`, which is what the project's own packaging script emits;
 * - `CHANGELOG.md` holds one `## <version>` section per release, and the release body is
 *   that section plus a pointer to the README install steps.
 *
 * The consistency check exists because a real discrepancy was found in the wild: one
 * repository publishes tag `v1.0.0` while attaching `..._v0.3.0_....zip`. Nothing in
 * GitHub prevents that, and a user downloading the asset has no way to tell.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Matches a semantic version with an optional leading `v` and optional prerelease/build. */
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

/**
 * Normalize a tag or version string to its bare `major.minor.patch` form.
 *
 * @param {string} value - tag or version, with or without a `v` prefix.
 * @returns {string | undefined} the bare version, or `undefined` when malformed.
 */
export function normalizeVersion(value) {
	const match = VERSION_PATTERN.exec(value.trim());
	return match === undefined ? undefined : match[1];
}

/**
 * Produce the canonical tag for a version.
 *
 * @param {string} version - bare or `v`-prefixed version.
 * @returns {string} the `v`-prefixed tag.
 */
export function toTag(version) {
	const bare = normalizeVersion(version);
	if (bare === undefined) throw new Error(`不是合法的版本号：${JSON.stringify(version)}`);
	return `v${bare}`;
}

/**
 * Read a project's `package.json`, if it has one.
 *
 * @param {string} root - project root.
 * @returns {Promise<{ name?: string, version?: string, scripts?: Record<string, string> } | undefined>} parsed manifest.
 */
export async function readManifest(root) {
	try {
		const raw = await readFile(join(root, 'package.json'), 'utf8');
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract the changelog section body for one version.
 *
 * Accepts `## 1.6.0`, `## v1.6.0`, `## [1.6.0]`, and the `- 2026-01-01` date suffix
 * variants that keep-a-changelog tooling emits, because a maintainer switching styles
 * should not silently lose their release notes.
 *
 * @param {string} changelog - full changelog text.
 * @param {string} version - bare version to find.
 * @returns {string | undefined} the trimmed section body, or `undefined` when absent.
 */
export function extractChangelogSection(changelog, version) {
	const lines = changelog.split('\n');
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s|$)`, 'u');
	let start = -1;
	for (const [index, line] of lines.entries()) {
		if (heading.test(line.trim())) {
			start = index + 1;
			break;
		}
	}
	if (start === -1) return undefined;
	const collected = [];
	for (let index = start; index < lines.length; index++) {
		if (lines[index].startsWith('## ')) break;
		collected.push(lines[index]);
	}
	const body = collected.join('\n').trim();
	return body.length === 0 ? undefined : body;
}

/**
 * Compose the default release body.
 *
 * The install section is a pointer, never a copy: the README's install steps are
 * version-specific (they name the exact artifact file), so duplicating them here would
 * create a second place to forget during a version bump.
 *
 * @param {object} options - composition inputs.
 * @param {string} options.tag - the release tag.
 * @param {string | undefined} options.section - changelog body for this version.
 * @param {string | undefined} options.assetName - attached artifact name, when any.
 * @returns {string} the release body.
 */
export function composeBody({ tag, section, assetName }) {
	/** @type {string[]} */
	const parts = [];
	const version = normalizeVersion(tag) ?? tag;
	parts.push(`## ${tag}`, '');
	parts.push(section ?? `版本 ${version}。改动历史见仓库根目录的 \`CHANGELOG.md\`。`, '');
	if (assetName !== undefined) parts.push('### 下载', '', `- \`${assetName}\``, '');
	parts.push('### 安装', '', '安装步骤见仓库 README 的 **安装** 一节；下载上面的附件，不要使用 GitHub 自动生成的 Source code 压缩包（它带一层仓库目录，与安装包结构不同）。');
	return parts.join('\n');
}

/**
 * Verify that a tag, a manifest version, and an artifact name agree.
 *
 * @param {object} options - verification inputs.
 * @param {string} options.tag - release tag.
 * @param {string | undefined} options.manifestVersion - `package.json` version, when a manifest exists.
 * @param {string | undefined} options.assetName - artifact file name, when one is attached.
 * @returns {{ ok: boolean, version: string | undefined, mismatches: string[] }} the verdict and every disagreement found.
 */
export function checkVersionConsistency({ tag, manifestVersion, assetName }) {
	/** @type {string[]} */
	const mismatches = [];
	const tagVersion = normalizeVersion(tag);
	if (tagVersion === undefined) {
		return { ok: false, version: undefined, mismatches: [`tag \`${tag}\` 不是合法版本号（应为 v1.2.3 形式）`] };
	}
	if (manifestVersion !== undefined) {
		const bare = normalizeVersion(manifestVersion);
		if (bare === undefined) mismatches.push(`package.json 的 version \`${manifestVersion}\` 不是合法版本号`);
		else if (bare !== tagVersion) mismatches.push(`tag 是 \`${tagVersion}\`，但 package.json 里是 \`${bare}\``);
	}
	if (assetName !== undefined) {
		// Find every version-looking token in the artifact name; a name with two of them
		// (as in `pkg_v0.3.0_GitHub_Source.zip`) is itself the bug.
		const found = assetName.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/gu) ?? [];
		if (found.length === 0) mismatches.push(`附件名 \`${assetName}\` 里找不到版本号`);
		else for (const candidate of found) {
			if (candidate !== tagVersion) mismatches.push(`tag 是 \`${tagVersion}\`，但附件名里的版本是 \`${candidate}\``);
		}
		if (found.length > 1) mismatches.push(`附件名 \`${assetName}\` 里出现了多个版本号，容易让人误判`);
	}
	return { ok: mismatches.length === 0, version: tagVersion, mismatches };
}

/**
 * Derive the conventional artifact name for a plugin-style release.
 *
 * @param {object} options - naming inputs.
 * @param {string} options.packageName - `package.json` name.
 * @param {string} options.version - bare version.
 * @returns {string} the artifact file name.
 */
export function defaultAssetName({ packageName, version }) {
	return `${packageName}-${version}.zip`;
}
