#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, makeRunId, nowIso, readJsonFile, writeFileAtomic } = require('./lib/util');
const stateModule = require('./lib/state');
const events = require('./lib/events');
const git = require('./lib/git');
const { ConfigError, loadConfig } = require('./lib/config');
const { LockError, acquireLock } = require('./lib/lock');
const { runLoop } = require('./lib/orchestrator');
const { InvokeError, resolveExecutable } = require('./lib/invoke');

const PACKAGE_ROOT = __dirname;
const S = stateModule.STATUS;
const PACKAGE_JSON = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'), 'package.json');

class UsageError extends Error {}
class AppError extends Error {}

const USAGE = `agent-loop - requirement-to-tasks loop driven by Claude Code (plan/review) and OpenCode (execution)

Usage:
  node agent-loop.js start  --repo <path> (--request <text> | --request-file <path>) [--config <path>]
  node agent-loop.js resume --run <run-dir> [--answer <text> | --answer-file <path>] [--config <path>]
  node agent-loop.js status --run <run-dir>
  node agent-loop.js --self-check
  node agent-loop.js --version

Notes:
  - start validates a clean git checkout, creates a run under <git-common-dir>/agent-loop/runs,
    creates an isolated worktree, then plans/executes/reviews until COMPLETE, NEEDS_HUMAN, or FAILED.
  - resume continues an interrupted run or records a human answer. The same --config value used
    for start must be supplied again when the run uses a custom config.
  - When a stop requires acknowledging unintended git changes (violation or safety audit), the
    answer must start with the literal prefix "ACKNOWLEDGE:" before the runner continues.
  - The loop never commits, pushes, or merges; changes stay uncommitted in the worktree.

Exit codes:
  0 success (COMPLETE / status / self-check ok)
  2 stopped (FAILED or precondition/lock failure)
  3 NEEDS_HUMAN (question pending; resume with --answer)
  4 usage or configuration error
  5 self-check failed`;

