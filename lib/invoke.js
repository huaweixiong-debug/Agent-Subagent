'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureDir, nowIso, readJsonFile, writeFileAtomic } = require('./util');

class InvokeError extends Error {}

const DEFAULT_FORBIDDEN_ARGS = ['--auto', '--dangerously-skip-permissions'];

function assertNoForbiddenArgs(args, forbidden = DEFAULT_FORBIDDEN_ARGS) {
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new InvokeError('process arguments must be strings');
    }
    if (forbidden.includes(arg)) {
      throw new InvokeError(`refusing to pass ${arg} to a CLI invocation`);
    }
  }
}

function quoteWindowsArg(arg) {
  if (typeof arg !== 'string') throw new InvokeError('process arguments must be strings');
  if (arg.includes('\0')) throw new InvokeError('process arguments must not contain NUL');
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += `${'\\'.repeat(backslashes * 2)}"`;
  return result;
}

function buildWindowsCommandLine(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new InvokeError('cannot build an empty command line');
  }
  return argv.map(quoteWindowsArg).join(' ');
}

function buildWindowsArguments(argv) {
  if (!Array.isArray(argv)) throw new InvokeError('arguments must be an array');
  return argv.map(quoteWindowsArg).join(' ');
}

function splitCommandArgs(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new InvokeError('command must be a non-empty string');
  }
  const args = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) throw new InvokeError(`unbalanced quote in command: ${command}`);
  if (hasToken) args.push(current);
  return args;
}

function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

function buildChildEnv(overrides = {}, unset = []) {
  const env = { ...process.env };
  // Apply explicit overrides first, replacing any case variant already inherited.
  for (const [key, value] of Object.entries(overrides)) {
    for (const candidate of Object.keys(env)) {
      if (candidate.toLowerCase() === key.toLowerCase()) delete env[candidate];
    }
    env[key] = String(value);
  }
  // Removal must win over both inherited and explicitly configured values,
  // case-insensitively, so run the removal pass last.
  const blocked = new Set(unset.map((name) => String(name).toLowerCase()));
  for (const key of Object.keys(env)) {
    if (blocked.has(key.toLowerCase())) delete env[key];
  }
  return env;
}

function resolveExecutable(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new InvokeError('command must be a non-empty string');
  }
  const hasSeparator = /[\\/]/.test(command);
  const candidates = [];
  if (platform === 'win32') {
    const hasExtension = /\.[^\\/]+$/.test(command);
    const extensions = hasExtension
      ? ['']
      : String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((ext) => ext.trim().toLowerCase())
          .filter(Boolean)
          .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
    const dirs = hasSeparator
      ? [null]
      : String(envValue(env, 'PATH') || '')
          .split(path.delimiter)
          .map((dir) => dir.trim())
          .filter(Boolean);
    for (const dir of dirs) {
      const base = dir === null ? path.resolve(command) : path.join(dir, command);
      for (const ext of extensions) candidates.push(base + ext);
    }
  } else {
    const dirs = hasSeparator
      ? [null]
      : String(envValue(env, 'PATH') || '')
          .split(path.delimiter)
          .filter(Boolean);
    for (const dir of dirs) {
      candidates.push(dir === null ? path.resolve(command) : path.join(dir, command));
    }
  }
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      if (ext !== '.exe' && ext !== '.com') {
        throw new InvokeError(
          `command "${command}" resolves to "${candidate}", but this adapter only runs native .exe ` +
            'executables (shell shims are refused). Point claude.command / opencode.command at a ' +
            'native executable, or use node with argsPrefix (see README "CLI shims on Windows").'
        );
      }
    }
    return candidate;
  }
  throw new InvokeError(`command not found on PATH: ${command}`);
}

function toTokenNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstTokenNumber(...values) {
  for (const value of values) {
    const number = toTokenNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function openCodeStepUsage(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const explicitTotal = toTokenNumber(tokens.total);
  const input = firstTokenNumber(tokens.input, tokens.input_tokens, tokens.prompt_tokens);
  const output = firstTokenNumber(tokens.output, tokens.output_tokens, tokens.completion_tokens);
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : null;
  const cacheRead = cache ? firstTokenNumber(cache.read, cache.read_tokens) : null;
  const cacheWrite = cache ? firstTokenNumber(cache.write, cache.write_tokens) : null;
  if (explicitTotal !== null) {
    return { input: input ?? 0, output: output ?? 0, total: explicitTotal };
  }
  const parts = [input, output, cacheRead, cacheWrite].filter((value) => value !== null);
  if (parts.length === 0) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    total: parts.reduce((sum, value) => sum + value, 0),
  };
}

function isStepFinishEvent(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (candidate.type === 'step_finish' || candidate.type === 'step-finish') return true;
  const part = candidate.part;
  return Boolean(
    part && typeof part === 'object' && (part.type === 'step-finish' || part.type === 'step_finish')
  );
}

function stepSnapshotKey(candidate) {
  const part = candidate && candidate.part;
  if (!part || typeof part !== 'object') return null;
  for (const field of ['id', 'messageID', 'snapshot']) {
    if (typeof part[field] === 'string' && part[field] !== '') return `${field}:${part[field]}`;
  }
  return null;
}

function parseUsage(stdout) {
  const unknown = { known: false, inputTokens: null, outputTokens: null, total: null, source: null };
  const text = String(stdout || '').trim();
  if (!text) return unknown;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const objects = [];
  if (lines.length > 1) {
    try {
      objects.push(JSON.parse(text));
    } catch {
      /* not a single pretty-printed JSON document */
    }
  }
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      /* line is not JSON */
    }
  }
  // OpenCode --format json emits NDJSON events; completed model steps report usage
  // on step_finish.part.tokens. Sum each completed step exactly once, ignore
  // duplicate snapshots of the same step, and stay unknown unless every step
  // reports usable tokens (unknown usage is never treated as zero).
  const seenSteps = new Set();
  let sawStepFinish = false;
  let incompleteStep = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let total = 0;
  for (const candidate of objects) {
    if (!isStepFinishEvent(candidate)) continue;
    const key = stepSnapshotKey(candidate);
    if (key !== null) {
      if (seenSteps.has(key)) continue;
      seenSteps.add(key);
    }
    sawStepFinish = true;
    const step = openCodeStepUsage(candidate.part && candidate.part.tokens);
    if (!step) {
      incompleteStep = true;
      continue;
    }
    inputTokens += step.input;
    outputTokens += step.output;
    total += step.total;
  }
  if (sawStepFinish && !incompleteStep) {
    return { known: true, inputTokens, outputTokens, total, source: 'opencode-events' };
  }
  if (incompleteStep) return unknown;
  // Claude-compatible envelopes and simple usage objects remain supported. An
  // explicit total wins; otherwise both input and output counts are required and
  // optional prompt-cache creation/read counts are added to the input total. A
  // partial report is unknown, never zero.
  for (const candidate of objects) {
    if (!candidate || typeof candidate !== 'object') continue;
    const usage = candidate.usage || (candidate.data && candidate.data.usage);
    if (!usage || typeof usage !== 'object') continue;
    const explicitTotal = toTokenNumber(usage.total ?? usage.total_tokens);
    const input = toTokenNumber(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
    const output = toTokenNumber(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
    const cacheCreation =
      toTokenNumber(
        usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ?? usage.cacheCreationInputTokens
      ) ?? 0;
    const cacheRead =
      toTokenNumber(usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cacheReadInputTokens) ?? 0;
    if (explicitTotal !== null) {
      return {
        known: true,
        inputTokens: (input ?? 0) + cacheCreation + cacheRead,
        outputTokens: output ?? 0,
        total: explicitTotal,
        source: 'json',
      };
    }
    if (input !== null && output !== null) {
      const resolvedInput = input + cacheCreation + cacheRead;
      return {
        known: true,
        inputTokens: resolvedInput,
        outputTokens: output,
        total: resolvedInput + output,
        source: 'json',
      };
    }
  }
  return unknown;
}

const PERMISSION_FAILURE_PATTERNS = [
  /permission denied/i,
  /access is denied/i,
  /operation not permitted/i,
  /\bEACCES\b/,
  /\bEPERM\b/,
];

const AUTH_FAILURE_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthoriz/i,
  /unauthoris/i,
  /authentication/i,
  /invalid api key/i,
  /not logged in/i,
  /login required/i,
  /please log ?in/i,
  /token (expired|invalid)/i,
  /credential/i,
];

const TRANSIENT_FAILURE_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /EPIPE/,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /temporar/i,
];

function classifyCliFailure(result) {
  const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
  const detail =
    String((result && (result.stderr || result.stdout)) || '')
      .trim()
      .slice(0, 800) || `<no diagnostic output, exit ${exitCode}>`;
  const failure = (kind, text) => ({ kind, detail: text, exitCode });
  if (result && result.timedOut === true) {
    return failure('transient', `command timed out: ${detail}`);
  }
  const text = `${(result && result.stderr) || ''}\n${(result && result.stdout) || ''}`;
  if (/not recognized|cannot find the (file|path)|\bENOENT\b/i.test(text)) {
    return failure('missing', detail);
  }
  if (PERMISSION_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return failure('permission', detail);
  }
  if (AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return failure('auth', detail);
  }
  if (TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return failure('transient', detail);
  }
  return failure('unknown', detail);
}

function runDirect(options) {
  const {
    command,
    args,
    cwd,
    env,
    stdinText = '',
    timeoutMs,
    stdoutPath,
    stderrPath,
  } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timedOut = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      finish({
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout: '',
        stderr: err.message,
        spawnError: err.message,
      });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* process may already be gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        exitCode: null,
        timedOut,
        durationMs: Date.now() - started,
        stdout: '',
        stderr: err.message,
        spawnError: err.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdoutPath) fs.writeFileSync(stdoutPath, stdout, 'utf8');
      if (stderrPath) fs.writeFileSync(stderrPath, stderr, 'utf8');
      finish({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
    try {
      child.stdin.end(stdinText);
    } catch {
      /* stdin may already be closed */
    }
  });
}

