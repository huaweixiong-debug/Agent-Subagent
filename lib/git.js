'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class GitError extends Error {}

function runGit(args, { cwd, allowFailure = false } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    if (allowFailure) {
      return { ok: false, stdout, stderr, status: typeof err.status === 'number' ? err.status : 1 };
    }
    const detail = stderr.trim() || stdout.trim() || err.message;
    throw new GitError(`git ${args.join(' ')} failed (exit ${err.status}): ${detail}`);
  }
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function isGitRepo(repo) {
  return runGit(['rev-parse', '--git-dir'], { cwd: repo, allowFailure: true }).ok;
}

function porcelain(repo) {
  return runGit(['status', '--porcelain'], { cwd: repo }).stdout;
}

function isClean(repo) {
  return porcelain(repo).trim() === '';
}

function commonDir(repo) {
  const output = runGit(['rev-parse', '--git-common-dir'], { cwd: repo }).stdout.trim();
  if (!output) throw new GitError('git rev-parse --git-common-dir returned no output');
  return path.isAbsolute(output) ? path.normalize(output) : path.resolve(repo, output);
}

function headSha(repo) {
  return runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
}

function branchExists(repo, branch) {
  return runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repo,
    allowFailure: true,
  }).ok;
}

function listWorktrees(repo) {
  const output = runGit(['worktree', 'list', '--porcelain'], { cwd: repo }).stdout;
  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '') {
      if (current) {
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

function ensureWorktree(repo, worktreePath, branch) {
  const existing = listWorktrees(repo).find((entry) => samePath(entry.path, worktreePath));
  if (existing) {
    return { path: worktreePath, branch, reused: true };
  }
  if (fs.existsSync(worktreePath)) {
    throw new GitError(`path exists but is not a registered git worktree: ${worktreePath}`);
  }
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const args = branchExists(repo, branch)
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];
  runGit(args, { cwd: repo });
  return { path: worktreePath, branch, reused: false };
}

function stageAll(worktree) {
  runGit(['add', '-A'], { cwd: worktree });
}

function worktreeDiff(worktree) {
  stageAll(worktree);
  const stat = runGit(['diff', '--cached', '--stat', '--no-color'], { cwd: worktree }).stdout;
  const text = runGit(['diff', '--cached', '--no-color'], { cwd: worktree }).stdout;
  const status = runGit(['status', '--porcelain'], { cwd: worktree }).stdout;
  const files = runGit(['diff', '--cached', '--name-only', '-z'], { cwd: worktree })
    .stdout.split('\0')
    .map((entry) => entry.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  return { stat, text, status, files };
}

function countCommitsBetween(baseHead, worktree) {
  const output = runGit(['rev-list', '--count', `${baseHead}..HEAD`], { cwd: worktree }).stdout.trim();
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

module.exports = {
  GitError,
  runGit,
  samePath,
  isGitRepo,
  porcelain,
  isClean,
  commonDir,
  headSha,
  branchExists,
  listWorktrees,
  ensureWorktree,
  stageAll,
  worktreeDiff,
  countCommitsBetween,
};
