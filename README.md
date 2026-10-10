# agent-loop

A standalone, dependency-free, Windows-first Node.js 18+ package that turns **one
requirement** into a planned, executed, and reviewed set of changes inside an
isolated git worktree, then stops before any commit, push, or merge.

- **Claude Code (Opus)** plans each task and reviews each result with read-only
  tools. It is always invoked with `-p --permission-mode plan`, bounded
  `--max-turns` and `--max-budget-usd`, and `AskUserQuestion` forced into
  `--disallowedTools`, so it can never block on interactive prompts; open
  questions are written into the run state and reported as `NEEDS_HUMAN`. Nested
  invocations run with `CLAUDECODE` removed from the child environment. An
  installed `grill-with-docs` planning skill is applied when present (falling
  back to `grill-me`).
- **OpenCode** (`deepseek/deepseek-flash`, variant `max`) executes each task, but
  only inside the run's worktree and under a per-task default-deny permission
  overlay: unspecified tools, shell (`bash`), subagents (`task`), search/web
  (`grep`, `search`, `webfetch`, `websearch`), the `question` tool, and external
  directories are denied; only the `read`, `glob`, and `list` tools are allowed
  (repository-wide minus protected paths), edits are limited to the files the
  current task declares, and per-response output and per-task step caps are
  configured where the provider supports them. Each execution is invoked with
  `--format json` so token usage can be read from the NDJSON event stream.
- Verification commands are **exact allow-listed strings** executed by the
  runner without a shell, and each task gets **at most one bounded repair cycle**
  after a `FIX` verdict.
- Token usage is parsed from CLI-reported usage; **unknown usage is never
  treated as zero** — the run stops as `NEEDS_HUMAN`. At most **one automatic
  retry** is allowed for clearly transient CLI/network failures, and only when
  the failed call reported known usage; authentication, permission,
  missing-executable, unknown-usage, unmetered-transient, and ambiguous-output
  failures stop for a human decision instead of retrying.
- All state, evidence, and logs live under the target repository's git common
  directory; the primary working tree is never touched.

```
requirement ──► Claude Opus plan ──► validate task files ──► OpenCode executes task
                     ▲                                              │
                     │                                      allow-listed checks
              one FIX per task ◄── Claude Opus review (read-only) ◄──┘
                     │
         PASS ──► next task ──► safety audit ──► COMPLETE (no commit/push/merge)
         question / ambiguity / unknown usage / auth / permission ──► NEEDS_HUMAN
         one automatic retry max for transient CLI/network failures
         exhausted plan attempts / fix cycles / token budget ──► FAILED (evidence retained)
```

## Requirements

- Node.js 18 or newer (no npm dependencies at all).
- Git available on `PATH`.
- Windows with Windows PowerShell 5.1 (the hardened process adapter is
  `scripts/invoke-cli.ps1`). Non-Windows works through a direct-spawn adapter,
  but Windows is the supported target.
- Claude Code CLI with Opus access and the OpenCode CLI.

## Quick start

```powershell
# 1. Sanity check the package and environment (side-effect free)
node agent-loop.js --self-check

# 2. Start a run against a clean target checkout
node agent-loop.js start --repo C:\work\my-project --request "Add a --version flag to the CLI" --config .\config.example.json

# 3. Check status at any time
node agent-loop.js status --run C:\work\my-project\.git\agent-loop\runs\20261010-120000-ab12cd

# 4. Resume an interrupted run, or answer a pending question
node agent-loop.js resume --run <runDir> --answer "Use the existing settings module."
```

Exit codes: `0` success/complete, `2` stopped (FAILED or precondition/lock
failure), `3` NEEDS_HUMAN, `4` usage/config error, `5` self-check failure.

## CLI

| Command | Purpose |
| --- | --- |
| `start --repo <path> (--request <text> \| --request-file <path>) [--config <path>]` | Validate a clean checkout, create the run, and drive it to a terminal state. |
| `resume --run <runDir> [--answer <text> \| --answer-file <path>] [--config <path>]` | Continue an interrupted run, or record a human answer and continue. Without `--answer`, a pending question is printed and nothing executes. |
| `status --run <runDir>` | Print state, question, token usage, and paths. No writes. |
| `--self-check` | Verify Node version, required files, example config, state machine, and tool availability. |
| `--version`, `--help` | Version and usage. |

Use the **same `--config`** on `resume` as on `start` when the run uses a custom
configuration; the config is intentionally not persisted with secret values.

## Configuration

See `config.example.json`; unknown keys or wrong types are rejected (fail
closed). Environment values from `claude.env` / `opencode.env` are passed to the
child processes but are **never written into run artifacts** (a redacted config
is stored as `config.redacted.json`).

