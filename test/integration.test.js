'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PACKAGE_ROOT, 'agent-loop.js');

const FAKE_CLAUDE_SOURCE = `'use strict';
const fs = require('fs');
const seqFile = process.env.FAKE_CLAUDE_SEQ;
const responsesFile = process.env.FAKE_CLAUDE_RESPONSES;
const logFile = process.env.FAKE_CLAUDE_LOG;
let seq = 0;
try { seq = Number(fs.readFileSync(seqFile, 'utf8')) || 0; } catch (err) { seq = 0; }
const responses = JSON.parse(fs.readFileSync(responsesFile, 'utf8'));
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (err) { stdin = ''; }
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ seq, args: process.argv.slice(2), stdin, claudecode: process.env.CLAUDECODE ?? null }) + '\\n');
fs.writeFileSync(seqFile, String(seq + 1));
const response = responses[Math.min(seq, responses.length - 1)];
if (response.fail) {
  const detail = typeof response.fail === 'string' ? response.fail : (response.fail.stderr || 'simulated claude failure');
  process.stderr.write(detail + '\\n');
  if (typeof response.fail === 'object' && response.fail.stdout) process.stdout.write(response.fail.stdout + '\\n');
  process.exit(typeof response.fail === 'object' && response.fail.exitCode ? response.fail.exitCode : 1);
}
const usage = response.usage !== undefined ? response.usage : { input_tokens: 11, output_tokens: 7 };
const text = response.raw !== undefined ? response.raw : JSON.stringify(response.value);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text, usage }) + '\\n');
`;

const FAKE_OPENCODE_SOURCE = `'use strict';
const fs = require('fs');
const path = require('path');
const seqFile = process.env.FAKE_OPENCODE_SEQ;
const modesFile = process.env.FAKE_OPENCODE_MODES;
const logFile = process.env.FAKE_OPENCODE_LOG;
let seq = 0;
try { seq = Number(fs.readFileSync(seqFile, 'utf8')) || 0; } catch (err) { seq = 0; }
const modes = JSON.parse(fs.readFileSync(modesFile, 'utf8'));
const args = process.argv.slice(2);
let agentSteps = null;
let agentOptions = null;
try {
  const overlay = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || 'null');
  if (overlay && overlay.agent) {
    const first = Object.values(overlay.agent)[0];
    if (first) {
      if (first.steps !== undefined) agentSteps = first.steps;
      if (first.options) agentOptions = first.options;
    }
  }
} catch (err) {
  agentSteps = null;
  agentOptions = null;
}
if (logFile) fs.appendFileSync(logFile, JSON.stringify({ seq, args, cwd: process.cwd(), steps: agentSteps, options: agentOptions }) + '\\n');
fs.writeFileSync(seqFile, String(seq + 1));
const mode = modes[Math.min(seq, modes.length - 1)] || {};
if (mode.fail) {
  const detail = typeof mode.fail === 'string' ? mode.fail : (mode.fail.stderr || 'simulated failure');
  process.stderr.write(detail + '\\n');
  process.exit(typeof mode.fail === 'object' && mode.fail.exitCode ? mode.fail.exitCode : 3);
}
const writes = Array.isArray(mode.writes) ? mode.writes : (mode.write ? [mode.write] : []);
for (const target of writes) fs.writeFileSync(path.resolve(process.cwd(), target), mode.content || 'ok\\n');
if (mode.commit) {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'simulated commit'], { cwd: process.cwd() });
}
if (Array.isArray(mode.events)) {
  for (const event of mode.events) process.stdout.write(JSON.stringify(event) + '\\n');
} else {
  const usage = mode.usage !== undefined ? mode.usage : { input_tokens: 5, output_tokens: 3 };
  process.stdout.write(JSON.stringify({ usage }) + '\\n');
}
`;

const VERIFY_SOURCE = `'use strict';
const fs = require('fs');
if (!fs.existsSync('made.txt')) {
  console.error('made.txt is missing');
  process.exit(1);
}
console.log('verification ok');
`;

