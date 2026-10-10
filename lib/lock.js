'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { nowIso } = require('./util');

class LockError extends Error {}

function lockPath(runDir) {
  return path.join(runDir, 'LOCK.json');
}

function reclaimPath(runDir) {
  return path.join(runDir, 'LOCK.reclaim.json');
}

function readLock(runDir) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(runDir), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function readLockSnapshot(runDir) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath(runDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new LockError(`cannot read LOCK.json: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LockError('LOCK.json is not valid JSON; refusing to take over an ambiguous lock');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockError('LOCK.json is not a lock object; refusing to take over an ambiguous lock');
  }
  if (typeof parsed.hostname !== 'string' || parsed.hostname === '') {
    throw new LockError('LOCK.json has no hostname; refusing to take over an ambiguous lock');
  }
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new LockError('LOCK.json has no valid pid; refusing to take over an ambiguous lock');
  }
  return { lock: parsed, raw };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function createLockFile(runDir, contents) {
  let fd;
  try {
    fd = fs.openSync(lockPath(runDir), 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw new LockError(`cannot create LOCK.json: ${err.message}`);
  }
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function describeReclaimMarker(runDir) {
  let raw;
  try {
    raw = fs.readFileSync(reclaimPath(runDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { summary: `unreadable marker: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Number.isInteger(parsed.pid)) {
      return { summary: `pid ${parsed.pid} on ${parsed.hostname || 'unknown host'} since ${parsed.createdUtc || 'unknown'}` };
    }
  } catch {
    /* fall through to the unreadable summary */
  }
  return { summary: 'unreadable marker' };
}

function manualRecoveryMessage(runDir, reason) {
  const marker = describeReclaimMarker(runDir);
  const markerText = marker ? marker.summary : 'unknown holder';
  return (
    `stale-lock recovery is ${reason} (${reclaimPath(runDir)} held by ${markerText}). ` +
    `Verify that no agent-loop process is running, then delete "${lockPath(runDir)}" and ` +
    `"${reclaimPath(runDir)}" manually and retry.`
  );
}

function acquireReclaimMarker(runDir) {
  const marker = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdUtc: nowIso(),
  };
  let fd;
  try {
    fd = fs.openSync(reclaimPath(runDir), 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new LockError(manualRecoveryMessage(runDir, 'already in progress or ambiguous'));
    }
    throw new LockError(`cannot create ${reclaimPath(runDir)}: ${err.message}`);
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        fs.rmSync(reclaimPath(runDir), { force: true });
      } catch {
        /* releasing is best-effort; a leftover marker fails closed for humans */
      }
    },
  };
}

function makeHandle(runDir) {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        const raw = fs.readFileSync(lockPath(runDir), 'utf8');
        const current = JSON.parse(raw);
        if (current && current.pid === process.pid && current.hostname === os.hostname()) {
          fs.rmSync(lockPath(runDir), { force: true });
        }
      } catch {
        /* releasing is best-effort; a stale lock from a dead pid can be taken over */
      }
    },
  };
}

function acquireLock(runDir) {
  const lock = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: os.hostname(),
    createdUtc: nowIso(),
  };
  const contents = `${JSON.stringify(lock, null, 2)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createLockFile(runDir, contents)) {
      return makeHandle(runDir);
    }
    const snapshot = readLockSnapshot(runDir);
    if (snapshot === null) continue; // the owner released between open and read
    const existing = snapshot.lock;
    const sameHost = existing.hostname === os.hostname();
    const alive = sameHost ? isProcessAlive(existing.pid) : true;
    if (alive) {
      throw new LockError(
        `run is locked by pid ${existing.pid} on ${existing.hostname} since ${existing.createdUtc || 'unknown'}; ` +
          'wait for it to finish or remove LOCK.json after verifying the process is gone'
      );
    }
    // Stale same-host lock: serialize reclamation behind an exclusive marker, then
    // revalidate that the on-disk lock is still the exact stale snapshot we
    // inspected before removing it. Only the marker holder may remove or replace
    // the lock, so a contender can never delete a lock created by a winner.
    const marker = acquireReclaimMarker(runDir);
    try {
      const rechecked = readLockSnapshot(runDir);
      if (rechecked !== null && rechecked.raw === snapshot.raw) {
        try {
          fs.rmSync(lockPath(runDir), { force: true });
        } catch (err) {
          throw new LockError(`could not remove the stale lock: ${err.message}`);
        }
      }
      if (createLockFile(runDir, contents)) {
        return makeHandle(runDir);
      }
      // A different lock appeared between revalidation and creation; loop to
      // inspect it. It is never removed here.
    } finally {
      marker.release();
    }
  }
  throw new LockError('could not acquire the run lock after repeated races; retry once no other process is running');
}

module.exports = { LockError, lockPath, reclaimPath, readLock, isProcessAlive, acquireLock };
