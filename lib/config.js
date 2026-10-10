'use strict';

const path = require('path');
const { readJsonFile } = require('./util');
const { splitCommandArgs } = require('./invoke');

class ConfigError extends Error {}

const MANAGED_CLAUDE_ARGS = [
  '-p',
  '--print',
  '--output-format',
  '--model',
  '--permission-mode',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--max-turns',
  '--max-budget-usd',
  '--dangerously-skip-permissions',
  '--auto',
];

const MANAGED_OPENCODE_ARGS = ['--auto', '-m', '--model', '--agent', '--variant'];

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  claude: {
    command: 'claude',
    argsPrefix: [],
    planModel: 'opus',
    reviewModel: 'opus',
    outputFormat: 'json',
    permissionMode: 'plan',
    maxTurns: 40,
    maxBudgetUsd: 5,
    allowedTools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['AskUserQuestion'],
    extraArgs: [],
    env: {},
  },
  opencode: {
    command: 'opencode',
    argsPrefix: [],
    model: 'deepseek/deepseek-flash',
    variant: 'max',
    agent: 'agent-loop-executor',
    maxOutputTokens: 8192,
    maxStepsPerTask: 8,
    extraArgs: [],
    env: {},
  },
  limits: {
    maxPlanAttempts: 2,
    maxTasks: 20,
    maxFixPerTask: 1,
    maxTokenBudget: 2000000,
    commandTimeoutMs: 900000,
    maxTransientRetries: 1,
    maxTaskInstructionChars: 20000,
    maxReviewEvidenceChars: 400000,
  },
  verification: {
    allowedCommands: [],
  },
  constraints: {
    allowedGlobs: ['**'],
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${label}: unknown key "${key}"`);
    }
  }
}

function expectString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ConfigError(`${label}: expected a string`);
  if (!allowEmpty && value.trim() === '') throw new ConfigError(`${label}: must not be empty`);
  return value;
}

function expectStringArray(value, label) {
  if (!Array.isArray(value)) throw new ConfigError(`${label}: expected an array of strings`);
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      throw new ConfigError(`${label}[${index}]: expected a non-empty string`);
    }
  });
  return [...value];
}

function expectInt(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${label}: expected an integer between ${min} and ${max}`);
  }
  return value;
}

function expectNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${label}: expected a number between ${min} and ${max}`);
  }
  return value;
}

function expectExtraArgs(value, label, managedFlags) {
  const entries = expectStringArray(value, label);
  for (const entry of entries) {
    const flag = entry.split('=')[0];
    if (managedFlags.includes(flag)) {
      throw new ConfigError(`${label}: "${entry}" would override a runner-managed flag`);
    }
  }
  return entries;
}

function expectEnvMap(value, label) {
  if (!isPlainObject(value)) throw new ConfigError(`${label}: expected an object of string values`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new ConfigError(`${label}.${key}: expected a string`);
    result[key] = entry;
  }
  return result;
}

function validateAllowedCommands(commands, label) {
  expectStringArray(commands, label);
  commands.forEach((command, index) => {
    let argv;
    try {
      argv = splitCommandArgs(command);
    } catch (err) {
      throw new ConfigError(`${label}[${index}]: ${err.message}`);
    }
    if (argv.length === 0) throw new ConfigError(`${label}[${index}]: command is empty`);
  });
  return [...commands];
}

function validateUserConfig(user, label) {
  if (!isPlainObject(user)) {
    throw new ConfigError(`${label}: top-level config must be a JSON object`);
  }
  expectKeys(user, ['schemaVersion', 'claude', 'opencode', 'limits', 'verification', 'constraints'], label);
  if (user.schemaVersion !== undefined && user.schemaVersion !== 1) {
    throw new ConfigError(`${label}.schemaVersion: must be 1`);
  }
  const out = {};

  if (user.claude !== undefined) {
    const source = user.claude;
    if (!isPlainObject(source)) throw new ConfigError(`${label}.claude: expected an object`);
    expectKeys(
      source,
      [
        'command',
        'argsPrefix',
        'planModel',
        'reviewModel',
        'outputFormat',
        'permissionMode',
        'maxTurns',
        'maxBudgetUsd',
        'allowedTools',
        'disallowedTools',
        'extraArgs',
        'env',
      ],
      'claude'
    );
    out.claude = {};
    if (source.command !== undefined) out.claude.command = expectString(source.command, 'claude.command');
    if (source.argsPrefix !== undefined) out.claude.argsPrefix = expectStringArray(source.argsPrefix, 'claude.argsPrefix');
    if (source.planModel !== undefined) out.claude.planModel = expectString(source.planModel, 'claude.planModel');
    if (source.reviewModel !== undefined) out.claude.reviewModel = expectString(source.reviewModel, 'claude.reviewModel');
    if (source.outputFormat !== undefined) {
      if (source.outputFormat !== 'json' && source.outputFormat !== 'text') {
        throw new ConfigError('claude.outputFormat: must be "json" or "text"');
      }
      out.claude.outputFormat = source.outputFormat;
    }
    if (source.permissionMode !== undefined) {
      if (source.permissionMode !== 'plan' && source.permissionMode !== 'default') {
        throw new ConfigError('claude.permissionMode: must be "plan" (read-only) or "default"');
      }
      out.claude.permissionMode = source.permissionMode;
    }
    if (source.maxTurns !== undefined) {
      out.claude.maxTurns = expectInt(source.maxTurns, 'claude.maxTurns', { min: 1, max: 1000 });
    }
    if (source.maxBudgetUsd !== undefined) {
      out.claude.maxBudgetUsd = expectNumber(source.maxBudgetUsd, 'claude.maxBudgetUsd', { min: 0.01, max: 1000 });
    }
    if (source.allowedTools !== undefined) out.claude.allowedTools = expectStringArray(source.allowedTools, 'claude.allowedTools');
    if (source.disallowedTools !== undefined) {
      out.claude.disallowedTools = expectStringArray(source.disallowedTools, 'claude.disallowedTools');
    }
    if (source.extraArgs !== undefined) {
      out.claude.extraArgs = expectExtraArgs(source.extraArgs, 'claude.extraArgs', MANAGED_CLAUDE_ARGS);
    }
    if (source.env !== undefined) out.claude.env = expectEnvMap(source.env, 'claude.env');
  }

  if (user.opencode !== undefined) {
    const source = user.opencode;
    if (!isPlainObject(source)) throw new ConfigError(`${label}.opencode: expected an object`);
    expectKeys(
      source,
      ['command', 'argsPrefix', 'model', 'variant', 'agent', 'maxOutputTokens', 'maxStepsPerTask', 'extraArgs', 'env'],
      'opencode'
    );
    out.opencode = {};
    if (source.command !== undefined) out.opencode.command = expectString(source.command, 'opencode.command');
    if (source.argsPrefix !== undefined) out.opencode.argsPrefix = expectStringArray(source.argsPrefix, 'opencode.argsPrefix');
    if (source.model !== undefined) out.opencode.model = expectString(source.model, 'opencode.model');
    if (source.variant !== undefined) {
      out.opencode.variant = expectString(source.variant, 'opencode.variant', { allowEmpty: true });
    }
    if (source.agent !== undefined) out.opencode.agent = expectString(source.agent, 'opencode.agent');
    if (source.maxOutputTokens !== undefined) {
      out.opencode.maxOutputTokens = expectInt(source.maxOutputTokens, 'opencode.maxOutputTokens', { min: 0, max: 1000000 });
    }
    if (source.maxStepsPerTask !== undefined) {
      out.opencode.maxStepsPerTask = expectInt(source.maxStepsPerTask, 'opencode.maxStepsPerTask', { min: 1, max: 200 });
    }
    if (source.extraArgs !== undefined) {
      out.opencode.extraArgs = expectExtraArgs(source.extraArgs, 'opencode.extraArgs', MANAGED_OPENCODE_ARGS);
    }
    if (source.env !== undefined) out.opencode.env = expectEnvMap(source.env, 'opencode.env');
  }

  if (user.limits !== undefined) {
    const source = user.limits;
    if (!isPlainObject(source)) throw new ConfigError(`${label}.limits: expected an object`);
    expectKeys(
      source,
      [
        'maxPlanAttempts',
        'maxTasks',
        'maxFixPerTask',
        'maxTokenBudget',
        'commandTimeoutMs',
        'maxTransientRetries',
        'maxTaskInstructionChars',
        'maxReviewEvidenceChars',
      ],
      'limits'
    );
    out.limits = {};
    if (source.maxPlanAttempts !== undefined) out.limits.maxPlanAttempts = expectInt(source.maxPlanAttempts, 'limits.maxPlanAttempts', { min: 1, max: 10 });
    if (source.maxTasks !== undefined) out.limits.maxTasks = expectInt(source.maxTasks, 'limits.maxTasks', { min: 1, max: 200 });
    if (source.maxFixPerTask !== undefined) {
      if (source.maxFixPerTask !== 0 && source.maxFixPerTask !== 1) {
        throw new ConfigError('limits.maxFixPerTask: must be 0 or 1 (at most one bounded repair cycle)');
      }
      out.limits.maxFixPerTask = source.maxFixPerTask;
    }
    if (source.maxTokenBudget !== undefined) {
      out.limits.maxTokenBudget = expectInt(source.maxTokenBudget, 'limits.maxTokenBudget', { min: 0 });
    }
    if (source.commandTimeoutMs !== undefined) {
      out.limits.commandTimeoutMs = expectInt(source.commandTimeoutMs, 'limits.commandTimeoutMs', { min: 1000 });
    }
    if (source.maxTransientRetries !== undefined) {
      if (source.maxTransientRetries !== 0 && source.maxTransientRetries !== 1) {
        throw new ConfigError('limits.maxTransientRetries: must be 0 or 1 (at most one bounded automatic retry)');
      }
      out.limits.maxTransientRetries = source.maxTransientRetries;
    }
    if (source.maxTaskInstructionChars !== undefined) {
      out.limits.maxTaskInstructionChars = expectInt(source.maxTaskInstructionChars, 'limits.maxTaskInstructionChars', { min: 500, max: 30000 });
    }
    if (source.maxReviewEvidenceChars !== undefined) {
      out.limits.maxReviewEvidenceChars = expectInt(source.maxReviewEvidenceChars, 'limits.maxReviewEvidenceChars', { min: 1000 });
    }
  }

  if (user.verification !== undefined) {
    const source = user.verification;
    if (!isPlainObject(source)) throw new ConfigError(`${label}.verification: expected an object`);
    expectKeys(source, ['allowedCommands'], 'verification');
    out.verification = {};
    if (source.allowedCommands !== undefined) {
      out.verification.allowedCommands = validateAllowedCommands(source.allowedCommands, 'verification.allowedCommands');
    }
  }

  if (user.constraints !== undefined) {
    const source = user.constraints;
    if (!isPlainObject(source)) throw new ConfigError(`${label}.constraints: expected an object`);
    expectKeys(source, ['allowedGlobs'], 'constraints');
    out.constraints = {};
    if (source.allowedGlobs !== undefined) {
      out.constraints.allowedGlobs = expectStringArray(source.allowedGlobs, 'constraints.allowedGlobs');
    }
  }

  return out;
}

function loadConfig(configPath) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!configPath) return base;
  const user = readJsonFile(configPath, path.resolve(configPath));
  const validated = validateUserConfig(user, path.resolve(configPath));
  return {
    schemaVersion: 1,
    claude: { ...base.claude, ...(validated.claude || {}), env: { ...(validated.claude || {}).env } },
    opencode: { ...base.opencode, ...(validated.opencode || {}), env: { ...(validated.opencode || {}).env } },
    limits: { ...base.limits, ...(validated.limits || {}) },
    verification: { ...base.verification, ...(validated.verification || {}) },
    constraints: { ...base.constraints, ...(validated.constraints || {}) },
  };
}

module.exports = { ConfigError, DEFAULT_CONFIG, validateUserConfig, loadConfig };
