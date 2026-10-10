'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${randomHex(3)}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomHex(4)}`;
  fs.writeFileSync(tmpPath, data, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* the temp file is best-effort cleanup only */
    }
    throw err;
  }
}

function readJsonFile(filePath, label = filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const wrapped = new Error(`cannot read ${label}: ${err.message}`);
    wrapped.code = err.code;
    throw wrapped;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot parse ${label} as JSON: ${err.message}`);
  }
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line, 'utf8');
}

function truncate(text, max) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[truncated ${value.length - max} characters]`;
}

function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  nowIso,
  randomHex,
  makeRunId,
  ensureDir,
  writeFileAtomic,
  readJsonFile,
  appendLine,
  truncate,
  isSubPath,
  sleep,
};