| Key | Meaning |
| --- | --- |
| `claude.command`, `claude.argsPrefix` | How to launch the Claude Code CLI (native `.exe` only, see shims below). |
| `claude.planModel`, `claude.reviewModel` | Models for planning and review (default `opus`). |
| `claude.outputFormat` | `json` (default) keeps usage reporting and structured parsing; `text` is accepted but then usage is unreported and runs stop for human action. |
| `claude.permissionMode` | `plan` (default, read-only) or `default`; the flag is always passed. |
| `claude.maxTurns` | Bounded agent turns per planner/reviewer invocation (`--max-turns`, default 40). |
| `claude.maxBudgetUsd` | Per-invocation budget passed as `--max-budget-usd` (default 5). This is a Claude CLI per-invocation limit where supported; subscription plans may meter differently. |
| `claude.allowedTools` / `claude.disallowedTools` | Tool policy; defaults are read-only `Read,Glob,Grep` and deny `AskUserQuestion` (always enforced even if removed from the list). |
| `claude.extraArgs`, `opencode.extraArgs` | Extra flags; runner-managed flags (`--auto`, `--model`, `--permission-mode`, `--max-turns`, `--max-budget-usd`, `--dangerously-skip-permissions`, ...) are rejected. |
| `opencode.command`, `opencode.argsPrefix` | How to launch OpenCode. |
| `opencode.model`, `opencode.variant`, `opencode.agent` | Model, model variant, and the restricted agent defined by the per-task overlay. |
| `opencode.maxOutputTokens` | Conservative per-response output cap applied via the agent `options` object where the provider supports it (default 8192). `0` omits it. |
| `opencode.maxStepsPerTask` | Agent iteration cap set as the top-level agent `steps` field (default 8, validated 1–200). The model may stop before the task is complete; the Claude review plus the single repair cycle detects incomplete work and the evidence shows the truncated run. |
| `limits.maxPlanAttempts` | Bounded re-plan attempts after well-formed plans fail validation; ambiguous planner output stops as NEEDS_HUMAN instead. |
| `limits.maxTasks` | Maximum tasks accepted from the planner. |
| `limits.maxFixPerTask` | `0` or `1`; plan semantics allow exactly one bounded repair cycle. |
| `limits.maxTokenBudget` | Tokens (input+output, parsed from CLI-reported usage) before the run stops as FAILED. `0` disables. Enforced between calls; a single call can overshoot (see limitations). Unknown usage stops as NEEDS_HUMAN, never counted as zero. |
| `limits.commandTimeoutMs` | Per-invocation timeout enforced by the process adapter. A timeout is treated as a transient failure (one retry). |
| `limits.maxTransientRetries` | `0` or `1` (default 1); the bounded number of automatic retries for clearly transient CLI/network failures that reported known usage. Unmetered transient failures always stop for a human. |
| `limits.maxTaskInstructionChars` | Upper bound validated on every task. |
| `limits.maxReviewEvidenceChars` | Diff size cap; larger diffs stop with NEEDS_HUMAN for manual review. |
| `verification.allowedCommands` | Exact command strings tasks may use as checks; only the runner executes them, without a shell. |
| `constraints.allowedGlobs` | Repository-relative globs task files must match. |

### CLI shims on Windows

The process adapter deliberately refuses `.cmd`/`.bat`/`.ps1` shims and only
runs native executables; text that flows through `cmd.exe` could be
re-interpreted. npm installs of the CLIs are shims, so point the config at the
native executable behind them, for example:

```jsonc
{
  "claude":   { "command": "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" },
  "opencode": { "command": "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe" }
}
```

(`where.exe claude` shows the shim; the native binary sits in the package
directory it references.) Alternatively use `"command": "node"` with
`"argsPrefix": ["<absolute path to the CLI's cli.js>"]`.

## Planning skill detection

