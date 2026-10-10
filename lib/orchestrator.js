'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, nowIso, readJsonFile, truncate, writeFileAtomic } = require('./util');
const stateModule = require('./state');
const events = require('./events');
const git = require('./git');
const invoke = require('./invoke');
const planLib = require('./plan');
const reviewLib = require('./review');
const prompts = require('./prompts');
const skills = require('./skills');

const S = stateModule.STATUS;

function planningEvidenceDir(runDir) {
  return path.join(runDir, 'evidence', 'planning');
}

function taskEvidenceDir(runDir, taskId) {
  return path.join(runDir, 'evidence', `task-${taskId}`);
}

function finalEvidenceDir(runDir) {
  return path.join(runDir, 'evidence', 'final');
}

function readRequest(runDir) {
  return fs.readFileSync(path.join(runDir, 'REQUEST.md'), 'utf8');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJsonFile(filePath, path.basename(filePath));
  } catch {
    return null;
  }
}

function protectedPathRules() {
  return {
    '.env*': 'deny',
    '**/.env*': 'deny',
    '**/id_rsa*': 'deny',
    '**/id_ed25519*': 'deny',
    '**/*.pem': 'deny',
    '**/*.key': 'deny',
    '**/*.pfx': 'deny',
    '**/*.p12': 'deny',
    '**/credentials*': 'deny',
    '**/.npmrc': 'deny',
    '**/.netrc': 'deny',
    '**/.aws/**': 'deny',
    '**/.ssh/**': 'deny',
    '**/.gnupg/**': 'deny',
    '.git/**': 'deny',
    '**/.git/**': 'deny',
  };
}

function buildOpenCodeOverlay(config, options = {}) {
  const protectedRules = protectedPathRules();
  // Last matching rule wins in OpenCode. Everything unspecified is denied by the
  // top-level wildcard; only the read/glob/list tools are allowed, reads stay
  // repository-wide minus protected paths, and edit is allowed only for the files
  // the current task declares, with protected denials applied last.
  const readRules = { '*': 'allow', ...protectedRules };
  const editRules = { '*': 'deny' };
  for (const file of options.taskFiles || []) editRules[file] = 'allow';
  Object.assign(editRules, protectedRules);
  const permission = {
    '*': 'deny',
    external_directory: { '*': 'deny' },
    read: readRules,
    glob: 'allow',
    list: 'allow',
    // The documented edit permission already covers the edit/write/patch aliases,
    // so no separate mutation-tool entries are added that could override the
    // task-scoped edit allows.
    edit: editRules,
    bash: { '*': 'deny' },
    grep: 'deny',
    search: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    question: 'deny',
  };
  const agent = {
    description:
      'Restricted executor for agent-loop; unspecified tools, shell, web, subagents, questions, external directories, and unscoped edits are denied.',
    mode: 'primary',
    model: config.opencode.model,
    permission,
  };
  if (config.opencode.variant) agent.variant = config.opencode.variant;
  // The iteration cap is a top-level AgentConfig field; agent.options carries
  // provider/model options only (maxTokens).
  agent.steps = config.opencode.maxStepsPerTask;
  if (config.opencode.maxOutputTokens > 0) agent.options = { maxTokens: config.opencode.maxOutputTokens };
  return {
    $schema: 'https://opencode.ai/config.json',
    permission,
    agent: { [config.opencode.agent]: agent },
  };
}

function planIsDurable(runDir, config) {
  try {
    planLib.loadPlan(runDir, config);
    return true;
  } catch {
    return false;
  }
}

function executionIsDurable(runDir, taskId, round) {
  return fs.existsSync(path.join(taskEvidenceDir(runDir, taskId), `execution-${round}.json`));
}

function checksAreDurable(runDir, taskId, round) {
  return fs.existsSync(path.join(taskEvidenceDir(runDir, taskId), `checks-${round}.json`));
}

function loadReviewDurable(runDir, taskId, round, answerCount) {
  const filePath = path.join(taskEvidenceDir(runDir, taskId), `review-${round}.json`);
  const review = readJsonIfExists(filePath);
  if (!review) return null;
  if (review.answerCount !== answerCount) return null;
  if (!['PASS', 'FIX', 'QUESTION'].includes(review.verdict)) return null;
  return review;
}

function addTokens(runDir, usage) {
  if (!usage || !usage.known) {
    throw new Error('addTokens requires known usage; unknown usage must stop for human action');
  }
  if (!usage.total) return;
  stateModule.patchState(runDir, (state) => ({ tokensUsed: state.tokensUsed + usage.total }));
}

function budgetExceeded(state, config) {
  return config.limits.maxTokenBudget > 0 && state.tokensUsed >= config.limits.maxTokenBudget;
}

