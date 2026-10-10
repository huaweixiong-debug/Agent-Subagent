'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(PACKAGE_ROOT, 'install.ps1');

function runInstaller(args) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args],
    { encoding: 'utf8', timeout: 120000 }
  );
}

function makeRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agent-loop-installer-${label}-`));
  const repo = path.join(root, 'repo with spaces');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}

function walkTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full);
      } else {
        entries.push(relative);
      }
    }
  };
  walk(root);
  return entries.sort();
}

test('installer installs the skill, preserves local excludes, and keeps the checkout clean', (t) => {
  const repo = makeRepo('ok');
  t.after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));
  const excludePath = path.join(repo, '.git', 'info', 'exclude');
  fs.writeFileSync(excludePath, '# keep this local rule\n', 'utf8');
  const before = walkTree(repo);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  const result = runInstaller(['-Repo', repo]);
  assert.equal(result.status, 0, `installer failed: ${result.stderr}`);

  const skill = path.join(repo, '.claude', 'skills', 'agent-loop');
  assert.equal(fs.existsSync(path.join(skill, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(skill, 'config.json')), true);
  const recordedPath = fs.readFileSync(path.join(skill, 'agent-loop.path'), 'utf8').trim();
  assert.equal(path.resolve(recordedPath), PACKAGE_ROOT);

  const installedConfig = JSON.parse(fs.readFileSync(path.join(skill, 'config.json'), 'utf8'));
  assert.equal(installedConfig.claude.permissionMode, 'plan');
  assert.equal(installedConfig.verification.allowedCommands.length > 0, true);
  const skillText = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
  assert.match(skillText, /config\.json/, 'the skill must supply the installed config automatically');

  const after = walkTree(repo);
  const added = after.filter((entry) => !before.includes(entry)).sort();
  assert.deepEqual(added, [
    '.claude/',
    '.claude/skills/',
    '.claude/skills/agent-loop/',
    '.claude/skills/agent-loop/SKILL.md',
    '.claude/skills/agent-loop/agent-loop.path',
    '.claude/skills/agent-loop/config.json',
  ]);

  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), head);
  const diff = execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(diff, '');
  const excludeText = fs.readFileSync(excludePath, 'utf8');
  assert.match(excludeText, /# keep this local rule/);
  assert.equal(excludeText.split(/\r?\n/).filter((line) => line.trim() === '/.claude/skills/agent-loop/').length, 1);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
});

test('installer refuses an existing destination and writes nothing', (t) => {
  const repo = makeRepo('exists');
  t.after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));
  const first = runInstaller(['-Repo', repo]);
  assert.equal(first.status, 0, `first install failed: ${first.stderr}`);

  const skillFile = path.join(repo, '.claude', 'skills', 'agent-loop', 'SKILL.md');
  const before = fs.readFileSync(skillFile, 'utf8');
  const treeBefore = walkTree(repo);

  const second = runInstaller(['-Repo', repo]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), before);
  assert.deepEqual(walkTree(repo), treeBefore);
});

test('installer refuses a dirty checkout', (t) => {
  const repo = makeRepo('dirty');
  t.after(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');

  const result = runInstaller(['-Repo', repo]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty/);
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
});

test('installer refuses a non-git directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-installer-nongit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runInstaller(['-Repo', dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a git checkout/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('installer requires an explicit repo argument', () => {
  const result = runInstaller([]);
  assert.notEqual(result.status, 0);
});