Before each planning attempt the runner looks for `grill-with-docs` first and
`grill-me` second under `<repo>/.claude/skills`, `<repo>/.agents/skills`,
`<repo>/.opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, and
`~/.config/opencode/skills`. The first match is embedded into the planning
prompt (recorded as the `PLAN_SKILL` event) with instructions to apply its
process non-interactively and to turn material unknowns into a
`{"status":"QUESTION"}` response. With no skill installed, the planner plans
directly.

## Run layout

All run data is stored under `<git-common-dir>/agent-loop/`, which keeps the
primary working tree clean:

```
<git-common-dir>/agent-loop/
  runs/<runId>/
    REQUEST.md            verbatim requirement
    STATE.json            atomic state machine (temp+rename writes)
    LOCK.json             PID lock while a process is driving the run
    events.ndjson         append-only event log
    QUESTION.md           pending question when NEEDS_HUMAN
    ANSWER-<n>.md         recorded human answers
    PLAN.json / PLAN.md   validated plan and human-readable render
    tasks/<id>.json/.md   per-task instruction and metadata
    opencode.overlay.json per-run OpenCode permission overlay (evidence)
    config.redacted.json  effective config with env values redacted
    evidence/
      planning/plan-attempt-<n>.*      prompts, stdout/stderr, invoke records
      task-<id>/execution-<round>.*    executor runs (round 0 = initial, 1 = fix)
      task-<id>/checks-<round>.json    exact verification results
      task-<id>/review-<round>.json    reviewer verdicts (with answer generation)
      final/AUDIT.json, SELF-REPORT.md
  worktrees/<runId>/     isolated worktree on branch agent-loop/<runId>
