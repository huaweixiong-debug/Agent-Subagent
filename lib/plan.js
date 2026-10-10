'use strict';

const path = require('path');
const { ensureDir, readJsonFile, writeFileAtomic } = require('./util');
const { normalizeRepoRelative, matchesAnyGlob } = require('./paths');

function extractClaudeText(stdout) {
  const text = String(stdout || '');
  try {
    const envelope = JSON.parse(text.trim());
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      if (typeof envelope.result === 'string') return envelope.result;
      if (typeof envelope.error === 'string') return `ERROR: ${envelope.error}`;
    }
  } catch {
    /* stdout is not a single JSON envelope */
  }
  return text;
}

function fencedBlocks(text) {
  const blocks = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

function balancedObjects(text, limit = 100) {
  const objects = [];
  for (let i = 0; i < text.length && objects.length < limit; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return objects;
}

function parseStructuredJson(text) {
  const candidates = [String(text || '').trim(), ...fencedBlocks(text), ...balancedObjects(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function parsePlanResponse(stdout) {
  const text = extractClaudeText(stdout);
  const object = parseStructuredJson(text);
  if (!object) {
    return { kind: 'INVALID', error: 'response did not contain a JSON object', excerpt: text.slice(0, 400) };
  }
  const status = typeof object.status === 'string' ? object.status.toUpperCase() : Array.isArray(object.tasks) ? 'PLAN' : '';
  if (status === 'QUESTION') {
    const question = typeof object.question === 'string' ? object.question.trim() : '';
    if (!question) {
      return { kind: 'INVALID', error: 'QUESTION response is missing question text', excerpt: text.slice(0, 400) };
    }
    return { kind: 'QUESTION', question };
  }
  if (status === 'PLAN' || Array.isArray(object.tasks)) {
    return { kind: 'PLAN', plan: object };
  }
  return { kind: 'INVALID', error: `unrecognized plan response shape (status: ${object.status || '<none>'})`, excerpt: text.slice(0, 400) };
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

function validatePlan(plan, config) {
  const errors = [];
  const limits = config.limits;
  const source = plan && typeof plan === 'object' ? plan : {};
  let summary = '';
  if (typeof source.summary !== 'string' || source.summary.trim() === '') {
    errors.push('summary must be a non-empty string');
  } else {
    summary = source.summary.trim();
    if (summary.length > 4000) errors.push('summary is too long (max 4000 characters)');
  }
  const normalizedTasks = [];
  if (!Array.isArray(source.tasks)) {
    errors.push('tasks must be an array');
  } else {
    if (source.tasks.length < 1) errors.push('plan must contain at least one task');
    if (source.tasks.length > limits.maxTasks) {
      errors.push(`plan has ${source.tasks.length} tasks but the limit is ${limits.maxTasks}`);
    }
    const seenIds = new Set();
    source.tasks.slice(0, 200).forEach((task, index) => {
      const where = `tasks[${index}]`;
      if (!task || typeof task !== 'object' || Array.isArray(task)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const id = typeof task.id === 'string' ? task.id.trim() : '';
      if (!TASK_ID_PATTERN.test(id)) {
        errors.push(`${where}.id must match ${TASK_ID_PATTERN} (got "${task.id}")`);
      } else if (seenIds.has(id)) {
        errors.push(`${where}.id "${id}" is duplicated`);
      }
      seenIds.add(id);
      const title = typeof task.title === 'string' ? task.title.trim() : '';
      if (!title || title.length > 300) errors.push(`${where}.title must be 1-300 characters`);
      const instruction = typeof task.instruction === 'string' ? task.instruction.trim() : '';
      if (!instruction) errors.push(`${where}.instruction must be a non-empty string`);
      else if (instruction.length > limits.maxTaskInstructionChars) {
        errors.push(`${where}.instruction exceeds ${limits.maxTaskInstructionChars} characters`);
      }
      const done = typeof task.done === 'string' ? task.done.trim() : '';
      if (!done || done.length > 1000) errors.push(`${where}.done must be 1-1000 characters`);
      const files = [];
      if (!Array.isArray(task.files) || task.files.length === 0) {
        errors.push(`${where}.files must be a non-empty array of repository-relative paths`);
      } else if (task.files.length > 50) {
        errors.push(`${where}.files has more than 50 entries`);
      } else {
        task.files.forEach((file, fileIndex) => {
          const normalized = normalizeRepoRelative(file);
          if (!normalized.ok) {
            errors.push(`${where}.files[${fileIndex}]: ${normalized.error}`);
            return;
          }
          if (!matchesAnyGlob(normalized.normalized, config.constraints.allowedGlobs)) {
            errors.push(
              `${where}.files[${fileIndex}] "${normalized.normalized}" is outside the allowed globs ${JSON.stringify(
                config.constraints.allowedGlobs
              )}`
            );
            return;
          }
          files.push(normalized.normalized);
        });
      }
      const checks = [];
      if (!Array.isArray(task.checks)) {
        errors.push(`${where}.checks must be an array of allow-listed command strings`);
      } else if (task.checks.length > 20) {
        errors.push(`${where}.checks has more than 20 entries`);
      } else {
        task.checks.forEach((check, checkIndex) => {
          if (typeof check !== 'string' || !config.verification.allowedCommands.includes(check)) {
            errors.push(
              `${where}.checks[${checkIndex}] "${check}" is not in verification.allowedCommands ${JSON.stringify(
                config.verification.allowedCommands
              )}`
            );
            return;
          }
          checks.push(check);
        });
      }
      normalizedTasks.push({ id, title, instruction, files, checks, done });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    plan: { summary, tasks: normalizedTasks },
  };
}

function renderPlanMarkdown(plan) {
  const lines = [];
  lines.push('# Plan');
  lines.push('');
  lines.push(plan.summary);
  lines.push('');
  plan.tasks.forEach((task, index) => {
    lines.push(`## ${index + 1}. ${task.id} - ${task.title}`);
    lines.push('');
    lines.push(task.instruction);
    lines.push('');
    lines.push(`- Files: ${task.files.join(', ')}`);
    lines.push(`- Checks: ${task.checks.length ? task.checks.join(' ; ') : '(none)'}`);
    lines.push(`- Done when: ${task.done}`);
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderTaskMarkdown(task) {
  const lines = [];
  lines.push(`# Task ${task.id}: ${task.title}`);
  lines.push('');
  lines.push('## Objective');
  lines.push('');
  lines.push(task.instruction);
  lines.push('');
  lines.push('## Files you may modify');
  lines.push('');
  for (const file of task.files) lines.push(`- ${file}`);
  lines.push('');
  lines.push('## Verification commands run by the loop');
  lines.push('');
  if (task.checks.length === 0) lines.push('- (no checks configured for this task)');
  for (const check of task.checks) lines.push(`- ${check}`);
  lines.push('');
  lines.push('## Done when');
  lines.push('');
  lines.push(task.done);
  lines.push('');
  lines.push('Rules: modify only the listed files, do not touch .git or protected paths,');
  lines.push('and never run git commit, git push, or git merge. Stop when the objective is met.');
  return `${lines.join('\n').trimEnd()}\n`;
}

function writePlanArtifacts(runDir, plan) {
  const planJson = {
    schemaVersion: 1,
    summary: plan.summary,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      instruction: task.instruction,
      files: task.files,
      checks: task.checks,
      done: task.done,
    })),
  };
  writeFileAtomic(path.join(runDir, 'PLAN.json'), `${JSON.stringify(planJson, null, 2)}\n`);
  writeFileAtomic(path.join(runDir, 'PLAN.md'), renderPlanMarkdown(planJson));
  const tasksDir = path.join(runDir, 'tasks');
  ensureDir(tasksDir);
  planJson.tasks.forEach((task, index) => {
    const taskDoc = { schemaVersion: 1, index, ...task };
    writeFileAtomic(path.join(tasksDir, `${task.id}.json`), `${JSON.stringify(taskDoc, null, 2)}\n`);
    writeFileAtomic(path.join(tasksDir, `${task.id}.md`), renderTaskMarkdown(taskDoc));
  });
  return planJson;
}

function loadPlanJson(runDir) {
  return readJsonFile(path.join(runDir, 'PLAN.json'), 'PLAN.json');
}

function loadPlan(runDir, config) {
  const planJson = loadPlanJson(runDir);
  const validation = validatePlan(planJson, config);
  if (!validation.ok) {
    throw new Error(`PLAN.json on disk is invalid: ${validation.errors.join('; ')}`);
  }
  return validation.plan;
}

module.exports = {
  extractClaudeText,
  parseStructuredJson,
  parsePlanResponse,
  validatePlan,
  renderPlanMarkdown,
  renderTaskMarkdown,
  writePlanArtifacts,
  loadPlanJson,
  loadPlan,
};