function parseArgs(argv) {
  if (argv.length === 0) return { command: 'help', opts: {} };
  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') return { command: 'help', opts: {} };
  if (first === '--version' || first === 'version') return { command: 'version', opts: {} };
  if (first === '--self-check' || first === 'self-check') return { command: 'self-check', opts: {} };
  if (!['start', 'resume', 'status'].includes(first)) {
    throw new UsageError(`unknown command "${first}"`);
  }
  const valueOptions = ['repo', 'request', 'request-file', 'config', 'run', 'answer', 'answer-file'];
  const opts = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument "${arg}"`);
    const key = arg.slice(2);
    if (!valueOptions.includes(key)) throw new UsageError(`unknown option "${arg}"`);
    if (i + 1 >= argv.length) throw new UsageError(`option ${arg} requires a value`);
    opts[key] = argv[i + 1];
    i += 1;
  }
  return { command: first, opts };
}

function readTextFile(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AppError(`cannot read ${label} ${filePath}: ${err.message}`);
  }
}

function resolveRequestText(opts) {
  if (opts.request !== undefined && opts['request-file'] !== undefined) {
    throw new UsageError('use either --request or --request-file, not both');
  }
  if (opts.request === undefined && opts['request-file'] === undefined) {
    throw new UsageError('start requires --request or --request-file');
  }
  const text = opts.request !== undefined ? opts.request : readTextFile(opts['request-file'], 'request file');
  if (!text.trim()) throw new UsageError('request must not be empty');
  if (text.length > 50000) throw new UsageError('request is too long (max 50000 characters)');
  return text;
}

function resolveAnswer(opts) {
  if (opts.answer !== undefined && opts['answer-file'] !== undefined) {
    throw new UsageError('use either --answer or --answer-file, not both');
  }
  if (opts.answer !== undefined) {
    if (!opts.answer.trim()) throw new UsageError('answer must not be empty');
    return opts.answer;
  }
  if (opts['answer-file'] !== undefined) {
    const text = readTextFile(opts['answer-file'], 'answer file');
    if (!text.trim()) throw new UsageError('answer file is empty');
    return text;
  }
  return undefined;
}

function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const section of ['claude', 'opencode']) {
    if (copy[section] && copy[section].env) {
      copy[section].env = Object.fromEntries(Object.keys(copy[section].env).map((key) => [key, '<redacted>']));
    }
  }
  return copy;
}

function printState(state) {
  const summary = {
    runId: state.runId,
    status: state.status,
    taskIndex: state.taskIndex,
    tokensUsed: state.tokensUsed,
    invocations: state.invocations,
    question: state.question || null,
    stopReason: state.stopReason || null,
    runDir: state.runDir,
    worktree: state.worktree,
    branch: state.branch,
  };
  console.log(`agent-loop run ${state.runId}: ${state.status}`);
  if (state.status === S.NEEDS_HUMAN && state.question) {
    console.log(`question: ${state.question}`);
    if (state.stopKind === 'violation' || state.stopKind === 'audit') {
      console.log(
        'this stop requires an acknowledgement: the answer must start with the literal prefix "ACKNOWLEDGE:"'
      );
    }
    console.log(`resume with: node agent-loop.js resume --run "${state.runDir}" --answer "<your answer>"`);
  }
  if (state.status === S.FAILED && state.stopReason) {
    console.log(`stop reason: ${state.stopReason}`);
  }
  console.log(`run dir: ${state.runDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

function exitCodeFor(status) {
  if (status === S.COMPLETE) return 0;
  if (status === S.NEEDS_HUMAN) return 3;
  return 2;
}

async function commandStart(opts) {
  if (!opts.repo) throw new UsageError('start requires --repo <path>');
  const config = loadConfig(opts.config);
  const request = resolveRequestText(opts);
  const repo = path.resolve(opts.repo);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw new AppError(`repository path does not exist: ${repo}`);
  }
  if (!git.isGitRepo(repo)) {
    throw new AppError(`target is not a git checkout: ${repo}`);
  }
  if (!git.isClean(repo)) {
    throw new AppError(`target checkout is dirty; commit or stash changes before running: ${repo}`);
  }
  const common = git.commonDir(repo);
  const baseHead = git.headSha(repo);
  const runId = makeRunId();
  const runDir = path.join(common, 'agent-loop', 'runs', runId);
  const worktree = path.join(common, 'agent-loop', 'worktrees', runId);
  const branch = `agent-loop/${runId}`;
  ensureDir(runDir);
  writeFileAtomic(path.join(runDir, 'REQUEST.md'), request);
  writeFileAtomic(path.join(runDir, 'config.redacted.json'), `${JSON.stringify(redactConfig(config), null, 2)}\n`);
  const state = stateModule.createState({
    runId,
    repo,
    commonDir: common,
    runDir,
    worktree,
    branch,
    baseHead,
    createdUtc: nowIso(),
  });
  stateModule.writeState(runDir, state);
  events.appendEvent(runDir, 'RUN_CREATED', { repo, baseHead, branch });
  const lock = acquireLock(runDir);
  let final;
  try {
    final = await runLoop({ runDir, config, packageRoot: PACKAGE_ROOT });
  } finally {
    lock.release();
  }
  printState(final);
  return exitCodeFor(final.status);
}

async function commandResume(opts) {
  if (!opts.run) throw new UsageError('resume requires --run <run directory>');
  const runDir = path.resolve(opts.run);
  if (!fs.existsSync(path.join(runDir, 'STATE.json'))) {
    throw new AppError(`no run found at ${runDir} (STATE.json missing)`);
  }
  const answer = resolveAnswer(opts);
  let state = stateModule.readState(runDir);
  if (stateModule.isTerminal(state.status)) {
    printState(state);
    return exitCodeFor(state.status);
  }
  if (state.status === S.NEEDS_HUMAN && answer === undefined) {
    printState(state);
    return 3;
  }
  const config = loadConfig(opts.config);
  const lock = acquireLock(runDir);
  let final;
  try {
    final = await runLoop({ runDir, config, packageRoot: PACKAGE_ROOT, answer });
  } finally {
    lock.release();
  }
  state = final;
  printState(state);
  return exitCodeFor(state.status);
}

function commandStatus(opts) {
  if (!opts.run) throw new UsageError('status requires --run <run directory>');
  const runDir = path.resolve(opts.run);
  const state = stateModule.readState(runDir);
  printState(state);
  return 0;
}

function checkReachable() {
  const transitions = stateModule.TRANSITIONS;
  const statuses = Object.values(S);
  for (const status of statuses) {
    if (!Object.prototype.hasOwnProperty.call(transitions, status)) {
      throw new Error(`transition table missing status ${status}`);
    }
  }
  for (const terminal of stateModule.TERMINAL) {
    if ((transitions[terminal] || []).length !== 0) {
      throw new Error(`terminal status ${terminal} has outgoing transitions`);
    }
  }
  const seen = new Set([S.CREATED]);
  const queue = [S.CREATED];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of transitions[current] || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const unreachable = statuses.filter((status) => !seen.has(status));
  if (unreachable.length > 0) {
    throw new Error(`unreachable statuses: ${unreachable.join(', ')}`);
  }
  return `${statuses.length} statuses consistent`;
}

function commandSelfCheck() {
  const checks = [];
  const add = (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: fn() || null });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  };

  add('node-version', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (major < 18) throw new Error(`Node >= 18 required, found ${process.versions.node}`);
    return process.versions.node;
  });
  add('required-files', () => {
    const required = [
      'agent-loop.js',
      'package.json',
      'config.example.json',
      'install.ps1',
      'README.md',
      'scripts/invoke-cli.ps1',
      '.claude/skills/agent-loop/SKILL.md',
      'lib/config.js',
      'lib/events.js',
      'lib/git.js',
      'lib/invoke.js',
      'lib/lock.js',
      'lib/orchestrator.js',
      'lib/paths.js',
      'lib/plan.js',
      'lib/prompts.js',
      'lib/review.js',
      'lib/skills.js',
      'lib/state.js',
      'lib/util.js',
      'test/core.test.js',
      'test/installer.test.js',
      'test/integration.test.js',
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(PACKAGE_ROOT, file)));
    if (missing.length > 0) throw new Error(`missing package files: ${missing.join(', ')}`);
    return `${required.length} files present`;
  });
  add('config-example', () => {
    loadConfig(path.join(PACKAGE_ROOT, 'config.example.json'));
    return 'config.example.json validates';
  });
  add('state-machine', () => checkReachable());
  add('git-executable', () => resolveExecutable('git'));
  if (process.platform === 'win32') {
    add('powershell-executable', () => resolveExecutable('powershell'));
    add('process-adapter', () => {
      if (!fs.existsSync(path.join(PACKAGE_ROOT, 'scripts', 'invoke-cli.ps1'))) {
        throw new Error('scripts/invoke-cli.ps1 missing');
      }
      return 'scripts/invoke-cli.ps1 present';
    });
  }

  const ok = checks.every((check) => check.ok);
  console.log(
    JSON.stringify(
      {
        ok,
        packageRoot: PACKAGE_ROOT,
        platform: process.platform,
        node: process.versions.node,
        checks,
      },
      null,
      2
    )
  );
  return ok ? 0 : 5;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  switch (parsed.command) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'version':
      console.log(PACKAGE_JSON.version);
      return 0;
    case 'self-check':
      return commandSelfCheck();
    case 'start':
      return commandStart(parsed.opts);
    case 'resume':
      return commandResume(parsed.opts);
    case 'status':
      return commandStatus(parsed.opts);
    default:
      console.error(USAGE);
      return 4;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof UsageError || err instanceof ConfigError) {
      console.error(`agent-loop: ${err.message}`);
      console.error('run "node agent-loop.js --help" for usage');
      process.exitCode = 4;
    } else if (err instanceof LockError) {
      console.error(`agent-loop: ${err.message}`);
      process.exitCode = 2;
    } else if (err instanceof AppError || err instanceof InvokeError) {
      console.error(`agent-loop: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`agent-loop: unexpected error: ${err && err.stack ? err.stack : err}`);
      process.exitCode = 2;
    }
  });