```

## State machine

`CREATED → WORKTREE_READY → PLANNING → PLAN_READY → TASK_RUNNING →
TASK_REVIEWING → (TASK_FIXING → TASK_REVIEWING)* → TASK_DONE → ... → COMPLETE`

Every non-terminal state may also stop as `NEEDS_HUMAN` (a question is recorded;
resuming requires `--answer`) or `FAILED` (stop reason and evidence retained).
Transitions are explicit and invalid transitions throw. `NEEDS_HUMAN` only
resumes to the stage that asked the question, and only with a recorded answer.

Interrupted stages rerun only when no durable result exists: a validated
`PLAN.json`, a finished `execution-<round>.json` (written only after a successful
executor call), completed `checks-<round>.json`, or a `review-<round>.json` that
has not been superseded by a newer human answer.

The run lock is acquired atomically (`LOCK.json` created with `O_EXCL`). Stale
lock reclamation is serialized behind an exclusive `LOCK.reclaim.json` marker
and revalidates that the on-disk lock is still the exact stale snapshot before
removing it, so concurrent contenders have exactly one winner and can never
delete a lock created by a winner. A live owner, a foreign host, or an
unreadable/ambiguous lock file fails closed. If the reclaim marker itself
already exists (for example after a crash), recovery fails closed with exact
manual instructions: verify no agent-loop process is running, then delete both
`LOCK.json` and `LOCK.reclaim.json` and retry. The lock is released only by the
process that created it.

## Permissions and safety model

- Planner and reviewer: read-only tools (`Read,Glob,Grep`), `--permission-mode
  plan`, bounded turns and per-invocation budget, no `AskUserQuestion`
  (enforced), no `--auto`, no shell. The child environment is built explicitly
  with `CLAUDECODE` removed so a nested invocation never inherits the outer
  Claude Code session markers.
- Executor: never invoked with `--auto`; a per-task overlay is injected through
  `OPENCODE_CONFIG_CONTENT` and the base policy is also written to
  `opencode.overlay.json`. It default-denies every unspecified tool
  (`"*": "deny"`), explicitly allows only `read`, `glob`, and `list`, and
  explicitly denies `external_directory`, `bash`, `grep`, `search`, `task`,
  `webfetch`, `websearch`, and `question`. `read` stays repository-wide minus
  protected paths (`.git`, `.env*`, keys, credentials, `.ssh`, `.aws`,
  `.npmrc`, `.netrc`, `id_rsa`, `*.pem`, `*.key`, `*.pfx`, `*.p12`), and `edit`
  is denied by default so only the files of the current task are editable, with
  the protected path denials applied last. No separate `write`/`patch`/
  `multiedit` entries are added: the documented edit permission already covers
  those aliases, and extra entries could override the task-scoped edit allows.
  Where the provider supports them, a conservative `maxTokens` output cap is
  attached to the agent `options` (provider/model options), and
  `opencode.maxStepsPerTask` is set as the agent's top-level `steps` iteration
  limit — the documented AgentConfig field, not a model option.
- Tasks may only name repository-relative files matching `constraints.allowedGlobs`;
  traversal, absolute paths, and protected paths are rejected by validation.
- After every execution the changed files are mechanically compared with the task's
  declared files. Undeclared changes cannot pass even with a reviewer approval:
  the run stops as `NEEDS_HUMAN` (a violation question) until the executor fixes
  them or a human explicitly acknowledges them for that task; the acknowledgment
  is recorded in the review evidence and the self report.
- Git-change acknowledgements (undeclared files and the final safety audit)
  require the literal prefix `ACKNOWLEDGE:` at the start of the answer. Any other
  answer is recorded but does not release the gate, and the question is repeated.
- Checks are exact strings from `verification.allowedCommands`, tokenized and
  spawned by the runner process itself without a shell; there is no dynamic
  evaluation or string interpolation anywhere in the process path.
- The loop never runs `git commit`, `git push`, or `git merge`. Before
  `COMPLETE`, an audit verifies the primary HEAD is unchanged and clean and that
  the worktree HEAD still equals the branch point. If a model-created commit is
  detected, the run stops as `NEEDS_HUMAN` until a human acknowledges with the
  literal prefix.
- Credentials are never passed as arguments and environment values are never
  logged; put secrets in `claude.env` / `opencode.env` or your shell.

## Recovery and accounting

- Every Claude/OpenCode invocation is classified on failure. A clearly transient
  CLI/network failure (connection errors, DNS, socket resets, timeouts) gets at
  most one automatic retry per invocation label, tracked in the run state; the
  retry uses a distinct evidence label (`…-retry1`). The automatic retry only
  happens when the failed call reported **known usage** — a transient failure
  with unknown usage stops as `NEEDS_HUMAN` (kind `cli-transient-unmetered`)
  because the failed call may have incurred unaccounted cost. A second transient
  failure, authentication or permission errors, a missing/unstartable
  executable, and unrecognized failures also stop the run as `NEEDS_HUMAN` with
  a precise question. Retrying beyond one attempt always requires a human answer.
- Token usage is parsed from CLI-reported usage. For Claude JSON envelopes an
  explicit `total` wins; otherwise both input and output counts are required and
  the optional prompt-cache fields (`cache_creation_input_tokens`,
  `cache_read_input_tokens`) are added to the input total. A partial report is
  unknown, never zero. OpenCode runs request `--format json` and usage is summed
  from each completed `step_finish.part.tokens` event exactly once per step
  (explicit `total` values win over components, cache read/write tokens are
  included, duplicate snapshots of the same step are counted once). If the
  report is insufficient to account for the invocation — a completed step with
  no usable tokens, a partial Claude report, or an invocation that reports
  nothing at all — the run stops as `NEEDS_HUMAN` (kind `usage`): unknown usage
  is never silently counted as zero. The aggregate budget is checked between
  calls, so a single long call can overshoot the configured budget — limitations
  are stated honestly rather than claimed away.

### Limitations (read this)

A git worktree is **not an OS sandbox**. The worktree isolates git state, not
the machine: model-driven processes run with your user account and, when a
provider or CLI ignores a permission rule, may still reach files or the network
outside the worktree. OpenCode permission rules are guardrails against
accidental damage, not a security boundary. Run untrusted requirements in a
container, a VM, or under a dedicated low-privilege OS user. The loop leaves
changes uncommitted in the worktree so a human can review the diff before any
integration.

Token accounting is only as complete as the usage the CLIs report, and the
aggregate budget is enforced **between** calls: a single invocation can exceed
the remaining budget before the loop stops. `max-budget-usd` is a Claude CLI
per-invocation limit where supported; subscription plans may meter differently
and may not honor it. The OpenCode output cap is likewise applied through the
provider/plugin layer "where supported" — none of these mechanisms is a hard
aggregate cost guarantee, which is why unknown usage always stops the run. A
failed transient call with unknown usage is deliberately not retried, because a
retry could multiply unaccounted provider cost; it always requires a human
decision. If a process crashes while holding the stale-lock reclaim marker,
recovery stays failed closed until a human follows the printed manual recovery
steps — that is a deliberate availability trade-off in favor of safety. The
OpenCode step cap (`maxStepsPerTask`, default 8) can stop a task before it is
complete; that is intentional (bounded work per task), and the Claude review
plus the single repair cycle detects incomplete work while the truncated run
stays in the evidence for inspection.

## Installing the Claude Code skill

The installer is opt-in and refuses to overwrite anything:

```powershell
.\install.ps1 -Repo C:\work\my-project
```

It verifies the target is a clean git checkout, then copies the skill to
`<repo>\.claude\skills\agent-loop\` together with a usable per-project
`config.json` (edit it for the project) and a one-line `agent-loop.path`
containing this package's location. It also adds the exact skill directory to
that clone's `.git/info/exclude`, preserving the runner's clean-checkout
precondition without changing tracked files. Existing exclude rules are kept.
The skill accepts exactly one initial
requirement, lets the runner's planner decompose it into fine-grained tasks, and
supplies the installed `config.json` automatically on every invocation. It makes
no global, project-settings, or credential changes. To uninstall, delete the
skill directory and remove the matching line from `.git/info/exclude`.

## Development

```powershell
node --test                 # core, installer, and integration tests (fake CLIs only)
node agent-loop.js --self-check
git diff --check
```

Integration tests build temporary repositories and fake Claude/OpenCode CLIs;
they never make real model calls or network requests.