function safeRemove(dir) {
  if (process.env.AGENT_LOOP_KEEP) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function makeScenario(label, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-loop-it-${label}-`));
  if (process.env.AGENT_LOOP_KEEP) console.error(`scenario root: ${root}`);
  const repo = path.join(root, 'target repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# target\n');
  fs.writeFileSync(path.join(repo, 'verify.js'), VERIFY_SOURCE);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

  const fakesDir = path.join(root, 'fakes');
  fs.mkdirSync(fakesDir, { recursive: true });
  const fakeClaude = path.join(fakesDir, 'fake-claude.js');
  const fakeOpencode = path.join(fakesDir, 'fake-opencode.js');
  fs.writeFileSync(fakeClaude, FAKE_CLAUDE_SOURCE);
  fs.writeFileSync(fakeOpencode, FAKE_OPENCODE_SOURCE);

  const responsesFile = path.join(root, 'claude-responses.json');
  const modesFile = path.join(root, 'opencode-modes.json');
  fs.writeFileSync(responsesFile, JSON.stringify(options.responses, null, 2));
  fs.writeFileSync(modesFile, JSON.stringify(options.modes || [], null, 2));

  const paths = {
    root,
    repo,
    fakeClaude,
    fakeOpencode,
    responsesFile,
    modesFile,
    claudeSeq: path.join(root, 'claude-seq.txt'),
    opencodeSeq: path.join(root, 'opencode-seq.txt'),
    claudeLog: path.join(root, 'claude-log.ndjson'),
    opencodeLog: path.join(root, 'opencode-log.ndjson'),
    configPath: path.join(root, 'agent-loop.config.json'),
  };

  const config = {
    schemaVersion: 1,
    claude: {
      command: process.execPath,
      argsPrefix: [fakeClaude],
      env: {
        FAKE_CLAUDE_SEQ: paths.claudeSeq,
        FAKE_CLAUDE_RESPONSES: responsesFile,
        FAKE_CLAUDE_LOG: paths.claudeLog,
        CLAUDECODE: 'configured-override',
      },
    },
    opencode: {
      command: process.execPath,
      argsPrefix: [fakeOpencode],
      env: {
        FAKE_OPENCODE_SEQ: paths.opencodeSeq,
        FAKE_OPENCODE_MODES: modesFile,
        FAKE_OPENCODE_LOG: paths.opencodeLog,
      },
      ...(options.opencode || {}),
    },
    limits: { commandTimeoutMs: 60000, maxPlanAttempts: 2, maxTasks: 10, ...(options.limits || {}) },
    verification: { allowedCommands: options.allowedCommands || ['node verify.js'] },
    constraints: { allowedGlobs: ['**'] },
  };
  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2));
  return paths;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    cwd: options.cwd || PACKAGE_ROOT,
    env: options.env || process.env,
  });
}

function startRun(scenario, request, options = {}) {
  return runCli(['start', '--repo', scenario.repo, '--request', request, '--config', scenario.configPath], options);
}

function resumeRun(scenario, runDir, extra = []) {
  return runCli(['resume', '--run', runDir, '--config', scenario.configPath, ...extra]);
}

function runDirectories(scenario) {
  const runsDir = path.join(scenario.repo, '.git', 'agent-loop', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir).map((name) => path.join(runsDir, name));
}

function singleRunDir(scenario) {
  const dirs = runDirectories(scenario);
  assert.equal(dirs.length, 1, `expected exactly one run dir, found ${dirs.length}`);
  return dirs[0];
}

function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'STATE.json'), 'utf8'));
}

function readNdjsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function makePlan(overrides = {}) {
  return {
    status: 'PLAN',
    summary: 'Create made.txt',
    tasks: [
      {
        id: 'T1',
        title: 'Create made.txt',
        instruction: 'Create the file made.txt containing the word ok.',
        files: ['made.txt'],
        checks: ['node verify.js'],
        done: 'made.txt exists and the verification check passes',
        ...overrides,
      },
    ],
  };
}

function value(v, usage) {
  return { value: v, usage };
}

function failWithUsage(message, usage) {
  return { fail: { stderr: message, stdout: JSON.stringify({ usage }) } };
}

function openCodeStepFinish(id, tokens) {
  return {
    type: 'step_finish',
    timestamp: 1791602562310,
    sessionID: 'ses_test',
    part: { id, messageID: `msg_${id}`, sessionID: 'ses_test', type: 'step-finish', tokens, cost: 0 },
  };
}

test('happy path completes with isolated worktree and untouched primary repository', (t) => {
  const scenario = makeScenario('happy', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'criteria met' })],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scenario.repo, encoding: 'utf8' }).trim();
  const result = startRun(scenario, 'Create made.txt in the repository root.', {
    env: { ...process.env, CLAUDECODE: '1' },
  });
  assert.equal(result.status, 0, `start failed: ${result.stderr}\n${result.stdout}`);

  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.baseHead, headBefore);

  const worktree = state.worktree;
  assert.equal(fs.existsSync(path.join(worktree, 'made.txt')), true);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(),
    headBefore,
    'the loop must not create commits'
  );
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scenario.repo, encoding: 'utf8' }).trim(), headBefore);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: scenario.repo, encoding: 'utf8' }).trim(), '');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: scenario.repo, encoding: 'utf8' }).trim(), '');

  const opencodeCalls = readNdjsonLines(scenario.opencodeLog);
  assert.equal(opencodeCalls.length, 1);
  assert.equal(opencodeCalls[0].args.includes('--auto'), false, 'opencode must never be invoked with --auto');
  assert.equal(opencodeCalls[0].args.includes('agent-loop-executor'), true);
  const formatIndex = opencodeCalls[0].args.indexOf('--format');
  assert.notEqual(formatIndex, -1, 'opencode must request its JSON event format');
  assert.equal(opencodeCalls[0].args[formatIndex + 1], 'json');
  assert.equal(opencodeCalls[0].steps, 8, 'default step cap is set as the top-level agent field');
  assert.equal(opencodeCalls[0].options.maxTokens, 8192, 'default output cap is passed via agent options');

  const claudeCalls = readNdjsonLines(scenario.claudeLog);
  assert.equal(claudeCalls.length, 2);
  for (const call of claudeCalls) {
    assert.equal(call.args.includes('--permission-mode'), true, 'claude must run in a read-only permission mode');
    assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(call.args.includes('--max-turns'), true, 'claude turns must be bounded');
    assert.equal(call.args.includes('--max-budget-usd'), true, 'claude needs a per-invocation budget');
    assert.equal(call.args.includes('--disallowedTools'), true);
    assert.match(call.args[call.args.indexOf('--disallowedTools') + 1], /AskUserQuestion/);
    assert.equal(
      call.claudecode,
      null,
      'CLAUDECODE removal must win over inherited (parent=1) and configured values'
    );
  }

  const events = readNdjsonLines(path.join(runDir, 'events.ndjson')).map((event) => event.type);
  for (const expected of ['RUN_CREATED', 'WORKTREE_CREATED', 'PLAN_WRITTEN', 'CHECKS_DONE', 'TASK_PASSED', 'RUN_COMPLETED']) {
    assert.equal(events.includes(expected), true, `missing event ${expected}`);
  }

  const checks = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'checks-0.json'), 'utf8'));
  assert.equal(checks.allPassed, true);
  const review = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'review-0.json'), 'utf8'));
  assert.equal(review.verdict, 'PASS');
  assert.equal(fs.existsSync(path.join(runDir, 'evidence', 'final', 'SELF-REPORT.md')), true);
  assert.equal(fs.existsSync(path.join(runDir, 'opencode.overlay.json')), true);
  const overlay = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode.overlay.json'), 'utf8'));
  assert.deepEqual(overlay.permission.external_directory, { '*': 'deny' });
  assert.equal(overlay.permission.read['**/.env*'], 'deny');
  assert.equal(overlay.permission.edit['*'], 'deny', 'edits are denied outside the current task files');
  assert.equal(overlay.permission.write, undefined, 'no mutation alias may override the edit rule');
});

test('opencode receives the configured step and output caps', (t) => {
  const scenario = makeScenario('opencode-caps', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [{ write: 'made.txt' }],
    opencode: { maxStepsPerTask: 3, maxOutputTokens: 4096 },
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 0, `start failed: ${result.stderr}\n${result.stdout}`);
  const opencodeCalls = readNdjsonLines(scenario.opencodeLog);
  assert.equal(opencodeCalls.length, 1);
  assert.equal(opencodeCalls[0].steps, 3, 'the configured step cap must reach the agent top level');
  assert.equal(opencodeCalls[0].options.maxTokens, 4096, 'the configured output cap must reach agent options');
});

test('one FIX verdict triggers exactly one bounded repair cycle', (t) => {
  const scenario = makeScenario('fix', {
    responses: [
      value(makePlan()),
      value({ verdict: 'FIX', notes: 'made.txt is missing; create it with the word ok.' }),
      value({ verdict: 'PASS', notes: 'now complete' }),
    ],
    modes: [{}, { write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 0, `start failed: ${result.stderr}\n${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.fixCounts.T1, 1);

  const opencodeCalls = readNdjsonLines(scenario.opencodeLog);
  assert.equal(opencodeCalls.length, 2);
  const fixPrompt = opencodeCalls[1].args[opencodeCalls[1].args.length - 1];
  assert.match(fixPrompt, /missing; create it/);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 3);

  const checks0 = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'checks-0.json'), 'utf8'));
  const checks1 = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'checks-1.json'), 'utf8'));
  assert.equal(checks0.allPassed, false);
  assert.equal(checks1.allPassed, true);
  const review1 = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'review-1.json'), 'utf8'));
  assert.equal(review1.verdict, 'PASS');
});