function cliFailureQuestion(cliName, label, failure, evidenceDir, retried) {
  const evidence = `Inspect evidence in ${evidenceDir}.`;
  switch (failure.kind) {
    case 'auth':
      return (
        `${cliName} invocation "${label}" failed with an authentication or authorization error: ` +
        `${failure.detail}. ${evidence} Fix the CLI credentials or access, then answer to retry.`
      );
    case 'permission':
      return (
        `${cliName} invocation "${label}" failed with a permission error: ${failure.detail}. ` +
        `${evidence} Fix the permission problem, then answer to retry.`
      );
    case 'missing':
      return (
        `${cliName} invocation "${label}" could not start (missing executable or spawn failure): ` +
        `${failure.detail}. ${evidence} Install or fix the configured command, then answer to retry.`
      );
    case 'transient':
      return (
        `${cliName} invocation "${label}" failed with a transient error${
          retried ? ' again after the single allowed automatic retry was already used' : ''
        }: ${failure.detail}. ${evidence} Check the network/VPN/CLI health, then answer to retry.`
      );
    default:
      return (
        `${cliName} invocation "${label}" exited with code ${failure.exitCode} and an unrecognized error: ` +
        `${failure.detail}. ${evidence} Decide how to proceed, then answer to retry.`
      );
  }
}

async function invokeWithRecovery({ runDir, config }, options) {
  const { cliName, stageStatus, baseLabel, evidenceDir, invokeOnce } = options;
  let attempt = 0;
  while (true) {
    const label = attempt === 0 ? baseLabel : `${baseLabel}-retry${attempt}`;
    const state = stateModule.readState(runDir);
    const used = (state.transientRetries || {})[baseLabel] || 0;
    let result;
    try {
      result = await invokeOnce(label);
    } catch (err) {
      if (!(err instanceof invoke.InvokeError)) throw err;
      const detail = truncate(err.message, 800);
      stopForQuestion(runDir, {
        question:
          `${cliName} invocation "${label}" could not start: ${detail}. Inspect evidence in ${evidenceDir}. ` +
          'Fix the configured command or install the CLI, then answer to retry.',
        resumeStatus: stageStatus,
        kind: 'cli-missing',
      });
      return { stopped: true, kind: 'missing', detail };
    }
    if (result.timedOut || result.exitCode !== 0) {
      const failure = invoke.classifyCliFailure(result);
      const retried = used > 0;
      const failureUsage = invoke.parseUsage(result.stdout);
      if (failureUsage.known) addTokens(runDir, failureUsage);
      const latestState = stateModule.readState(runDir);
      const canRetry =
        failure.kind === 'transient' &&
        failureUsage.known &&
        used < config.limits.maxTransientRetries &&
        !budgetExceeded(latestState, config);
      if (canRetry) {
        stateModule.patchState(runDir, (current) => ({
          transientRetries: { ...current.transientRetries, [baseLabel]: used + 1 },
        }));
        events.appendEvent(runDir, 'CLI_RETRY', {
          cli: cliName,
          label,
          reason: truncate(failure.detail, 300),
        });
        attempt += 1;
        continue;
      }
      if (failure.kind === 'transient' && !failureUsage.known) {
        // The failed call may still have incurred provider cost that we cannot
        // account for, so an automatic retry could silently double it.
        stopForQuestion(runDir, {
          question:
            `${cliName} invocation "${label}" failed with a transient error and did not report token usage, so ` +
            `the failed call may have incurred unaccounted cost; it was not retried automatically: ` +
            `${failure.detail} Inspect evidence in ${evidenceDir}. Confirm how to proceed (including any ` +
            'unaccounted cost), then answer to retry.',
          resumeStatus: stageStatus,
          kind: 'cli-transient-unmetered',
        });
        return { stopped: true, kind: 'transient-unmetered', detail: failure.detail };
      }
      if (failure.kind === 'transient' && budgetExceeded(latestState, config)) {
        failRun(
          runDir,
          `token budget exhausted (${latestState.tokensUsed} >= ${config.limits.maxTokenBudget}) after a transient failure`
        );
        return { stopped: true, kind: 'budget', detail: failure.detail };
      }
      stopForQuestion(runDir, {
        question: cliFailureQuestion(cliName, label, failure, evidenceDir, retried),
        resumeStatus: stageStatus,
        kind: `cli-${failure.kind}`,
      });
      return { stopped: true, kind: failure.kind, detail: failure.detail };
    }
    const usage = invoke.parseUsage(result.stdout);
    if (!usage.known) {
      stopForQuestion(runDir, {
        question:
          `${cliName} invocation "${label}" finished but did not report token usage, so token accounting and ` +
          'budget enforcement would be incomplete (unknown usage is never treated as zero). Inspect evidence in ' +
          `${evidenceDir}; configure machine-readable output (claude.outputFormat "json" or the CLI's JSON ` +
          'output), then answer to continue.',
        resumeStatus: stageStatus,
        kind: 'usage',
      });
      return { stopped: true, kind: 'usage', detail: 'token usage was not reported' };
    }
    addTokens(runDir, usage);
    return { stopped: false, result, usage };
  }
}

