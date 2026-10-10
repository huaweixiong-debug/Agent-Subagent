'use strict';

const { truncate } = require('./util');

function renderAnswers(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return '(none)';
  return answers
    .map((answer, index) => `- [${index + 1}] ${truncate(answer.text, 2000)}`)
    .join('\n');
}

function buildPlanPrompt({ request, worktree, allowedCommands, allowedGlobs, maxTasks, maxInstructionChars, feedback, answers, grill }) {
  const lines = [
    'You are the planning agent for an automated requirement-to-tasks loop. You have read-only tools.',
    `The target repository is checked out at: ${worktree}`,
    'Use your tools relative to the current working directory. Read the repository, then plan the requirement below.',
    '',
    'Human requirement:',
    truncate(request, 50000),
    '',
    'Rules:',
    '- Respond with exactly one JSON object and nothing else (no markdown fences, no commentary).',
    '- Plan schema:',
    '  {"status":"PLAN","summary":"<short summary>","tasks":[{"id":"T1","title":"<short title>",',
    '   "instruction":"<self-contained instructions for an executor agent>","files":["relative/path"],',
    '   "checks":["<exact allow-listed command>"],"done":"<objective completion criteria>"}]}',
    `- Provide between 1 and ${maxTasks} ordered, independently reviewable tasks.`,
    `- "instruction" must be at most ${maxInstructionChars} characters and fully self-contained.`,
    '- "files" entries must be repository-relative and must match these globs:',
    `  ${JSON.stringify(allowedGlobs)}`,
    '- "checks" entries must exactly equal one of these allow-listed commands (or use an empty array):',
    `  ${JSON.stringify(allowedCommands)}`,
    '- Never plan changes to .git, .env files, credentials, keys, or anything outside the repository.',
    '- Never plan a git commit, git push, or git merge; leave changes uncommitted in the worktree.',
    '- If a material decision or approval is required, respond with exactly:',
    '  {"status":"QUESTION","question":"<precise question>"}',
    '',
    'Human answers so far (may be empty):',
    renderAnswers(answers),
    '',
    'Previous plan validation errors to fix (may be empty):',
    feedback ? truncate(feedback, 4000) : '(none)',
  ];
  if (grill && grill.content) {
    lines.push('');
    lines.push(`Planning workflow skill to apply: ${grill.name} (${grill.path})`);
    lines.push('Apply this process to interrogate and sharpen the requirement and the plan. If the process');
    lines.push('would require interactive user input, do not ask interactively: convert every material unknown');
    lines.push('into a {"status":"QUESTION"} response instead.');
    lines.push('--- skill content ---');
    lines.push(grill.content);
    lines.push('--- end skill content ---');
  }
  return lines.join('\n');
}

function buildExecutionPrompt({ task, worktree, fix, answers }) {
  const lines = [
    'You are the execution agent for an automated task loop. Work only inside the current working directory,',
    `which is an isolated git worktree at: ${worktree}`,
    '',
    `Task ${task.id}: ${task.title}`,
    '',
    'Instruction:',
    task.instruction,
    '',
    'Files you may modify:',
    ...task.files.map((file) => `- ${file}`),
    '',
    'Verification commands that will be run afterwards (do not invent others):',
    ...(task.checks.length ? task.checks.map((check) => `- ${check}`) : ['- (none configured)']),
    '',
    `Done when: ${task.done}`,
    '',
    'Rules: modify only the listed files; never touch .git, .env files, credentials, keys, or paths outside',
    'this repository; never run git commit, git push, or git merge; do not ask questions; implement the task',
    'and stop when it is complete.',
  ];
  if (fix) {
    lines.push('');
    lines.push('The reviewer rejected the previous attempt. Fix exactly the issues below without expanding scope.');
    lines.push('');
    lines.push('Reviewer notes:');
    lines.push(truncate(fix.reviewNotes || '(none)', 6000));
    if (Array.isArray(fix.failedChecks) && fix.failedChecks.length > 0) {
      lines.push('');
      lines.push('Failed checks:');
      for (const check of fix.failedChecks) {
        lines.push(`- ${check.command} (exit ${check.exitCode}${check.timedOut ? ', timed out' : ''})`);
      }
    }
  }
  if (Array.isArray(answers) && answers.length > 0) {
    lines.push('');
    lines.push('Human guidance recorded for this run:');
    lines.push(renderAnswers(answers));
  }
  return lines.join('\n');
}

function buildReviewPrompt({
  summary,
  task,
  worktree,
  diffStat,
  diff,
  execution,
  checks,
  priorReview,
  answers,
  maxEvidenceChars,
  changedFiles,
  fileViolations,
}) {
  const lines = [
    'You are the read-only reviewer for an automated task loop. Do not modify anything.',
    `The isolated git worktree being reviewed is: ${worktree}`,
    `Plan summary: ${truncate(summary, 2000)}`,
    '',
    'Task specification (JSON):',
    JSON.stringify(task, null, 2),
    '',
    'Execution metadata (JSON):',
    JSON.stringify(execution, null, 2),
    '',
    'Check results (JSON):',
    JSON.stringify(checks, null, 2),
    '',
    'Files changed in the worktree:',
    JSON.stringify(changedFiles || []),
    '',
    'Files changed that the task did not declare (must be empty for PASS):',
    JSON.stringify(fileViolations || []),
    '',
    'Uncommitted diff versus the branch point:',
    '--- diff --stat ---',
    truncate(diffStat, 10000),
    '--- diff --',
    truncate(diff, Math.max(1000, maxEvidenceChars - 14000)),
  ];
  if (priorReview) {
    lines.push('');
    lines.push('Previous review (the fix attempt was made in response to this):');
    lines.push(JSON.stringify(priorReview, null, 2));
  }
  if (Array.isArray(answers) && answers.length > 0) {
    lines.push('');
    lines.push('Human answers recorded for this run:');
    lines.push(renderAnswers(answers));
  }
  lines.push('');
  lines.push('Review rules:');
  lines.push('- PASS only if the diff satisfies the task "done" criteria, all checks passed, the diff only');
  lines.push('  touches the declared files (no undeclared changes may remain), and no protected path or');
  lines.push('  unsafe operation is involved.');
  lines.push('- FIX if a small bounded correction is required; the notes must list the exact required changes');
  lines.push('  (for undeclared files, require reverting or explicitly folding them into the task is not allowed).');
  lines.push('- QUESTION if a material decision or approval is required; the question must be precise.');
  lines.push('- Respond with exactly one JSON object and nothing else:');
  lines.push('  {"verdict":"PASS","notes":"..."} or');
  lines.push('  {"verdict":"FIX","notes":"<exact required changes>"} or');
  lines.push('  {"verdict":"QUESTION","question":"<precise question>"}');
  return lines.join('\n');
}

module.exports = { renderAnswers, buildPlanPrompt, buildExecutionPrompt, buildReviewPrompt };
