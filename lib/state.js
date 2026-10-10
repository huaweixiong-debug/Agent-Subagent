'use strict';

const path = require('path');
const { nowIso, readJsonFile, writeFileAtomic } = require('./util');

const STATUS = Object.freeze({
  CREATED: 'CREATED',
  WORKTREE_READY: 'WORKTREE_READY',
  PLANNING: 'PLANNING',
  PLAN_READY: 'PLAN_READY',
  TASK_RUNNING: 'TASK_RUNNING',
  TASK_REVIEWING: 'TASK_REVIEWING',
  TASK_FIXING: 'TASK_FIXING',
  TASK_DONE: 'TASK_DONE',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  FAILED: 'FAILED',
  COMPLETE: 'COMPLETE',
});

const TRANSITIONS = Object.freeze({
  [STATUS.CREATED]: [STATUS.WORKTREE_READY, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.WORKTREE_READY]: [STATUS.PLANNING, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.PLANNING]: [STATUS.PLAN_READY, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.PLAN_READY]: [STATUS.TASK_RUNNING, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.TASK_RUNNING]: [STATUS.TASK_REVIEWING, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.TASK_REVIEWING]: [
    STATUS.TASK_DONE,
    STATUS.TASK_FIXING,
    STATUS.NEEDS_HUMAN,
    STATUS.FAILED,
  ],
  [STATUS.TASK_FIXING]: [STATUS.TASK_REVIEWING, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.TASK_DONE]: [STATUS.TASK_RUNNING, STATUS.COMPLETE, STATUS.NEEDS_HUMAN, STATUS.FAILED],
  [STATUS.NEEDS_HUMAN]: [],
  [STATUS.FAILED]: [],
  [STATUS.COMPLETE]: [],
});

const TERMINAL = [STATUS.FAILED, STATUS.COMPLETE];

class StateError extends Error {}

function statePath(runDir) {
  return path.join(runDir, 'STATE.json');
}

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function assertTransition(state, to) {
  if (!Object.values(STATUS).includes(to)) {
    throw new StateError(`unknown target status: ${to}`);
  }
  if (state.status === STATUS.NEEDS_HUMAN) {
    if (to !== STATUS.NEEDS_HUMAN && to === state.resumeStatus && state.question) {
      return;
    }
    throw new StateError(`invalid transition ${state.status} -> ${to}`);
  }
  const allowed = TRANSITIONS[state.status] || [];
  if (!allowed.includes(to)) {
    throw new StateError(`invalid transition ${state.status} -> ${to}`);
  }
}

function createState(fields) {
  return {
    schemaVersion: 1,
    status: STATUS.CREATED,
    question: null,
    resumeStatus: null,
    stopKind: null,
    stopReason: null,
    planAttempts: 0,
    planFeedback: null,
    taskIndex: 0,
    fixCounts: {},
    tokensUsed: 0,
    invocations: 0,
    answers: [],
    transientRetries: {},
    auditAcknowledged: false,
    violationAcknowledged: false,
    history: [],
    ...fields,
  };
}

function validateState(state, source) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new StateError(`${source}: run state must be a JSON object`);
  }
  if (state.schemaVersion !== 1) {
    throw new StateError(`${source}: unsupported schemaVersion`);
  }
  if (!Object.values(STATUS).includes(state.status)) {
    throw new StateError(`${source}: unknown status "${state.status}"`);
  }
  for (const key of ['runId', 'repo', 'commonDir', 'runDir', 'worktree', 'branch', 'baseHead', 'createdUtc']) {
    if (typeof state[key] !== 'string' || state[key] === '') {
      throw new StateError(`${source}: missing string field "${key}"`);
    }
  }
  for (const key of ['planAttempts', 'taskIndex', 'tokensUsed', 'invocations']) {
    if (!Number.isInteger(state[key]) || state[key] < 0) {
      throw new StateError(`${source}: field "${key}" must be a non-negative integer`);
    }
  }
  if (!state.fixCounts || typeof state.fixCounts !== 'object' || Array.isArray(state.fixCounts)) {
    throw new StateError(`${source}: field "fixCounts" must be an object`);
  }
  if (!Array.isArray(state.answers)) {
    throw new StateError(`${source}: field "answers" must be an array`);
  }
  if (state.transientRetries === undefined) {
    state.transientRetries = {};
  }
  if (!state.transientRetries || typeof state.transientRetries !== 'object' || Array.isArray(state.transientRetries)) {
    throw new StateError(`${source}: field "transientRetries" must be an object`);
  }
  for (const [key, value] of Object.entries(state.transientRetries)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new StateError(`${source}: transientRetries["${key}"] must be a non-negative integer`);
    }
  }
  if (!Array.isArray(state.history)) {
    throw new StateError(`${source}: field "history" must be an array`);
  }
  return state;
}

function readState(runDir) {
  return validateState(readJsonFile(statePath(runDir), 'STATE.json'), 'STATE.json');
}

function writeState(runDir, state) {
  state.updatedUtc = nowIso();
  writeFileAtomic(statePath(runDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function patchState(runDir, mutator) {
  const state = readState(runDir);
  const patch = mutator(state) || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'status') && patch.status !== state.status) {
    throw new StateError('patchState cannot change status; use setStatus');
  }
  const next = { ...state, ...patch };
  return writeState(runDir, next);
}

function setStatus(runDir, to, patch = {}) {
  const state = readState(runDir);
  assertTransition(state, to);
  const history = [...state.history, { from: state.status, to, ts: nowIso() }].slice(-200);
  const next = { ...state, ...patch, status: to, history };
  if (state.status === STATUS.NEEDS_HUMAN && to !== STATUS.NEEDS_HUMAN) {
    next.question = null;
    next.resumeStatus = null;
    next.stopKind = null;
  }
  return writeState(runDir, next);
}

module.exports = {
  STATUS,
  TRANSITIONS,
  TERMINAL,
  StateError,
  statePath,
  isTerminal,
  assertTransition,
  createState,
  validateState,
  readState,
  writeState,
  patchState,
  setStatus,
};
