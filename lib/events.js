'use strict';

const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');

function eventsPath(runDir) {
  return path.join(runDir, 'events.ndjson');
}

function appendEvent(runDir, type, data) {
  const event = { ts: nowIso(), type };
  if (data !== undefined) event.data = data;
  fs.appendFileSync(eventsPath(runDir), `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

function readEvents(runDir) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(runDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ parseError: true, line });
    }
  }
  return events;
}

module.exports = { eventsPath, appendEvent, readEvents };