test('a second FIX verdict stops the run without a second repair', (t) => {
  const scenario = makeScenario('fixcap', {
    responses: [
      value(makePlan()),
      value({ verdict: 'FIX', notes: 'still missing made.txt' }),
      value({ verdict: 'FIX', notes: 'still missing made.txt' }),
    ],
    modes: [{}],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 2, `expected FAILED exit, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'FAILED');
  assert.match(state.stopReason, /exhausted/);
  assert.equal(readNdjsonLines(scenario.opencodeLog).length, 2, 'no repair beyond the single allowed cycle');
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 3);
});

test('QUESTION verdict blocks execution until a human answer is recorded', (t) => {
  const scenario = makeScenario('question', {
    responses: [
      value(makePlan()),
      value({ verdict: 'QUESTION', question: 'Which storage backend should be used for made.txt?' }),
      value({ verdict: 'PASS', notes: 'answer incorporated' }),
    ],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const first = startRun(scenario, 'Create made.txt.');
  assert.equal(first.status, 3, `expected NEEDS_HUMAN exit, got ${first.status}: ${first.stdout}`);
  const runDir = singleRunDir(scenario);
  let state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.match(state.question, /storage backend/);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 2);
  assert.equal(readNdjsonLines(scenario.opencodeLog).length, 1);

  const blocked = resumeRun(scenario, runDir);
  assert.equal(blocked.status, 3, 'resume without an answer must not proceed');
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 2, 'no CLI call may happen while a question is pending');
  assert.equal(readNdjsonLines(scenario.opencodeLog).length, 1);
  assert.deepEqual(readState(runDir).question, state.question);
  assert.equal(fs.existsSync(path.join(runDir, 'ANSWER-1.md')), false);

  const answered = resumeRun(scenario, runDir, ['--answer', 'Use sqlite.']);
  assert.equal(answered.status, 0, `answered resume failed: ${answered.stderr}\n${answered.stdout}`);
  state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.answers.length, 1);
  assert.equal(fs.existsSync(path.join(runDir, 'ANSWER-1.md')), true);
  const claudeCalls = readNdjsonLines(scenario.claudeLog);
  assert.equal(claudeCalls.length, 3);
  assert.match(claudeCalls[2].stdin, /Use sqlite\./);
});

test('token budget exhaustion stops the run before execution', (t) => {
  const scenario = makeScenario('budget', {
    responses: [value(makePlan(), { input_tokens: 500, output_tokens: 100 })],
    modes: [{ write: 'made.txt' }],
    limits: { maxTokenBudget: 100 },
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 2, `expected FAILED exit, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'FAILED');
  assert.match(state.stopReason, /budget/);
  assert.equal(state.tokensUsed, 600);
  assert.equal(fs.existsSync(scenario.opencodeLog), false, 'opencode must not run after budget exhaustion');
});

test('exactly one automatic retry is allowed for a metered transient CLI failure', (t) => {
  const scenario = makeScenario('retry', {
    responses: [
      failWithUsage('Error: fetch failed ECONNRESET', { input_tokens: 3, output_tokens: 2 }),
      value(makePlan()),
      value({ verdict: 'PASS', notes: 'ok' }),
    ],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 0, `expected success after one retry, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.transientRetries['plan-attempt-1'], 1);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 3, 'one retry call plus the two successful calls');
  assert.equal(state.tokensUsed, 5 + 18 + 8 + 18, 'known usage from the failed call is counted');
  const events = readNdjsonLines(path.join(runDir, 'events.ndjson')).map((event) => event.type);
  assert.equal(events.includes('CLI_RETRY'), true);
});

test('a second transient failure stops instead of retrying forever', (t) => {
  const scenario = makeScenario('retry-bounded', {
    responses: [
      failWithUsage('Error: fetch failed ECONNRESET', { input_tokens: 3, output_tokens: 2 }),
      failWithUsage('Error: fetch failed ECONNRESET', { input_tokens: 3, output_tokens: 2 }),
    ],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'cli-transient');
  assert.match(state.question, /single allowed automatic retry/);
  assert.equal(state.transientRetries['plan-attempt-1'], 1);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 2, 'no third attempt without a human answer');
  assert.equal(state.tokensUsed, 10, 'both failed calls reported known usage');
});

test('an unmetered transient failure is not retried automatically', (t) => {
  const scenario = makeScenario('unmetered-transient', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [{ fail: 'Error: fetch failed ECONNRESET' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'cli-transient-unmetered');
  assert.match(state.question, /unaccounted cost/);
  assert.equal(readNdjsonLines(scenario.opencodeLog).length, 1, 'no automatic retry when usage is unknown');
  assert.equal(state.tokensUsed, 18, 'only the reported planner usage is counted');
  assert.equal(fs.existsSync(path.join(runDir, 'evidence', 'task-T1', 'execution-0.failure.json')), true);
});

test('parses realistic OpenCode step events without double counting', (t) => {
  const scenario = makeScenario('opencode-events', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [
      {
        write: 'made.txt',
        events: [
          { type: 'step_start', sessionID: 'ses_test', part: { id: 'prt_0', type: 'step-start', snapshot: 'abc' } },
          openCodeStepFinish('prt_1', { input: 100, output: 20 }),
          { type: 'text', sessionID: 'ses_test', part: { id: 'prt_2', type: 'text', text: 'done' } },
          openCodeStepFinish('prt_3', { total: 50, input: 10, output: 5 }),
          openCodeStepFinish('prt_4', { input: 5, output: 5, cache: { read: 2, write: 1 } }),
          openCodeStepFinish('prt_4', { input: 5, output: 5, cache: { read: 2, write: 1 } }),
        ],
      },
    ],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 0, `expected success, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.tokensUsed, 18 + 18 + 183, 'planner + reviewer + summed executor steps');
  const execution = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'execution-0.json'), 'utf8'));
  assert.equal(execution.usage.source, 'opencode-events');
  assert.equal(execution.usage.total, 183);
  assert.equal(execution.usage.inputTokens, 115);
  assert.equal(execution.usage.outputTokens, 30);
});