function failRun(runDir, reason) {
  events.appendEvent(runDir, 'RUN_FAILED', { reason: truncate(reason, 2000) });
  return stateModule.setStatus(runDir, S.FAILED, { stopReason: truncate(reason, 4000) });
}

function stopForQuestion(runDir, { question, resumeStatus, kind = 'question' }) {
  const text = truncate(question, 4000);
  writeFileAtomic(path.join(runDir, 'QUESTION.md'), `# Question for human\n\n${text}\n`);
  events.appendEvent(runDir, 'NEEDS_HUMAN', { kind, resumeStatus, question: truncate(text, 500) });
  return stateModule.setStatus(runDir, S.NEEDS_HUMAN, {
    question: text,
    resumeStatus,
    stopKind: kind,
  });
}

const ACKNOWLEDGE_PREFIX = 'ACKNOWLEDGE:';

function requiresAcknowledgement(stopKind) {
  return stopKind === 'violation' || stopKind === 'audit';
}

function isAcknowledged(answerText) {
  return String(answerText).trimStart().startsWith(ACKNOWLEDGE_PREFIX);
}

function recordAnswer(runDir, answerText) {
  const current = stateModule.readState(runDir);
  if (current.status !== S.NEEDS_HUMAN) return current;
  if (!current.resumeStatus) throw new Error('NEEDS_HUMAN state is missing resumeStatus');
  const text = truncate(answerText, 8000);
  const answers = [...current.answers, { text, ts: nowIso(), resumeStatus: current.resumeStatus }].slice(-20);
  writeFileAtomic(path.join(runDir, `ANSWER-${answers.length}.md`), `# Human answer ${answers.length}\n\n${text}\n`);
  events.appendEvent(runDir, 'ANSWER_RECORDED', { number: answers.length, resumeStatus: current.resumeStatus });
  if (requiresAcknowledgement(current.stopKind) && !isAcknowledged(answerText)) {
    const question = truncate(
      `${current.question}\n\nThis answer did not release the gate: an acknowledgement must start with the ` +
        `literal prefix "ACKNOWLEDGE:" followed by your reasoning.`,
      4000
    );
    events.appendEvent(runDir, 'ACKNOWLEDGEMENT_REQUIRED', { number: answers.length, stopKind: current.stopKind });
    writeFileAtomic(path.join(runDir, 'QUESTION.md'), `# Question for human\n\n${question}\n`);
    return stateModule.patchState(runDir, () => ({ answers, question }));
  }
  const patch = { answers };
  if (current.stopKind === 'audit') patch.auditAcknowledged = true;
  if (current.stopKind === 'violation') patch.violationAcknowledged = true;
  return stateModule.setStatus(runDir, current.resumeStatus, patch);
}

async function invokeClaude({ runDir, config, packageRoot, kind, prompt, cwd, evidenceDir, label }) {
  const cli = config.claude;
  const args = ['-p'];
  if (cli.outputFormat === 'json') args.push('--output-format', 'json');
  args.push('--model', kind === 'plan' ? cli.planModel : cli.reviewModel);
  args.push('--permission-mode', cli.permissionMode);
  if (cli.allowedTools.length > 0) args.push('--allowedTools', cli.allowedTools.join(','));
  const disallowedTools = [...new Set([...cli.disallowedTools, 'AskUserQuestion'])];
  args.push('--disallowedTools', disallowedTools.join(','));
  args.push('--max-turns', String(cli.maxTurns));
  if (cli.maxBudgetUsd > 0) args.push('--max-budget-usd', String(cli.maxBudgetUsd));
  args.push(...cli.extraArgs);
  ensureDir(evidenceDir);
  writeFileAtomic(path.join(evidenceDir, `${label}.prompt.txt`), `${prompt}\n`);
  events.appendEvent(runDir, 'CLI_INVOCATION', { cli: 'claude', kind, label });
  stateModule.patchState(runDir, (state) => ({ invocations: state.invocations + 1 }));
  return invoke.runCommand({
    packageRoot,
    command: cli.command,
    argsPrefix: cli.argsPrefix,
    args,
    cwd,
    env: cli.env,
    unsetEnv: ['CLAUDECODE'],
    stdinText: prompt,
    timeoutMs: config.limits.commandTimeoutMs,
    evidenceDir,
    label,
  });
}

