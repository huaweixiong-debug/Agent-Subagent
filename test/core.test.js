'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  quoteWindowsArg,
  buildWindowsCommandLine,
  buildWindowsArguments,
  assertNoForbiddenArgs,
  splitCommandArgs,
  buildChildEnv,
  resolveExecutable,
  parseUsage,
  classifyCliFailure,
} = require('../lib/invoke');
const {
  normalizeRepoRelative,
  matchesAnyGlob,
} = require('../lib/paths');
const { ConfigError, validateUserConfig, loadConfig } = require('../lib/config');
const stateModule = require('../lib/state');
const { LockError, acquireLock, isProcessAlive, reclaimPath } = require('../lib/lock');
const events = require('../lib/events');
const planLib = require('../lib/plan');
const reviewLib = require('../lib/review');
const { detectPlanningSkill } = require('../lib/skills');
const { buildOpenCodeOverlay } = require('../lib/orchestrator');

const S = stateModule.STATUS;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-loop-core-${label}-`));
}

function makeState(runDir) {
  return stateModule.createState({
    runId: 'test-run',
    repo: 'C:\\repo',
    commonDir: 'C:\\repo\\.git',
    runDir,
    worktree: 'C:\\repo\\.git\\agent-loop\\worktrees\\test-run',
    branch: 'agent-loop/test-run',
    baseHead: 'abc123',
    createdUtc: new Date().toISOString(),
  });
}

test('quoteWindowsArg quotes and escapes per CreateProcess rules', () => {
  assert.equal(quoteWindowsArg('abc'), 'abc');
  assert.equal(quoteWindowsArg(''), '""');
  assert.equal(quoteWindowsArg('a b'), '"a b"');
  assert.equal(quoteWindowsArg('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg('a "b" c'), '"a \\"b\\" c"');
  assert.equal(quoteWindowsArg('a \\'), '"a \\\\"');
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
  assert.throws(() => quoteWindowsArg('a\0b'), /NUL/);
});

test('buildWindowsCommandLine joins quoted arguments', () => {
  assert.equal(buildWindowsCommandLine(['node', 'a b']), 'node "a b"');
  assert.throws(() => buildWindowsCommandLine([]), /empty/);
});

test('buildWindowsArguments omits argv[0] and allows an empty argument list', () => {
  assert.equal(buildWindowsArguments([]), '');
  assert.equal(buildWindowsArguments(['a b', '-p']), '"a b" -p');
});

test('assertNoForbiddenArgs refuses --auto and permission-skipping flags', () => {
  assert.throws(() => assertNoForbiddenArgs(['run', '--auto']), /--auto/);
  assert.throws(() => assertNoForbiddenArgs(['-p', '--dangerously-skip-permissions']), /dangerously-skip-permissions/);
  assert.doesNotThrow(() => assertNoForbiddenArgs(['run', '--variant', 'max']));
});

test('buildChildEnv removal wins over inherited and configured values, case-insensitively', () => {
  const env = buildChildEnv({ FAKE: '1' }, ['CLAUDECODE']);
  assert.equal(env.FAKE, '1');
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'CLAUDECODE'), false);

  const configured = buildChildEnv({ CLAUDECODE: 'configured-override', Other: 'x' }, ['claudecode']);
  assert.equal(Object.keys(configured).some((key) => key.toUpperCase() === 'CLAUDECODE'), false);
  assert.equal(configured.Other, 'x');

  const caseVariant = buildChildEnv({ claudeCode: 'configured-override' }, ['CLAUDECODE']);
  assert.equal(Object.keys(caseVariant).some((key) => key.toUpperCase() === 'CLAUDECODE'), false);

  const overridden = buildChildEnv({ PATH: 'C:\\fake' }, []);
  assert.equal(overridden.PATH, 'C:\\fake');
  assert.equal(Object.keys(overridden).filter((key) => key.toLowerCase() === 'path').length, 1);
});

test('splitCommandArgs tokenizes allow-listed commands safely', () => {
  assert.deepEqual(splitCommandArgs('node --test'), ['node', '--test']);
  assert.deepEqual(splitCommandArgs('node "my file.js" \'second arg\''), ['node', 'my file.js', 'second arg']);
  assert.deepEqual(splitCommandArgs('  spaced   out  '), ['spaced', 'out']);
  assert.throws(() => splitCommandArgs('node "unbalanced'), /unbalanced/);
  assert.throws(() => splitCommandArgs('   '), /non-empty/);
});

test('resolveExecutable accepts native executables and refuses shell shims on win32', () => {
  const resolvedNode = resolveExecutable(process.execPath);
  assert.equal(path.resolve(resolvedNode), path.resolve(process.execPath));
  const dir = tmpDir('shim');
  try {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n');
    assert.throws(
      () => resolveExecutable('claude', { platform: 'win32', env: { PATH: dir, PATHEXT: '.CMD;.EXE' } }),
      /native \.exe/
    );
    assert.throws(() => resolveExecutable('definitely-not-here-1234', { env: { PATH: dir, PATHEXT: '.EXE' } }), /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveExecutable tolerates cloned env objects with different PATH casing', () => {
  const cloned = { ...process.env };
  assert.equal(path.resolve(resolveExecutable('node', { env: cloned })), path.resolve(process.execPath));
});

function openCodeStepFinish(id, tokens) {
  return {
    type: 'step_finish',
    timestamp: 1791602562310,
    sessionID: 'ses_test',
    part: { id, messageID: `msg_${id}`, sessionID: 'ses_test', type: 'step-finish', tokens, cost: 0 },
  };
}

test('parseUsage keeps Claude-compatible usage envelopes', () => {
  assert.deepEqual(parseUsage(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 4 } })), {
    known: true,
    inputTokens: 10,
    outputTokens: 4,
    total: 14,
    source: 'json',
  });
  assert.deepEqual(parseUsage(`some log\n${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } })}`), {
    known: true,
    inputTokens: 3,
    outputTokens: 2,
    total: 5,
    source: 'json',
  });
  assert.deepEqual(parseUsage(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })), {
    known: true,
    inputTokens: 0,
    outputTokens: 0,
    total: 0,
    source: 'json',
  });
  for (const unknown of [parseUsage('no usage here'), parseUsage(''), parseUsage(JSON.stringify({ result: 'x' }))]) {
    assert.equal(unknown.known, false);
    assert.equal(unknown.total, null);
  }
});

test('parseUsage accounts for Claude prompt-cache fields in the input total', () => {
  assert.deepEqual(
    parseUsage(
      JSON.stringify({
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 2,
        },
      })
    ),
    { known: true, inputTokens: 15, outputTokens: 4, total: 19, source: 'json' }
  );
  assert.deepEqual(
    parseUsage(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 6 } })),
    { known: true, inputTokens: 7, outputTokens: 1, total: 8, source: 'json' }
  );
});

test('parseUsage uses an explicit Claude total when present', () => {
  assert.deepEqual(parseUsage(JSON.stringify({ usage: { total: 42, input_tokens: 10, output_tokens: 4 } })), {
    known: true,
    inputTokens: 10,
    outputTokens: 4,
    total: 42,
    source: 'json',
  });
  assert.deepEqual(parseUsage(JSON.stringify({ usage: { total_tokens: 7 } })), {
    known: true,
    inputTokens: 0,
    outputTokens: 0,
    total: 7,
    source: 'json',
  });
});

test('parseUsage keeps partial Claude usage unknown instead of zero', () => {
  assert.equal(parseUsage(JSON.stringify({ usage: { input_tokens: 10 } })).known, false);
  assert.equal(parseUsage(JSON.stringify({ usage: { output_tokens: 4 } })).known, false);
  assert.equal(parseUsage(JSON.stringify({ usage: { cache_read_input_tokens: 3 } })).known, false);
});

test('parseUsage sums OpenCode step_finish events once per completed step', () => {
  const stream = [
    { type: 'step_start', sessionID: 'ses_test', part: { id: 'prt_0', type: 'step-start', snapshot: 'abc' } },
    openCodeStepFinish('prt_1', { input: 100, output: 20 }),
    { type: 'text', sessionID: 'ses_test', part: { id: 'prt_2', type: 'text', text: 'done' } },
    openCodeStepFinish('prt_3', { input: 5, output: 5, cache: { read: 2, write: 1 } }),
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  assert.deepEqual(parseUsage(stream), {
    known: true,
    inputTokens: 105,
    outputTokens: 25,
    total: 133,
    source: 'opencode-events',
  });
});

test('parseUsage prefers an explicit step total and counts duplicate snapshots once', () => {
  const explicit = parseUsage(JSON.stringify(openCodeStepFinish('prt_1', { total: 50, input: 10, output: 5 })));
  assert.deepEqual(explicit, {
    known: true,
    inputTokens: 10,
    outputTokens: 5,
    total: 50,
    source: 'opencode-events',
  });

  const duplicate = openCodeStepFinish('prt_dup', { input: 10, output: 5 });
  const stream = [duplicate, duplicate].map((event) => JSON.stringify(event)).join('\n');
  assert.equal(parseUsage(stream).total, 15);
});

test('parseUsage stays unknown when a step_finish lacks usable tokens', () => {
  const stream = [
    JSON.stringify(openCodeStepFinish('prt_1', { input: 1, output: 1 })),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_test', part: { id: 'prt_2', type: 'step-finish' } }),
  ].join('\n');
  assert.equal(parseUsage(stream).known, false);
});

test('classifyCliFailure separates transient, auth, permission, and unknown failures', () => {
  assert.equal(
    classifyCliFailure({ exitCode: 1, stderr: 'Error: fetch failed ECONNRESET', timedOut: false }).kind,
    'transient'
  );
  assert.equal(classifyCliFailure({ exitCode: null, timedOut: true, stderr: '' }).kind, 'transient');
  assert.equal(
    classifyCliFailure({ exitCode: 1, stderr: '401 Unauthorized: invalid API key', timedOut: false }).kind,
    'auth'
  );
  assert.equal(
    classifyCliFailure({ exitCode: 1, stderr: 'EACCES: permission denied', timedOut: false }).kind,
    'permission'
  );
  assert.equal(classifyCliFailure({ exitCode: 7, stderr: 'unexpected internal state', timedOut: false }).kind, 'unknown');
});

test('normalizeRepoRelative rejects traversal, absolute, and protected paths', () => {
  assert.deepEqual(normalizeRepoRelative('src/app.js'), { ok: true, normalized: 'src/app.js' });
  assert.deepEqual(normalizeRepoRelative('src\\nested\\app.js'), { ok: true, normalized: 'src/nested/app.js' });
  assert.equal(normalizeRepoRelative('../x').ok, false);
  assert.equal(normalizeRepoRelative('a/../../x').ok, false);
  assert.equal(normalizeRepoRelative('C:/x').ok, false);
  assert.equal(normalizeRepoRelative('/etc/passwd').ok, false);
  assert.equal(normalizeRepoRelative('').ok, false);
  assert.equal(normalizeRepoRelative('.env').ok, false);
  assert.equal(normalizeRepoRelative('config/.env.local').ok, false);
  assert.equal(normalizeRepoRelative('.git/config').ok, false);
  assert.equal(normalizeRepoRelative('keys/server.pem').ok, false);
  assert.equal(normalizeRepoRelative('.ssh/id_rsa').ok, false);
  assert.equal(normalizeRepoRelative('credentials.json').ok, false);
});

test('matchesAnyGlob handles * and ** globs', () => {
  assert.equal(matchesAnyGlob('lib/a.js', ['lib/*.js']), true);
  assert.equal(matchesAnyGlob('lib/sub/a.js', ['lib/*.js']), false);
  assert.equal(matchesAnyGlob('lib/sub/a.js', ['lib/**']), true);
  assert.equal(matchesAnyGlob('src/a/b/x.js', ['src/**/x.js']), true);
  assert.equal(matchesAnyGlob('src/x.js', ['src/**/x.js']), true);
  assert.equal(matchesAnyGlob('anything', ['**']), true);
  assert.equal(matchesAnyGlob('src/a.md', ['test/**']), false);
});

test('config validation fails closed on unknown keys and bad values', () => {
  const good = validateUserConfig({ limits: { maxFixPerTask: 1 }, verification: { allowedCommands: ['node --test'] } }, 'test');
  assert.equal(good.limits.maxFixPerTask, 1);
  assert.throws(() => validateUserConfig({ nope: true }, 'test'), ConfigError);
  assert.throws(() => validateUserConfig({ limits: { nonsense: 1 } }, 'test'), /unknown key/);
  assert.throws(() => validateUserConfig({ limits: { maxFixPerTask: 2 } }, 'test'), /0 or 1/);
  assert.throws(() => validateUserConfig({ limits: { maxTasks: -1 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ verification: { allowedCommands: ['node "unbalanced'] } }, 'test'), /unbalanced/);
  assert.throws(() => validateUserConfig({ claude: { env: { KEY: 5 } } }, 'test'), /expected a string/);
  assert.throws(() => validateUserConfig({ claude: { outputFormat: 'yaml' } }, 'test'), /json/);
});

test('config validation refuses unsafe or runner-managed CLI flags', () => {
  assert.throws(() => validateUserConfig({ claude: { extraArgs: ['--auto'] } }, 'test'), /managed/);
  assert.throws(
    () => validateUserConfig({ claude: { extraArgs: ['--dangerously-skip-permissions'] } }, 'test'),
    /managed/
  );
  assert.throws(() => validateUserConfig({ claude: { extraArgs: ['--max-turns=5'] } }, 'test'), /managed/);
  assert.throws(() => validateUserConfig({ opencode: { extraArgs: ['--auto'] } }, 'test'), /managed/);
  assert.throws(() => validateUserConfig({ opencode: { extraArgs: ['-m', 'other/model'] } }, 'test'), /managed/);
  assert.throws(() => validateUserConfig({ claude: { permissionMode: 'bypassPermissions' } }, 'test'), /permissionMode/);
  assert.throws(() => validateUserConfig({ claude: { maxTurns: 0 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ claude: { maxBudgetUsd: -1 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ opencode: { maxOutputTokens: 2000000 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ opencode: { maxStepsPerTask: 0 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ opencode: { maxStepsPerTask: 1000 } }, 'test'), /between/);
  assert.throws(() => validateUserConfig({ limits: { maxTransientRetries: 2 } }, 'test'), /0 or 1/);
  assert.doesNotThrow(() =>
    validateUserConfig({ claude: { extraArgs: ['--add-dir', 'docs'] }, opencode: { extraArgs: ['--share'] } }, 'test')
  );
});

test('the example config validates and keeps safe defaults', () => {
  const config = loadConfig(path.join(__dirname, '..', 'config.example.json'));
  assert.equal(config.claude.disallowedTools.includes('AskUserQuestion'), true);
  assert.equal(config.claude.permissionMode, 'plan');
  assert.equal(config.claude.maxTurns > 0, true);
  assert.equal(config.claude.maxBudgetUsd > 0, true);
  assert.equal(config.limits.maxFixPerTask, 1);
  assert.equal(config.limits.maxTransientRetries, 1);
  assert.equal(config.opencode.model, 'deepseek/deepseek-flash');
  assert.equal(config.opencode.variant, 'max');
  assert.equal(config.opencode.maxOutputTokens > 0, true);
  assert.equal(config.opencode.maxStepsPerTask, 8);
  assert.equal(config.verification.allowedCommands.length > 0, true);
});

test('state transitions are explicit and invalid transitions fail closed', () => {
  const cases = [
    [S.CREATED, S.WORKTREE_READY, true],
    [S.CREATED, S.TASK_RUNNING, false],
    [S.TASK_REVIEWING, S.TASK_FIXING, true],
    [S.TASK_FIXING, S.TASK_DONE, false],
    [S.TASK_DONE, S.COMPLETE, true],
    [S.COMPLETE, S.TASK_RUNNING, false],
    [S.FAILED, S.CREATED, false],
  ];
  for (const [from, to, allowed] of cases) {
    const state = { status: from, question: null, resumeStatus: null };
    if (allowed) {
      assert.doesNotThrow(() => stateModule.assertTransition(state, to), `${from} -> ${to} should be allowed`);
    } else {
      assert.throws(() => stateModule.assertTransition(state, to), /invalid transition/, `${from} -> ${to} should fail`);
    }
  }
  const stopped = { status: S.NEEDS_HUMAN, question: 'q?', resumeStatus: S.TASK_REVIEWING };
  assert.doesNotThrow(() => stateModule.assertTransition(stopped, S.TASK_REVIEWING));
  assert.throws(() => stateModule.assertTransition(stopped, S.PLANNING), /invalid transition/);
  assert.throws(() => stateModule.assertTransition({ ...stopped, question: null }, S.TASK_REVIEWING), /invalid transition/);
});

test('state writes are atomic and round-trip through STATE.json', () => {
  const dir = tmpDir('state');
  try {
    const state = makeState(dir);
    stateModule.writeState(dir, state);
    const read = stateModule.readState(dir);
    assert.equal(read.status, S.CREATED);
    assert.equal(read.runId, 'test-run');
    const leftovers = fs.readdirSync(dir).filter((file) => file.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('patchState cannot change status and setStatus updates history', () => {
  const dir = tmpDir('state2');
  try {
    stateModule.writeState(dir, makeState(dir));
    assert.throws(() => stateModule.patchState(dir, () => ({ status: S.COMPLETE })), /patchState/);
    const next = stateModule.setStatus(dir, S.WORKTREE_READY);
    assert.equal(next.status, S.WORKTREE_READY);
    assert.deepEqual(next.history[next.history.length - 1].to, S.WORKTREE_READY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state defaults transient retry tracking and rejects bad counters', () => {
  const dir = tmpDir('state3');
  try {
    const state = makeState(dir);
    delete state.transientRetries;
    stateModule.writeState(dir, state);
    assert.deepEqual(stateModule.readState(dir).transientRetries, {});

    fs.writeFileSync(path.join(dir, 'STATE.json'), JSON.stringify({ ...makeState(dir), transientRetries: { x: -1 } }));
    assert.throws(() => stateModule.readState(dir), /transientRetries/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PID lock refuses live owners, allows stale takeover, and releases cleanly', () => {
  const dir = tmpDir('lock');
  try {
    const lock = acquireLock(dir);
    assert.throws(() => acquireLock(dir), LockError);
    lock.release();
    assert.equal(fs.existsSync(path.join(dir, 'LOCK.json')), false);

    fs.writeFileSync(
      path.join(dir, 'LOCK.json'),
      JSON.stringify({ schemaVersion: 1, pid: process.pid, hostname: os.hostname(), createdUtc: new Date().toISOString() })
    );
    assert.throws(() => acquireLock(dir), LockError);

    const deadPid = 999999;
    assert.equal(isProcessAlive(deadPid), false);
    fs.writeFileSync(
      path.join(dir, 'LOCK.json'),
      JSON.stringify({ schemaVersion: 1, pid: deadPid, hostname: os.hostname(), createdUtc: new Date().toISOString() })
    );
    const takeover = acquireLock(dir);
    takeover.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous or foreign lock files fail closed without being overwritten', () => {
  const dir = tmpDir('lock-ambiguous');
  try {
    const file = path.join(dir, 'LOCK.json');
    fs.writeFileSync(file, 'not json');
    assert.throws(() => acquireLock(dir), LockError);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not json');

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, pid: 1234, hostname: 'foreign-host' }));
    assert.throws(() => acquireLock(dir), LockError);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hostname, 'foreign-host');

    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, hostname: os.hostname() }));
    assert.throws(() => acquireLock(dir), LockError);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale-lock recovery fails closed when a reclaim marker exists', () => {
  const dir = tmpDir('lock-reclaim');
  try {
    const lockFile = path.join(dir, 'LOCK.json');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ schemaVersion: 1, pid: 999999, hostname: os.hostname(), createdUtc: new Date().toISOString() })
    );
    fs.writeFileSync(
      reclaimPath(dir),
      JSON.stringify({ schemaVersion: 1, pid: process.pid, hostname: os.hostname(), createdUtc: new Date().toISOString() })
    );
    const before = fs.readFileSync(lockFile, 'utf8');
    assert.throws(() => acquireLock(dir), LockError);
    try {
      acquireLock(dir);
    } catch (err) {
      assert.match(err.message, /stale-lock recovery/);
      assert.match(err.message, /LOCK\.reclaim\.json/);
      assert.match(err.message, /manually/);
    }
    assert.equal(fs.readFileSync(lockFile, 'utf8'), before, 'a failed contender must not touch the lock');
    assert.equal(fs.existsSync(reclaimPath(dir)), true, 'a failed contender must not remove the marker');

    fs.writeFileSync(reclaimPath(dir), 'not json');
    assert.throws(() => acquireLock(dir), LockError);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('racing lock acquisitions have exactly one winner', async () => {
  const dir = tmpDir('lock-race');
  try {
    const script = path.join(dir, 'race.js');
    fs.writeFileSync(
      script,
      [
        "'use strict';",
        'const { acquireLock } = require(process.argv[2]);',
        'try {',
        "  const lock = acquireLock(process.argv[3]);",
        "  process.stdout.write('ACQUIRED\\n');",
        '  setTimeout(() => { lock.release(); process.exit(0); }, 900);',
        '} catch (err) {',
        "  process.stdout.write('BLOCKED\\n');",
        '  process.exit(0);',
        '}',
      ].join('\n')
    );
    const lockModule = path.join(__dirname, '..', 'lib', 'lock.js');
    const results = await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, [script, lockModule, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.on('data', (chunk) => {
              out += chunk;
            });
            child.on('close', () => resolve(out.includes('ACQUIRED') ? 'acquired' : 'blocked'));
          })
      )
    );
    assert.equal(results.filter((entry) => entry === 'acquired').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent acquisition against a stale lock has exactly one winner', async () => {
  const lockModule = path.join(__dirname, '..', 'lib', 'lock.js');
  for (let round = 0; round < 2; round += 1) {
    const dir = tmpDir(`lock-stale-race-${round}`);
    try {
      fs.writeFileSync(
        path.join(dir, 'LOCK.json'),
        JSON.stringify({ schemaVersion: 1, pid: 999999, hostname: os.hostname(), createdUtc: new Date().toISOString() })
      );
      const script = path.join(dir, 'race.js');
      fs.writeFileSync(
        script,
        [
          "'use strict';",
          'const { acquireLock } = require(process.argv[2]);',
          'try {',
          '  const lock = acquireLock(process.argv[3]);',
          "  process.stdout.write('ACQUIRED ' + process.pid + '\\n');",
          '  setTimeout(() => { lock.release(); process.exit(0); }, 1200);',
          '} catch (err) {',
          "  process.stdout.write('BLOCKED ' + String(err.message).replace(/\\n/g, ' ') + '\\n');",
          '  process.exit(0);',
          '}',
        ].join('\n')
      );
      const results = await Promise.all(
        [0, 1, 2, 3].map(
          () =>
            new Promise((resolve) => {
              const child = spawn(process.execPath, [script, lockModule, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
              let out = '';
              child.stdout.on('data', (chunk) => {
                out += chunk;
              });
              child.on('close', () => resolve(out));
            })
        )
      );
      const winners = results.filter((entry) => entry.includes('ACQUIRED'));
      assert.equal(winners.length, 1, `round ${round}: expected one winner, got ${JSON.stringify(results)}`);
      for (const loser of results.filter((entry) => !entry.includes('ACQUIRED'))) {
        assert.match(loser, /BLOCKED/);
      }
      assert.equal(fs.existsSync(path.join(dir, 'LOCK.json')), false, 'the winner releases its lock');
      assert.equal(fs.existsSync(reclaimPath(dir)), false, 'the reclaim marker is cleaned up');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('event log is append-only', () => {
  const dir = tmpDir('events');
  try {
    events.appendEvent(dir, 'A', { n: 1 });
    const first = fs.readFileSync(events.eventsPath(dir), 'utf8');
    events.appendEvent(dir, 'B', { n: 2 });
    const second = fs.readFileSync(events.eventsPath(dir), 'utf8');
    assert.equal(second.startsWith(first), true);
    const parsed = events.readEvents(dir);
    assert.deepEqual(parsed.map((event) => event.type), ['A', 'B']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function planConfig() {
  const config = loadConfig();
  config.verification.allowedCommands = ['node --test'];
  config.constraints.allowedGlobs = ['src/**', 'lib/**'];
  config.limits.maxTasks = 2;
  config.limits.maxTaskInstructionChars = 100;
  return config;
}

test('plan validation accepts good plans and rejects unsafe ones', () => {
  const config = planConfig();
  const bad = {
    summary: 'sum',
    tasks: [
      { id: 'T1', title: 'one', instruction: 'do it', files: ['src/a.js'], checks: ['node --test'], done: 'done' },
      { id: 'T1', title: 'dupe', instruction: 'do it', files: ['src/b.js'], checks: ['rm -rf /'], done: 'done' },
      { id: 'T3', title: 'escape', instruction: 'do it', files: ['../secret'], checks: [], done: 'done' },
      { id: 'T4', title: 'protected', instruction: 'do it', files: ['.env'], checks: [], done: 'done' },
      { id: 'T5', title: 'too long', instruction: 'x'.repeat(200), files: ['src/c.js'], checks: [], done: 'done' },
    ],
  };
  const validation = planLib.validatePlan(bad, config);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => error.includes('duplicated')), true);
  assert.equal(validation.errors.some((error) => error.includes('allow-listed') || error.includes('allowedCommands')), true);
  assert.equal(validation.errors.some((error) => error.includes('traversal')), true);
  assert.equal(validation.errors.some((error) => error.includes('protected')), true);
  assert.equal(validation.errors.some((error) => error.includes('exceeds')), true);
  assert.equal(validation.errors.some((error) => error.includes('limit is 2')), true);

  const good = {
    summary: 'sum',
    tasks: [{ id: 'T1', title: 'one', instruction: 'do it', files: ['src/a.js'], checks: ['node --test'], done: 'done' }],
  };
  const ok = planLib.validatePlan(good, config);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.tasks[0].files, ['src/a.js']);
});

test('parsePlanResponse handles envelopes, fences, prose, and questions', () => {
  const goodPlan = {
    status: 'PLAN',
    summary: 's',
    tasks: [{ id: 'T1', title: 't', instruction: 'i', files: ['a.js'], checks: [], done: 'd' }],
  };
  const envelope = JSON.stringify({ type: 'result', result: JSON.stringify(goodPlan), usage: {} });
  assert.equal(planLib.parsePlanResponse(envelope).kind, 'PLAN');
  assert.equal(planLib.parsePlanResponse(`intro\n\`\`\`json\n${JSON.stringify(goodPlan)}\n\`\`\``).kind, 'PLAN');
  assert.equal(planLib.parsePlanResponse(`blah ${JSON.stringify(goodPlan)} trailing`).kind, 'PLAN');
  assert.deepEqual(planLib.parsePlanResponse('{"status":"QUESTION","question":"which?"}'), {
    kind: 'QUESTION',
    question: 'which?',
  });
  assert.equal(planLib.parsePlanResponse('no json').kind, 'INVALID');
  assert.equal(planLib.parsePlanResponse('{"status":"QUESTION"}').kind, 'INVALID');
});