test('authentication failures stop immediately without any retry', (t) => {
  const scenario = makeScenario('auth', {
    responses: [{ fail: '401 Unauthorized: invalid API key' }],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'cli-auth');
  assert.match(state.question, /authentication/i);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 1, 'auth errors must never be retried automatically');
  assert.equal(fs.existsSync(scenario.opencodeLog), false);
});

test('unreported planner token usage stops for human action instead of counting zero', (t) => {
  const scenario = makeScenario('usage-plan', {
    responses: [value(makePlan(), {})],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'usage');
  assert.equal(state.tokensUsed, 0);
  assert.match(state.question, /token usage/);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 1);
});

test('unreported executor token usage stops the run for human action', (t) => {
  const scenario = makeScenario('usage-exec', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [{ write: 'made.txt', usage: {} }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'usage');
  assert.equal(state.tokensUsed, 18, 'only the reported planner usage may be counted');
  assert.equal(readNdjsonLines(scenario.opencodeLog).length, 1);
  assert.equal(fs.existsSync(path.join(runDir, 'evidence', 'task-T1', 'execution-0.json')), false);
  assert.equal(fs.existsSync(path.join(runDir, 'evidence', 'task-T1', 'execution-0.failure.json')), true);
});

test('a missing CLI executable stops with a precise NEEDS_HUMAN question', (t) => {
  const scenario = makeScenario('missing-exe', {
    responses: [value(makePlan())],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));
  const config = JSON.parse(fs.readFileSync(scenario.configPath, 'utf8'));
  config.claude.command = 'agent-loop-missing-exe-xyz';
  fs.writeFileSync(scenario.configPath, JSON.stringify(config, null, 2));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'cli-missing');
  assert.match(state.question, /could not start/);
});

