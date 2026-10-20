// Prompt construction for delegated work and independent review.
//
// Prompt text is a contract, not decoration. It states what the worker must do,
// what it must not do, and — critically — what it cannot do on its own: the
// worker cannot approve its own work, and the reviewer cannot change the
// workspace. Both prompts also carry an explicit evidence boundary so neither
// party believes it may widen its own scope.

/** Placeholder substituted for withheld patch content. */
export const REDACTED_PLACEHOLDER = '[content withheld: sensitive path]';

/** Bounds on interpolated evidence inside a prompt. */
const EVIDENCE_LIMITS = Object.freeze({
  fileList: 200,
  patchChars: 24_000,
});

/**
 * Build the delegation prompt for one task.
 * @param {object} input - `taskId`, `prompt`, `workspacePath`, `isolation`, `diff`, `baseline`.
 * @returns {string} assembled prompt.
 */
export function buildWorkerPrompt(input) {
  const lines = [];
  lines.push('You are a delegated implementation worker. Your work will be reviewed by the host and by an independent reviewer.');
  lines.push('');
  lines.push(`Task id: ${input.taskId}`);
  if (typeof input.workspacePath === 'string' && input.workspacePath !== '') {
    lines.push(`Workspace: ${input.workspacePath}`);
  }
  lines.push(`Isolation: ${input.isolation ?? 'shared'}`);
  lines.push('');
  lines.push('## Task');
  lines.push(String(input.prompt ?? '').trim());
  lines.push('');
  lines.push('## Working rules');
  lines.push('- You may modify files only inside the workspace above.');
  lines.push('- Do not commit, push, tag, or rewrite git history.');
  lines.push('- Do not read or print credentials, tokens, or .env contents.');
  lines.push('- Do not install packages from the network unless the task explicitly requires it.');
  lines.push('- Report what you changed and what you could not do. Do not claim checks you did not run.');
  lines.push('');
  lines.push('## Completion');
  lines.push('When the task is complete, reply with a short summary, the files you changed, and any checks you actually ran with their results.');
  lines.push('You cannot approve your own work; the host decides acceptance.');
  if (input.baseline !== undefined && input.baseline !== null) {
    lines.push('');
    lines.push(`## Starting state: ${input.baseline.dirtyBaseline === true ? 'the workspace already had uncommitted changes' : 'the workspace was clean'}`);
  }
  return lines.join('\n');
}

/**
 * Build the independent review prompt.
 *
 * The reviewer is asked for a machine-readable verdict line and is told
 * explicitly that it must not modify anything and cannot approve on the host's
 * behalf.
 * @param {object} input - `taskId`, `taskPrompt`, `workerSummary`, `evidence`.
 * @returns {string} assembled prompt.
 */
export function buildReviewPrompt(input) {
  const lines = [];
  lines.push('You are an independent reviewer. You did not perform this work.');
  lines.push('');
  lines.push(`Task id: ${input.taskId}`);
  lines.push('');
  lines.push('## The task that was delegated');
  lines.push(String(input.taskPrompt ?? '').trim());
  lines.push('');
  lines.push('## The worker\'s report');
  lines.push(String(input.workerSummary ?? '(no summary produced)').trim());
  lines.push('');
  lines.push('## Measured changes');
  lines.push(renderEvidence(input.evidence));
  lines.push('');
  lines.push('## Your constraints');
  lines.push('- You are read-only. Any attempt to modify the workspace will be denied by the harness.');
  lines.push('- You cannot approve work on behalf of the host. Your verdict is evidence, not acceptance.');
  lines.push('- Judge only what the evidence above shows; if it is insufficient, say so.');
  lines.push('');
  lines.push('## Required output');
  lines.push('End your reply with exactly these two lines:');
  lines.push('VERDICT: approve   (or)   VERDICT: changes-requested');
  lines.push('REASON: one sentence');
  return lines.join('\n');
}

/**
 * Render measured change evidence into prompt-safe text.
 * @param {object | null} evidence - value returned by the workspace audit.
 * @returns {string} bounded evidence block.
 */
export function renderEvidence(evidence) {
  if (evidence === null || evidence === undefined) return 'No change evidence was captured.';
  const lines = [];
  if (evidence.dirtyBaseline === true) {
    lines.push(`Note: the workspace had ${evidence.preexistingChanges ?? 'some'} pre-existing change(s) before this task ran.`);
  }
  const files = Array.isArray(evidence.files) ? evidence.files.slice(0, EVIDENCE_LIMITS.fileList) : [];
  if (files.length === 0) {
    lines.push('No files changed.');
  } else {
    lines.push(`Changed files (${evidence.fileCount ?? files.length}${evidence.truncatedFiles ? ', list truncated' : ''}):`);
    for (const file of files) {
      lines.push(`  ${file.status}  ${file.path}${file.sensitive === true ? '  [sensitive: content withheld]' : ''}`);
    }
  }
  if (Array.isArray(evidence.sensitivePaths) && evidence.sensitivePaths.length > 0) {
    lines.push('');
    lines.push('Sensitive paths were touched. Their content is withheld from this evidence:');
    for (const path of evidence.sensitivePaths.slice(0, EVIDENCE_LIMITS.fileList)) lines.push(`  ${path}`);
  }
  lines.push('');
  lines.push('Diff:');
  const patch = typeof evidence.patchText === 'string' ? evidence.patchText : '';
  if (patch === '') {
    lines.push('(no textual diff captured)');
  } else {
    lines.push(patch.slice(0, EVIDENCE_LIMITS.patchChars));
    if (patch.length > EVIDENCE_LIMITS.patchChars || evidence.patchTruncated === true) {
      lines.push(`(diff truncated for review at ${EVIDENCE_LIMITS.patchChars} characters)`);
    }
  }
  return lines.join('\n');
}
