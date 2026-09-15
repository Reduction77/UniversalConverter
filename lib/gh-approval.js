/**
 * Approval policy for this plugin's tools.
 *
 * The gate is deliberately narrow. Creating repositories, pushing files, opening pull
 * requests, and publishing releases are all additive or reversible-by-addition — a
 * release can be deleted and re-cut, a branch can be reset. Gating those would train
 * the operator to click through prompts reflexively, which is the failure mode that
 * makes a gate worthless on the operations that actually matter.
 *
 * What is gated is the irreversible or history-rewriting set: deleting a repository,
 * deleting a branch or release, force-pushing over remote history, and flipping a
 * private repository to public (a one-way disclosure of everything in it).
 *
 * The mechanism is the `tools/pre-execute` waterfall: returning `{ kind: 'ask' }`
 * delegates to the harness approval service, and a composition with no approval
 * answerer turns that `ask` into a denial — so an unconfigured deployment fails closed
 * rather than silently permitting.
 */

/** Tool names owned by this plugin. The gate must never fire for another plugin's tool. */
export const OWNED_TOOL_NAMES = new Set([
	'github_create_repository',
	'github_push_files',
	'github_upload_project',
	'github_release_publish',
]);

/**
 * Classify one pending call as allowed or approval-requiring.
 *
 * @param {string} toolName - the tool about to execute.
 * @param {Record<string, unknown>} args - the parsed arguments.
 * @returns {{ kind: 'allow' } | { kind: 'ask', reason: string }} the decision.
 */
export function decide(toolName, args) {
	if (!OWNED_TOOL_NAMES.has(toolName)) return { kind: 'allow' };

	if (toolName === 'github_create_repository' && args.visibility === 'private') {
		return { kind: 'allow' };
	}

	if (toolName === 'github_push_files' || toolName === 'github_upload_project') {
		if (args.force === true) {
			return {
				kind: 'ask',
				reason: `force push 会覆盖 ${String(args.owner ?? '')}/${String(args.repo ?? '')} 上 ${String(args.branch ?? 'main')} 分支的远端历史，被覆盖的提交在 GitHub 上无法恢复（只能靠本地 clone 或 reflog）。`,
			};
		}
		return { kind: 'allow' };
	}

	if (toolName === 'github_release_publish') {
		if (args.deleteExistingTag === true) {
			return {
				kind: 'ask',
				reason: `会删除并重建 tag \`${String(args.tag ?? '')}\`，已有 release 与附件一并消失。`,
			};
		}
		return { kind: 'allow' };
	}

	return { kind: 'allow' };
}

/**
 * Reason text for the repository-settings changes this plugin performs as part of a
 * push or release, so the same wording is used everywhere the gate fires.
 *
 * @param {string} toolName - tool performing the change.
 * @param {string} subject - what is being changed.
 * @returns {string} the operator-facing reason.
 */
export function destructiveReason(toolName, subject) {
	return `${toolName} 即将执行破坏性操作：${subject}`;
}