test('ambiguous planner output stops for human review without an automatic replan', (t) => {
  const scenario = makeScenario('ambiguous', {
    responses: [{ raw: 'I could not decide what to do; please advise.' }],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 3, `expected NEEDS_HUMAN, got ${result.status}: ${result.stdout}`);
  const runDir = singleRunDir(scenario);
  const state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'ambiguous');
  assert.match(state.question, /ambiguous/);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 1);
});

test('a live PID lock refuses resume and changes nothing', (t) => {
  const scenario = makeScenario('lock', {
    responses: [
      value(makePlan()),
      value({ verdict: 'QUESTION', question: 'Proceed with the current layout?' }),
      value({ verdict: 'PASS', notes: 'ok' }),
    ],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const first = startRun(scenario, 'Create made.txt.');
  assert.equal(first.status, 3);
  const runDir = singleRunDir(scenario);
  fs.writeFileSync(
    path.join(runDir, 'LOCK.json'),
    JSON.stringify({ schemaVersion: 1, pid: process.pid, hostname: os.hostname(), createdUtc: new Date().toISOString() })
  );

  const blocked = resumeRun(scenario, runDir, ['--answer', 'Yes.']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /locked/);
  assert.equal(readState(runDir).status, 'NEEDS_HUMAN');
  assert.equal(fs.existsSync(path.join(runDir, 'ANSWER-1.md')), false);
});

test('a dirty target checkout is refused before any run state is created', (t) => {
  const scenario = makeScenario('dirty', {
    responses: [value(makePlan())],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));
  fs.writeFileSync(path.join(scenario.repo, 'README.md'), '# dirty\n');

  const result = startRun(scenario, 'Create made.txt.');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /dirty/);
  assert.equal(fs.existsSync(path.join(scenario.repo, '.git', 'agent-loop')), false);
});

test('model-created commits are surfaced by the audit and require acknowledgement', (t) => {
  const scenario = makeScenario('audit', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [{ write: 'made.txt', commit: true }],
  });
  t.after(() => safeRemove(scenario.root));
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scenario.repo, encoding: 'utf8' }).trim();

  const first = startRun(scenario, 'Create made.txt.');
  assert.equal(first.status, 3, `expected audit question, got ${first.status}: ${first.stdout}`);
  const runDir = singleRunDir(scenario);
  let state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.match(state.question, /safety audit failed/);
  assert.equal(state.auditAcknowledged, false);
  assert.equal(readNdjsonLines(scenario.claudeLog).length, 2, 'audit stops before any further review');

  const ack = resumeRun(scenario, runDir, ['--answer', 'ACKNOWLEDGE: I inspected the commit; it is expected.']);
  assert.equal(ack.status, 0, `acknowledged resume failed: ${ack.stderr}\n${ack.stdout}`);
  state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.auditAcknowledged, true);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scenario.repo, encoding: 'utf8' }).trim(), headBefore);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: scenario.repo, encoding: 'utf8' }).trim(), '');
});