async function invokeOpencode({ runDir, config, packageRoot, task, prompt, cwd, evidenceDir, label }) {
  const cli = config.opencode;
  const args = ['run', '--agent', cli.agent, '-m', cli.model];
  if (cli.variant) args.push('--variant', cli.variant);
  args.push('--format', 'json');
  args.push(...cli.extraArgs);
  args.push(prompt);
  const overlay = buildOpenCodeOverlay(config, { taskFiles: task ? task.files : [] });
  const env = { ...cli.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay) };
  ensureDir(evidenceDir);
  writeFileAtomic(path.join(evidenceDir, `${label}.prompt.txt`), `${prompt}\n`);
  events.appendEvent(runDir, 'CLI_INVOCATION', { cli: 'opencode', label });
  stateModule.patchState(runDir, (state) => ({ invocations: state.invocations + 1 }));
  return invoke.runCommand({
    packageRoot,
    command: cli.command,
    argsPrefix: cli.argsPrefix,
    args,
    cwd,
    env,
    stdinText: '',
    timeoutMs: config.limits.commandTimeoutMs,
    evidenceDir,
    label,
  });
}

async function stepWorktree({ runDir, config }) {
  const current = stateModule.readState(runDir);
  if (!fs.existsSync(current.repo) || !git.isGitRepo(current.repo)) {
    throw new Error(`target repository is no longer a git checkout: ${current.repo}`);
  }
  const info = git.ensureWorktree(current.repo, current.worktree, current.branch);
  events.appendEvent(runDir, info.reused ? 'WORKTREE_REUSED' : 'WORKTREE_CREATED', {
    worktree: current.worktree,
    branch: current.branch,
    baseHead: current.baseHead,
  });
  writeFileAtomic(
    path.join(runDir, 'opencode.overlay.json'),
    `${JSON.stringify(buildOpenCodeOverlay(config), null, 2)}\n`
  );
  stateModule.setStatus(runDir, S.WORKTREE_READY);
}

async function stepPlan({ runDir, config, packageRoot }) {
  let current = stateModule.readState(runDir);
  if (planIsDurable(runDir, config)) {
    events.appendEvent(runDir, 'PLAN_LOADED', {});
    stateModule.setStatus(runDir, S.PLAN_READY);
    return;
  }
  if (current.planAttempts >= config.limits.maxPlanAttempts) {
    failRun(
      runDir,
      `plan validation failed after ${current.planAttempts} attempt(s): ${current.planFeedback || 'no feedback recorded'}`
    );
    return;
  }
  const attempt = current.planAttempts + 1;
  events.appendEvent(runDir, 'PLAN_ATTEMPT_STARTED', { attempt });
  const grill = skills.detectPlanningSkill({ repo: current.repo });
  events.appendEvent(runDir, 'PLAN_SKILL', grill ? { name: grill.name, path: grill.path } : { name: null });
  const prompt = prompts.buildPlanPrompt({
    request: readRequest(runDir),
    worktree: current.worktree,
    allowedCommands: config.verification.allowedCommands,
    allowedGlobs: config.constraints.allowedGlobs,
    maxTasks: config.limits.maxTasks,
    maxInstructionChars: config.limits.maxTaskInstructionChars,
    feedback: current.planFeedback,
    answers: current.answers,
    grill,
  });
  const evidenceDir = planningEvidenceDir(runDir);
  const outcome = await invokeWithRecovery(
    { runDir, config },
    {
      cliName: 'claude',
      stageStatus: S.PLANNING,
      baseLabel: `plan-attempt-${attempt}`,
      evidenceDir,
      invokeOnce: (label) =>
        invokeClaude({
          runDir,
          config,
          packageRoot,
          kind: 'plan',
          prompt,
          cwd: current.worktree,
          evidenceDir,
          label,
        }),
    }
  );
  if (outcome.stopped) return;
  const parsed = planLib.parsePlanResponse(outcome.result.stdout);
  if (parsed.kind === 'QUESTION') {
    stopForQuestion(runDir, { question: parsed.question, resumeStatus: S.PLANNING });
    return;
  }
  if (parsed.kind === 'INVALID') {
    stopForQuestion(runDir, {
      question:
        `Planner output was ambiguous (${parsed.error}). Excerpt: ${truncate(parsed.excerpt, 300)}. ` +
        `Inspect evidence in ${evidenceDir}, then answer to re-plan.`,
      resumeStatus: S.PLANNING,
      kind: 'ambiguous',
    });
    return;
  }
  const validation = planLib.validatePlan(parsed.plan, config);
  if (!validation.ok) {
    const feedback = validation.errors.join('; ');
    stateModule.patchState(runDir, () => ({
      planAttempts: attempt,
      planFeedback: truncate(feedback, 4000),
    }));
    events.appendEvent(runDir, 'PLAN_REJECTED', { attempt, errors: validation.errors.slice(0, 20) });
    return;
  }
  planLib.writePlanArtifacts(runDir, validation.plan);
  stateModule.patchState(runDir, () => ({ planFeedback: null }));
  events.appendEvent(runDir, 'PLAN_WRITTEN', { tasks: validation.plan.tasks.length });
  stateModule.setStatus(runDir, S.PLAN_READY);
}

