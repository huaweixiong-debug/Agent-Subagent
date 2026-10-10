---
name: agent-loop
description: Run the agent-loop requirement-to-tasks workflow for exactly one user request. Use when the user says "run agent-loop", "execute this requirement with the loop", "start the agent loop", or asks to resume or check an agent-loop run.
---

# agent-loop

Drive the standalone agent-loop runner: one requirement in, Claude Opus plans and
reviews, OpenCode (deepseek/deepseek-flash, variant max) executes, and verified
changes stay uncommitted in an isolated git worktree.

## Procedure

1. Resolve the package directory and the installed config:
   - Package directory: `AGENT_LOOP_HOME` if set; otherwise the one-line
     `agent-loop.path` file next to this SKILL.md.
   - Installed config: `config.json` next to this SKILL.md. The installer copied
     it there; supply it automatically on every runner invocation unless the user
     explicitly provides their own config file.
   - If neither resolves to a directory containing `agent-loop.js`, stop and tell
     the user to run the package `install.ps1` or set `AGENT_LOOP_HOME`.

2. Determine the target repository with `git rev-parse --show-toplevel` in the
   user's project. The checkout must be clean; the runner refuses dirty trees.

3. Capture exactly ONE initial requirement, verbatim from the user. The runner's
   planner decomposes that single requirement into fine-grained, independently
   reviewed tasks; do not split it into multiple runner invocations yourself. If
   the user has not stated a requirement, ask exactly one clarifying question.

4. Invoke the runner exactly once:
   `node "<packageDir>/agent-loop.js" start --repo "<repoRoot>" --request "<requirement>" --config "<skillDir>/config.json"`
   Always pass the installed `config.json` (or the user's own `--config` if they
   provided one). Do not add other flags, do not retry, and do not invoke the
   runner in a loop.

5. Report the outcome from the runner's final output:
   - `COMPLETE`: summarize the tasks and point at the worktree path; remind the
     user that changes are uncommitted and no commit/push/merge was performed.
   - `NEEDS_HUMAN`: show the question verbatim and the suggested command:
     `node "<packageDir>/agent-loop.js" resume --run "<runDir>" --answer "<answer>" --config "<config>"`
     If the run requires acknowledging unintended git changes, the answer must
     start with the literal prefix `ACKNOWLEDGE:`.
   - `FAILED`: show the stop reason and the run directory with its evidence.

6. Never commit, push, merge, or edit tracked files on the user's behalf to
   "help" the run. The runner reports state through its files and exit codes.

## Resume and status

- `node "<packageDir>/agent-loop.js" resume --run "<runDir>"` continues an
  interrupted run or reports a pending question.
- `node "<packageDir>/agent-loop.js" status --run "<runDir>"` prints the current
  state without changing anything.
- Pass the same `--config` again on resume (the installed `config.json`, or the
  user's own config file).