test('undeclared file changes are mechanically gated behind a human decision', (t) => {
  const scenario = makeScenario('violation', {
    responses: [
      value(makePlan()),
      value({ verdict: 'PASS', notes: 'looks fine to me' }),
      value({ verdict: 'PASS', notes: 'accepted after review' }),
    ],
    modes: [{ writes: ['made.txt', 'extra.txt'] }],
  });
  t.after(() => safeRemove(scenario.root));

  const first = startRun(scenario, 'Create made.txt.');
  assert.equal(first.status, 3, `expected violation question, got ${first.status}: ${first.stdout}`);
  const runDir = singleRunDir(scenario);
  let state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.stopKind, 'violation');
  assert.match(state.question, /extra\.txt/);
  const reviewBefore = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'review-0.json'), 'utf8'));
  assert.equal(reviewBefore.verdict, 'QUESTION');
  assert.deepEqual(reviewBefore.fileViolations, ['extra.txt']);
  assert.deepEqual([...reviewBefore.changedFiles].sort(), ['extra.txt', 'made.txt']);

  const ack = resumeRun(scenario, runDir, ['--answer', 'ACKNOWLEDGE: keep extra.txt; it is intentional.']);
  assert.equal(ack.status, 0, `acknowledged resume failed: ${ack.stderr}\n${ack.stdout}`);
  state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  const reviewAfter = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'task-T1', 'review-0.json'), 'utf8'));
  assert.equal(reviewAfter.verdict, 'PASS');
  assert.match(reviewAfter.notes, /acknowledged undeclared changes/);
});