async function runTaskExecution({ runDir, config, packageRoot }, task, round, fix) {
  const current = stateModule.readState(runDir);
  const dir = taskEvidenceDir(runDir, task.id);
  events.appendEvent(runDir, fix ? 'TASK_FIX_STARTED' : 'TASK_EXECUTION_STARTED', { taskId: task.id, round });
  const prompt = prompts.buildExecutionPrompt({
    task,
    worktree: current.worktree,
    fix,
    answers: current.answers,
  });
  const outcome = await invokeWithRecovery(
    { runDir, config },
    {
      cliName: 'opencode',
      stageStatus: fix ? S.TASK_FIXING : S.TASK_RUNNING,
      baseLabel: `execution-${round}`,
      evidenceDir: dir,
      invokeOnce: (label) =>
        invokeOpencode({
          runDir,
          config,
          packageRoot,
          task,
          prompt,
          cwd: current.worktree,
          evidenceDir: dir,
          label,
        }),
    }
  );
  if (outcome.stopped) {
    writeFileAtomic(
      path.join(dir, `execution-${round}.failure.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          taskId: task.id,
          round,
          fix: Boolean(fix),
          stopped: true,
          kind: outcome.kind,
          detail: truncate(outcome.detail || '', 2000),
          ts: nowIso(),
        },
        null,
        2
      )}\n`
    );
    return { stopped: true };
  }
  const result = outcome.result;
  const record = {
    schemaVersion: 1,
    taskId: task.id,
    round,
    fix: Boolean(fix),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    usage: outcome.usage,
    ts: nowIso(),
  };
  writeFileAtomic(path.join(dir, `execution-${round}.json`), `${JSON.stringify(record, null, 2)}\n`);
  events.appendEvent(runDir, 'TASK_EXECUTION_DONE', {
    taskId: task.id,
    round,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  return { stopped: false, record };
}

async function runChecks({ runDir, config, packageRoot }, task, round) {
  const current = stateModule.readState(runDir);
  const dir = taskEvidenceDir(runDir, task.id);
  ensureDir(dir);
  const results = [];
  for (let index = 0; index < task.checks.length; index += 1) {
    const command = task.checks[index];
    const argv = invoke.splitCommandArgs(command);
    const label = `checks-${round}-${index}`;
    stateModule.patchState(runDir, (state) => ({ invocations: state.invocations + 1 }));
    const result = await invoke.runCommand({
      packageRoot,
      mode: 'direct',
      command: argv[0],
      argsPrefix: [],
      args: argv.slice(1),
      cwd: current.worktree,
      env: {},
      stdinText: '',
      timeoutMs: config.limits.commandTimeoutMs,
      evidenceDir: dir,
      label,
    });
    results.push({
      index,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutFile: path.basename(result.stdoutPath),
      stderrFile: path.basename(result.stderrPath),
      passed: result.exitCode === 0 && !result.timedOut,
    });
  }
  const record = {
    schemaVersion: 1,
    taskId: task.id,
    round,
    ts: nowIso(),
    results,
    allPassed: results.every((entry) => entry.passed),
  };
  writeFileAtomic(path.join(dir, `checks-${round}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const logLines = [`# Checks for ${task.id} (round ${round})`, ''];
  for (const entry of results) {
    logLines.push(`- [${entry.passed ? 'PASS' : 'FAIL'}] ${entry.command} (exit ${entry.exitCode}${entry.timedOut ? ', timed out' : ''})`);
  }
  writeFileAtomic(path.join(dir, `checks-${round}.log`), `${logLines.join('\n')}\n`);
  events.appendEvent(runDir, 'CHECKS_DONE', { taskId: task.id, round, allPassed: record.allPassed });
  return record;
}

async function stepRunTask(ctx) {
  const { runDir, config } = ctx;
  const current = stateModule.readState(runDir);
  const plan = planLib.loadPlan(runDir, config);
  const task = plan.tasks[current.taskIndex];
  if (!task) throw new Error(`task index ${current.taskIndex} is out of range`);
  const round = current.fixCounts[task.id] || 0;
  if (!executionIsDurable(runDir, task.id, round)) {
    const outcome = await runTaskExecution(ctx, task, round, null);
    if (outcome.stopped) return;
  }
  if (!checksAreDurable(runDir, task.id, round)) {
    await runChecks(ctx, task, round);
  }
  stateModule.setStatus(runDir, S.TASK_REVIEWING);
}

async function stepReview(ctx) {
  const { runDir, config, packageRoot } = ctx;
  const current = stateModule.readState(runDir);
  const plan = planLib.loadPlan(runDir, config);
  const task = plan.tasks[current.taskIndex];
  if (!task) throw new Error(`task index ${current.taskIndex} is out of range`);
  const round = current.fixCounts[task.id] || 0;
  let review = loadReviewDurable(runDir, task.id, round, current.answers.length);
  if (!review) {
    const dir = taskEvidenceDir(runDir, task.id);
    const execution = readJsonFile(path.join(dir, `execution-${round}.json`), 'execution');
    const checks = readJsonFile(path.join(dir, `checks-${round}.json`), 'checks');
    const priorReview = round > 0 ? readJsonIfExists(path.join(dir, `review-${round - 1}.json`)) : null;
    const diff = git.worktreeDiff(current.worktree);
    const evidenceSize = diff.text.length + diff.stat.length;
    if (evidenceSize > config.limits.maxReviewEvidenceChars) {
      stopForQuestion(runDir, {
        question:
          `Diff evidence for task ${task.id} is too large (${evidenceSize} characters, limit ` +
          `${config.limits.maxReviewEvidenceChars}); review it manually in ${current.worktree}.`,
        resumeStatus: S.TASK_REVIEWING,
      });
      return;
    }
    const declaredFiles = new Set(task.files);
    const changedFiles = diff.files;
    const fileViolations = changedFiles.filter((file) => !declaredFiles.has(file));
    const prompt = prompts.buildReviewPrompt({
      summary: plan.summary,
      task,
      worktree: current.worktree,
      diffStat: diff.stat,
      diff: diff.text,
      execution,
      checks,
      priorReview,
      answers: current.answers,
      maxEvidenceChars: config.limits.maxReviewEvidenceChars,
      changedFiles,
      fileViolations,
    });
    const outcome = await invokeWithRecovery(
      { runDir, config },
      {
        cliName: 'claude',
        stageStatus: S.TASK_REVIEWING,
        baseLabel: `review-${round}`,
        evidenceDir: dir,
        invokeOnce: (label) =>
          invokeClaude({
            runDir,
            config,
            packageRoot,
            kind: 'review',
            prompt,
            cwd: current.worktree,
            evidenceDir: dir,
            label,
          }),
      }
    );
    if (outcome.stopped) return;
    const parsed = reviewLib.parseReviewResponse(outcome.result.stdout);
    let verdict;
    let notes = '';
    let question = null;
    let questionKind = null;
    if (parsed.kind === 'PASS' || parsed.kind === 'FIX') {
      verdict = parsed.kind;
      notes = parsed.notes;
    } else if (parsed.kind === 'QUESTION') {
      verdict = 'QUESTION';
      notes = parsed.notes || '';
      question = parsed.question;
      questionKind = 'reviewer';
    } else {
      verdict = 'QUESTION';
      question = `Reviewer output was ambiguous; manual review required. ${parsed.detail}. Excerpt: ${truncate(parsed.excerpt, 300)}`;
      questionKind = 'reviewer';
    }
    if (verdict === 'PASS' && fileViolations.length > 0) {
      if (current.violationAcknowledged) {
        notes = `${notes}\n[agent-loop] Human acknowledged undeclared changes: ${fileViolations.join(', ')}`;
      } else {
        verdict = 'QUESTION';
        question =
          `The reviewed diff for task ${task.id} touches undeclared files: ${fileViolations.join(', ')} ` +
          `(declared: ${task.files.length > 0 ? task.files.join(', ') : 'none'}). Have the executor FIX this ` +
          'or answer to acknowledge these changes for this task.';
        questionKind = 'violation';
      }
    }
    review = {
      schemaVersion: 1,
      taskId: task.id,
      round,
      verdict,
      notes,
      question,
      questionKind,
      changedFiles,
      fileViolations,
      answerCount: current.answers.length,
      ts: nowIso(),
    };
    writeFileAtomic(path.join(dir, `review-${round}.json`), `${JSON.stringify(review, null, 2)}\n`);
    events.appendEvent(runDir, 'REVIEW_DONE', { taskId: task.id, round, verdict });
  }
  if (review.verdict === 'PASS') {
    events.appendEvent(runDir, 'TASK_PASSED', { taskId: task.id, round });
    stateModule.setStatus(runDir, S.TASK_DONE);
    return;
  }
  if (review.verdict === 'FIX') {
    if (round >= config.limits.maxFixPerTask) {
      failRun(
        runDir,
        `task ${task.id}: fix retry exhausted after ${round} repair cycle(s); reviewer notes: ${truncate(
          review.notes,
          600
        )}`
      );
      return;
    }
    stateModule.patchState(runDir, (state) => ({
      fixCounts: { ...state.fixCounts, [task.id]: round + 1 },
    }));
    events.appendEvent(runDir, 'TASK_FIX_REQUESTED', {
      taskId: task.id,
      round: round + 1,
      notes: truncate(review.notes, 500),
    });
    stateModule.setStatus(runDir, S.TASK_FIXING);
    return;
  }
  stopForQuestion(runDir, {
    question: review.question,
    resumeStatus: S.TASK_REVIEWING,
    kind: review.questionKind === 'violation' ? 'violation' : 'question',
  });
}

async function stepFix(ctx) {
  const { runDir, config } = ctx;
  const current = stateModule.readState(runDir);
  const plan = planLib.loadPlan(runDir, config);
  const task = plan.tasks[current.taskIndex];
  if (!task) throw new Error(`task index ${current.taskIndex} is out of range`);
  const round = current.fixCounts[task.id] || 0;
  if (round < 1) throw new Error(`TASK_FIXING without a fix round for task ${task.id}`);
  if (!executionIsDurable(runDir, task.id, round)) {
    const dir = taskEvidenceDir(runDir, task.id);
    const priorReview = readJsonIfExists(path.join(dir, `review-${round - 1}.json`));
    const priorChecks = readJsonIfExists(path.join(dir, `checks-${round - 1}.json`));
    const failedChecks =
      priorChecks && Array.isArray(priorChecks.results) ? priorChecks.results.filter((entry) => !entry.passed) : [];
    const outcome = await runTaskExecution(ctx, task, round, {
      reviewNotes: priorReview ? priorReview.notes : '',
      failedChecks,
    });
    if (outcome.stopped) return;
  }
  if (!checksAreDurable(runDir, task.id, round)) {
    await runChecks(ctx, task, round);
  }
  stateModule.setStatus(runDir, S.TASK_REVIEWING);
}

function writeSelfReport(runDir, plan, audit, problems) {
  const current = stateModule.readState(runDir);
  const lines = [];
  lines.push('# agent-loop self report');
  lines.push('');
  lines.push(`- Run id: ${current.runId}`);
  lines.push('- Status: COMPLETE');
  lines.push(`- Repository: ${current.repo}`);
  lines.push(`- Isolated worktree: ${current.worktree}`);
  lines.push(`- Branch: ${current.branch} (base ${current.baseHead})`);
  lines.push(`- Tokens accounted: ${current.tokensUsed}`);
  lines.push(`- CLI invocations: ${current.invocations}`);
  lines.push('');
  lines.push('## Tasks');
  for (const task of plan.tasks) {
    const dir = taskEvidenceDir(runDir, task.id);
    const reviews = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((file) => /^review-\d+\.json$/.test(file))
          .sort()
      : [];
    const finalReview = reviews.length > 0 ? readJsonIfExists(path.join(dir, reviews[reviews.length - 1])) : null;
    lines.push(
      `- ${task.id}: ${task.title} - verdict: ${finalReview ? finalReview.verdict : 'unknown'} (rounds reviewed: ${
        reviews.length
      })`
    );
  }
  lines.push('');
  lines.push('## Safety');
  lines.push('- No git commit, push, or merge was performed by the loop.');
  lines.push(`- Primary repository HEAD: ${audit.primaryHead} (base was ${current.baseHead})`);
  lines.push(`- Worktree HEAD: ${audit.worktreeHead}; new commits: ${audit.newCommits}`);
  if (problems.length > 0) {
    lines.push(`- Audit problems acknowledged by human: ${problems.join('; ')}`);
  }
  lines.push('');
  lines.push('## Isolation limitations');
  lines.push('- A git worktree is not an OS sandbox. Model-driven processes run with your user account and can read');
  lines.push('  or write outside the worktree through shell commands. Use containers or a dedicated OS user for');
  lines.push('  untrusted tasks. Changes are left uncommitted in the worktree for human review.');
  lines.push('');
  writeFileAtomic(path.join(finalEvidenceDir(runDir), 'SELF-REPORT.md'), lines.join('\n'));
}

function finalize(ctx, plan) {
  const { runDir } = ctx;
  const current = stateModule.readState(runDir);
  const audit = { primaryHead: null, primaryClean: null, worktreeHead: null, newCommits: null };
  const problems = [];
  try {
    audit.primaryHead = git.headSha(current.repo);
    audit.primaryClean = git.isClean(current.repo);
    audit.worktreeHead = git.headSha(current.worktree);
    audit.newCommits = git.countCommitsBetween(current.baseHead, current.worktree);
  } catch (err) {
    problems.push(`audit could not be completed: ${err.message}`);
  }
  if (audit.primaryHead && audit.primaryHead !== current.baseHead) {
    problems.push(`primary repository HEAD changed (${current.baseHead} -> ${audit.primaryHead})`);
  }
  if (audit.primaryClean === false) {
    problems.push('primary repository working tree is not clean');
  }
  if (audit.worktreeHead && audit.worktreeHead !== current.baseHead) {
    problems.push(
      `isolated worktree has ${audit.newCommits} new commit(s); completion stops before commit/push/merge`
    );
  }
  writeFileAtomic(
    path.join(finalEvidenceDir(runDir), 'AUDIT.json'),
    `${JSON.stringify({ ...audit, problems, ts: nowIso() }, null, 2)}\n`
  );
  if (problems.length > 0 && !current.auditAcknowledged) {
    stopForQuestion(runDir, {
      question:
        `Repository safety audit failed: ${problems.join('; ')}. Inspect the evidence and answer to ` +
        'acknowledge before the run can complete.',
      resumeStatus: S.TASK_DONE,
      kind: 'audit',
    });
    return;
  }
  writeSelfReport(runDir, plan, audit, problems);
  events.appendEvent(runDir, 'RUN_COMPLETED', {
    tasks: plan.tasks.length,
    tokensUsed: current.tokensUsed,
    invocations: current.invocations,
  });
  stateModule.setStatus(runDir, S.COMPLETE, { stopReason: 'complete' });
}

function stepTaskDone(ctx) {
  const { runDir, config } = ctx;
  const current = stateModule.readState(runDir);
  const plan = planLib.loadPlan(runDir, config);
  const task = plan.tasks[current.taskIndex];
  if (!task) throw new Error(`task index ${current.taskIndex} is out of range`);
  events.appendEvent(runDir, 'TASK_COMPLETED', { taskId: task.id });
  if (current.taskIndex + 1 < plan.tasks.length) {
    stateModule.patchState(runDir, (state) => ({ taskIndex: state.taskIndex + 1, violationAcknowledged: false }));
    stateModule.setStatus(runDir, S.TASK_RUNNING);
    return;
  }
  finalize(ctx, plan);
}

async function runLoop(context) {
  const { runDir, config } = context;
  let state = stateModule.readState(runDir);
  if (state.status === S.NEEDS_HUMAN && context.answer !== undefined && context.answer !== null) {
    state = recordAnswer(runDir, context.answer);
  }
  while (true) {
    state = stateModule.readState(runDir);
    if (stateModule.isTerminal(state.status) || state.status === S.NEEDS_HUMAN) return state;
    if (budgetExceeded(state, config)) {
      failRun(runDir, `token budget exhausted (${state.tokensUsed} >= ${config.limits.maxTokenBudget})`);
      continue;
    }
    try {
      switch (state.status) {
        case S.CREATED:
          await stepWorktree(context);
          break;
        case S.WORKTREE_READY:
          events.appendEvent(runDir, 'PLANNING_STARTED', {});
          stateModule.setStatus(runDir, S.PLANNING);
          break;
        case S.PLANNING:
          await stepPlan(context);
          break;
        case S.PLAN_READY:
          stateModule.setStatus(runDir, S.TASK_RUNNING);
          break;
        case S.TASK_RUNNING:
          await stepRunTask(context);
          break;
        case S.TASK_REVIEWING:
          await stepReview(context);
          break;
        case S.TASK_FIXING:
          await stepFix(context);
          break;
        case S.TASK_DONE:
          stepTaskDone(context);
          break;
        default:
          throw new Error(`unhandled status: ${state.status}`);
      }
    } catch (err) {
      if (err instanceof stateModule.StateError) throw err;
      const message = err && err.message ? err.message : String(err);
      const stack = err && err.stack ? truncate(err.stack, 2000) : '';
      events.appendEvent(runDir, 'RUN_ERROR', {
        status: state.status,
        message: truncate(message, 2000),
        stack,
      });
      failRun(runDir, `unexpected error during ${state.status}: ${truncate(message, 1500)}`);
    }
  }
}

module.exports = {
  ACKNOWLEDGE_PREFIX,
  buildOpenCodeOverlay,
  isAcknowledged,
  requiresAcknowledgement,
  recordAnswer,
  failRun,
  stopForQuestion,
  readRequest,
  runLoop,
};
