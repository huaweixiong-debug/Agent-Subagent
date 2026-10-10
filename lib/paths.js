'use strict';

const path = require('path');
const { isSubPath } = require('./util');

const PROTECTED_RELATIVE_PATTERNS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /\.(pem|key|pfx|p12|jks)$/i,
  /(^|\/)credentials(\.|$)/i,
];

function normalizeRepoRelative(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  if (input.includes('\0')) {
    return { ok: false, error: 'path must not contain NUL' };
  }
  const forward = input.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(forward)) {
    return { ok: false, error: 'absolute (drive) paths are not allowed' };
  }
  if (forward.startsWith('/')) {
    return { ok: false, error: 'absolute paths are not allowed' };
  }
  if (forward.split('/').some((segment) => segment === '..')) {
    return { ok: false, error: 'path traversal ("..") is not allowed' };
  }
  const normalized = path.posix.normalize(forward).replace(/^\.\//, '');
  if (normalized === '' || normalized === '.') {
    return { ok: false, error: 'path must name a file' };
  }
  if (normalized.startsWith('..')) {
    return { ok: false, error: 'path traversal ("..") is not allowed' };
  }
  if (PROTECTED_RELATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { ok: false, error: `protected path is not allowed: ${normalized}` };
  }
  return { ok: true, normalized };
}

function globToRegExp(glob) {
  const source = String(glob);
  let regex = '^';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '*') {
      if (source[i + 1] === '*') {
        i += 1;
        if (source[i + 1] === '/') {
          i += 1;
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
    } else if (ch === '?') {
      regex += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function matchesAnyGlob(relativePath, globs) {
  return globs.some((glob) => globToRegExp(glob).test(relativePath));
}

function resolveInside(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relativePath);
  if (!isSubPath(base, target)) {
    throw new Error(`path escapes base directory: ${relativePath}`);
  }
  return target;
}

module.exports = {
  PROTECTED_RELATIVE_PATTERNS,
  normalizeRepoRelative,
  globToRegExp,
  matchesAnyGlob,
  resolveInside,
};