test('a vague answer does not acknowledge a violation and the gate stays closed', (t) => {
  const scenario = makeScenario('violation-vague', {
    responses: [
      value(makePlan()),
      value({ verdict: 'PASS', notes: 'looks fine to me' }),
      value({ verdict: 'PASS', notes: 'accepted after explicit acknowledgement' }),
    ],
    modes: [{ writes: ['made.txt', 'extra.txt'] }],
  });
  t.after(() => safeRemove(scenario.root));

  const first = startRun(scenario, 'Create made.txt.');
  assert.equal(first.status, 3, `expected violation question, got ${first.status}: ${first.stdout}`);
  const runDir = singleRunDir(scenario);

  const vague = resumeRun(scenario, runDir, ['--answer', 'OK, keep extra.txt.']);
  assert.equal(vague.status, 3, `a vague answer must not release the gate: ${vague.stdout}`);
  let state = readState(runDir);
  assert.equal(state.status, 'NEEDS_HUMAN');
  assert.equal(state.violationAcknowledged, false);
  assert.equal(state.answers.length, 1);
  assert.match(state.question, /ACKNOWLEDGE:/);

  const ack = resumeRun(scenario, runDir, ['--answer', 'ACKNOWLEDGE: keep extra.txt.']);
  assert.equal(ack.status, 0, `acknowledged resume failed: ${ack.stderr}\n${ack.stdout}`);
  state = readState(runDir);
  assert.equal(state.status, 'COMPLETE');
  assert.equal(state.violationAcknowledged, true);
});

test('status reports state without side effects and self-check passes', (t) => {
  const scenario = makeScenario('status', {
    responses: [value(makePlan()), value({ verdict: 'PASS', notes: 'ok' })],
    modes: [{ write: 'made.txt' }],
  });
  t.after(() => safeRemove(scenario.root));

  const run = startRun(scenario, 'Create made.txt.');
  assert.equal(run.status, 0);
  const runDir = singleRunDir(scenario);
  const before = fs.readFileSync(path.join(runDir, 'STATE.json'), 'utf8');
  const status = runCli(['status', '--run', runDir]);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /COMPLETE/);
  assert.equal(fs.readFileSync(path.join(runDir, 'STATE.json'), 'utf8'), before);

  const selfCheck = runCli(['--self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stdout}\n${selfCheck.stderr}`);
  const parsed = JSON.parse(selfCheck.stdout);
  assert.equal(parsed.ok, true);
});