async function runPowerShell(options) {
  const { packageRoot, command, argsPrefix = [], args = [], cwd, env = {}, stdinText = '', timeoutMs, evidenceDir, label } = options;
  ensureDir(evidenceDir);
  const stdoutPath = path.join(evidenceDir, `${label}.stdout.log`);
  const stderrPath = path.join(evidenceDir, `${label}.stderr.log`);
  const resultPath = path.join(evidenceDir, `${label}.result.json`);
  const stdinPath = path.join(evidenceDir, `${label}.stdin.txt`);
  const payloadPath = path.join(evidenceDir, `${label}.payload.json`);
  fs.writeFileSync(stdinPath, stdinText, 'utf8');
  const payload = {
    schemaVersion: 1,
    label,
    command,
    argsPrefix,
    args,
    arguments: buildWindowsArguments([...argsPrefix, ...args]),
    cwd,
    envKeys: options.envKeys || Object.keys(env),
    unsetEnv: options.unsetEnv || [],
    timeoutMs,
    stdinFile: stdinPath,
    stdoutFile: stdoutPath,
    stderrFile: stderrPath,
    resultFile: resultPath,
  };
  writeFileAtomic(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
  const ps1Path = path.join(packageRoot, 'scripts', 'invoke-cli.ps1');
  const psArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ps1Path,
    '-PayloadFile',
    payloadPath,
  ];
  const psRun = await runDirect({
    command: 'powershell.exe',
    args: psArgs,
    cwd,
    env,
    stdinText: '',
    timeoutMs: timeoutMs + 20000,
    stdoutPath: path.join(evidenceDir, `${label}.adapter.stdout.log`),
    stderrPath: path.join(evidenceDir, `${label}.adapter.stderr.log`),
  });
  if (!fs.existsSync(resultPath)) {
    throw new InvokeError(
      `process adapter failed for "${label}" (powershell exit ${psRun.exitCode}); ` +
        `adapter stderr: ${(psRun.stderr || psRun.stdout || '<empty>').slice(0, 600)}`
    );
  }
  const result = readJsonFile(resultPath, `${label}.result.json`);
  const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    durationMs: result.durationMs,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    payloadPath,
    resultPath,
  };
}

async function runDirectAdapter(options) {
  const { command, argsPrefix = [], args = [], cwd, env = {}, stdinText = '', timeoutMs, evidenceDir, label } = options;
  ensureDir(evidenceDir);
  const stdoutPath = path.join(evidenceDir, `${label}.stdout.log`);
  const stderrPath = path.join(evidenceDir, `${label}.stderr.log`);
  const run = await runDirect({
    command,
    args: [...argsPrefix, ...args],
    cwd,
    env,
    stdinText,
    timeoutMs,
    stdoutPath,
    stderrPath,
  });
  if (run.spawnError) {
    throw new InvokeError(`failed to start "${label}": ${run.spawnError}`);
  }
  return {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
    stdoutPath,
    stderrPath,
  };
}

async function runCommand(options) {
  if (!options || !options.packageRoot) throw new InvokeError('runCommand requires packageRoot');
  if (!options.evidenceDir) throw new InvokeError('runCommand requires evidenceDir');
  if (!options.label) throw new InvokeError('runCommand requires label');
  const mode = options.mode || (process.platform === 'win32' ? 'powershell' : 'direct');
  const argsPrefix = options.argsPrefix || [];
  const args = options.args || [];
  const unsetEnv = options.unsetEnv || [];
  assertNoForbiddenArgs([...argsPrefix, ...args]);
  const childEnv = buildChildEnv(options.env || {}, unsetEnv);
  const resolved = resolveExecutable(options.command, { env: childEnv });
  const adapted =
    mode === 'powershell'
      ? await runPowerShell({
          ...options,
          command: resolved,
          argsPrefix,
          args,
          env: childEnv,
          envKeys: Object.keys(options.env || {}),
          unsetEnv,
        })
      : await runDirectAdapter({ ...options, command: resolved, argsPrefix, args, env: childEnv });
  const invokeRecord = {
    schemaVersion: 1,
    label: options.label,
    ts: nowIso(),
    mode,
    command: resolved,
    argsPrefix,
    args,
    cwd: options.cwd,
    envKeys: Object.keys(options.env || {}),
    unsetEnv,
    exitCode: adapted.exitCode,
    timedOut: adapted.timedOut,
    durationMs: adapted.durationMs,
    stdoutFile: path.basename(adapted.stdoutPath),
    stderrFile: path.basename(adapted.stderrPath),
  };
  const invokePath = path.join(options.evidenceDir, `${options.label}.invoke.json`);
  writeFileAtomic(invokePath, `${JSON.stringify(invokeRecord, null, 2)}\n`);
  return { ...adapted, invokePath };
}

module.exports = {
  InvokeError,
  assertNoForbiddenArgs,
  quoteWindowsArg,
  buildWindowsCommandLine,
  buildWindowsArguments,
  splitCommandArgs,
  buildChildEnv,
  resolveExecutable,
  parseUsage,
  classifyCliFailure,
  runDirect,
  runCommand,
};