test('parseReviewResponse maps verdicts and treats ambiguity as ambiguous', () => {
  const wrap = (value) => JSON.stringify({ type: 'result', result: JSON.stringify(value) });
  assert.deepEqual(reviewLib.parseReviewResponse(wrap({ verdict: 'PASS', notes: 'ok' })), { kind: 'PASS', notes: 'ok' });
  assert.deepEqual(reviewLib.parseReviewResponse(wrap({ verdict: 'FIX', notes: 'fix x' })), { kind: 'FIX', notes: 'fix x' });
  assert.deepEqual(reviewLib.parseReviewResponse(wrap({ verdict: 'QUESTION', question: 'why?' })), {
    kind: 'QUESTION',
    question: 'why?',
    notes: '',
  });
  assert.equal(reviewLib.parseReviewResponse(wrap({ verdict: 'FIX', notes: '' })).kind, 'AMBIGUOUS');
  assert.equal(reviewLib.parseReviewResponse(wrap({ verdict: 'MAYBE' })).kind, 'AMBIGUOUS');
  assert.equal(reviewLib.parseReviewResponse('not json').kind, 'AMBIGUOUS');
});

test('planning skill detection prefers grill-with-docs over grill-me', () => {
  const root = tmpDir('skills');
  try {
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'grill-me'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'grill-me', 'SKILL.md'), '# grill me\n');

    assert.equal(detectPlanningSkill({ repo, home }).name, 'grill-me');
    assert.equal(detectPlanningSkill({ repo: path.join(root, 'missing-repo'), home }).name, 'grill-me');

    fs.mkdirSync(path.join(repo, '.claude', 'skills', 'grill-with-docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'skills', 'grill-with-docs', 'SKILL.md'), '# grill with docs\n');
    const preferred = detectPlanningSkill({ repo, home });
    assert.equal(preferred.name, 'grill-with-docs');
    assert.match(preferred.content, /grill with docs/);

    const opencodeHome = path.join(root, 'opencode-home');
    fs.mkdirSync(path.join(opencodeHome, '.config', 'opencode', 'skills', 'grill-me'), { recursive: true });
    fs.writeFileSync(path.join(opencodeHome, '.config', 'opencode', 'skills', 'grill-me', 'SKILL.md'), '# opencode grill\n');
    assert.equal(detectPlanningSkill({ repo: path.join(root, 'missing-repo'), home: opencodeHome }).name, 'grill-me');

    assert.equal(detectPlanningSkill({ repo: path.join(root, 'missing-repo'), home: path.join(root, 'no-home') }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode overlay default-denies unspecified tools and scopes edits', () => {
  const config = loadConfig();
  const overlay = buildOpenCodeOverlay(config);
  assert.equal(overlay.permission['*'], 'deny', 'unspecified tools must be denied by default');
  assert.deepEqual(overlay.permission.external_directory, { '*': 'deny' });
  assert.deepEqual(overlay.permission.bash, { '*': 'deny' });
  assert.equal(overlay.permission.read['**/.env*'], 'deny');
  assert.equal(overlay.permission.edit['**/.git/**'], 'deny');
  assert.equal(overlay.permission.edit['*'], 'deny');
  assert.equal(overlay.permission.question, 'deny');
  for (const tool of ['grep', 'search', 'task', 'webfetch', 'websearch']) {
    assert.equal(overlay.permission[tool], 'deny', `${tool} must be denied`);
  }
  // The documented edit permission covers the edit/write/patch aliases; separate
  // mutation-tool entries must not be added because they can override the
  // task-scoped edit allows.
  for (const alias of ['write', 'patch', 'multiedit']) {
    assert.equal(overlay.permission[alias], undefined, `${alias} must not override the edit rule`);
  }
  assert.equal(overlay.permission.glob, 'allow');
  assert.equal(overlay.permission.list, 'allow');
  assert.equal(overlay.permission.read['*'], 'allow');
  const editKeys = Object.keys(overlay.permission.edit);
  assert.equal(editKeys[editKeys.length - 1], '**/.git/**', 'protected denials must stay last in edit rules');
  const agent = overlay.agent[config.opencode.agent];
  assert.equal(agent.model, config.opencode.model);
  assert.equal(agent.variant, 'max');
  assert.equal(agent.mode, 'primary');
  assert.equal(agent.steps, config.opencode.maxStepsPerTask, 'the iteration cap is a top-level agent field');
  assert.deepEqual(agent.options, { maxTokens: config.opencode.maxOutputTokens }, 'options carry maxTokens only');

  const scoped = buildOpenCodeOverlay(config, { taskFiles: ['src/app.js', 'made.txt'] });
  assert.equal(scoped.permission.edit['src/app.js'], 'allow');
  assert.equal(scoped.permission.edit['made.txt'], 'allow');
  assert.equal(scoped.permission.edit['*'], 'deny');
  assert.equal(scoped.permission.edit['**/.env*'], 'deny');
  assert.equal(scoped.permission.read['*'], 'allow');
  assert.deepEqual(scoped.permission.bash, { '*': 'deny' });
});

test('opencode overlay honors a configured step cap and optional output cap', () => {
  const config = loadConfig();
  config.opencode.maxStepsPerTask = 3;
  config.opencode.maxOutputTokens = 0;
  const overlay = buildOpenCodeOverlay(config);
  assert.equal(overlay.agent[config.opencode.agent].steps, 3, 'steps must be set on the agent');
  assert.equal(overlay.agent[config.opencode.agent].options, undefined, 'no options when no output cap is set');
  config.opencode.maxOutputTokens = 2048;
  const withTokens = buildOpenCodeOverlay(config);
  assert.equal(withTokens.agent[config.opencode.agent].steps, 3);
  assert.deepEqual(withTokens.agent[config.opencode.agent].options, { maxTokens: 2048 });
});
