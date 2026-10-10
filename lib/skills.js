'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { truncate } = require('./util');

const PLANNING_SKILLS = ['grill-with-docs', 'grill-me'];

function skillRoots(repo, home) {
  return [
    path.join(repo, '.claude', 'skills'),
    path.join(repo, '.agents', 'skills'),
    path.join(repo, '.opencode', 'skills'),
    path.join(repo, '.opencode', 'skill'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.config', 'opencode', 'skill'),
  ];
}

function detectPlanningSkill(options = {}) {
  const repo = options.repo;
  const home = options.home || os.homedir();
  const maxChars = options.maxChars || 12000;
  if (typeof repo !== 'string' || repo === '') return null;
  for (const name of PLANNING_SKILLS) {
    for (const root of skillRoots(repo, home)) {
      const filePath = path.join(root, name, 'SKILL.md');
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      return { name, path: filePath, content: truncate(content, maxChars) };
    }
  }
  return null;
}

module.exports = { PLANNING_SKILLS, skillRoots, detectPlanningSkill };
