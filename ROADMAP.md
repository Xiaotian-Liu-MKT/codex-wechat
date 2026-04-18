# codex-wechat Roadmap

This document tracks the next product and engineering steps for this fork.
It focuses on gaps that are already visible in the current implementation,
not speculative ideas.

## P0

### Structured in-progress updates during long runs

Problem:
The current runtime sends WeChat `typing` signals, but users still mostly see
"silence until completion" for longer Codex tasks.

Target:
- Send short progress updates at meaningful milestones.
- Distinguish states such as `planning`, `executing`, `editing`, `testing`, and `done`.
- Avoid noisy per-token or per-event spam.

Why it matters:
- This is the biggest usability gap in day-to-day WeChat usage.
- It reduces duplicate user messages such as "好了没" and accidental retries.

Implementation plan:
- Add a runtime-side progress state machine keyed by `runKey`, separate from the final reply buffer.
- Listen for Codex stream events that imply phase changes, for example plan updates, tool calls, approvals, file writes, and turn completion.
- Map low-level events into a small fixed set of user-facing statuses:
  - `收到任务`
  - `正在规划`
  - `正在修改文件`
  - `正在运行检查`
  - `等待授权`
  - `即将完成`
- Add throttling so the same status is not sent repeatedly within a short window.
- Keep `typing` as the low-level heartbeat, but send explicit text updates only on meaningful transitions.
- Suppress progress messages for very short tasks to avoid noise.

Likely files:
- `src/app/wechat-runtime.js`
- `src/infra/codex/message-utils.js`
- `src/shared/wechat-reply-format.js`

Acceptance criteria:
- Long-running tasks produce 2-5 concise progress messages before the final answer.
- Short tasks still behave like normal chat and do not become noisy.
- Waiting-for-approval tasks clearly notify the user before `/codex approve` is needed.

### Safer large-result delivery

Problem:
Reply chunking is better than before, but large outputs still compete with
WeChat message limits and mobile readability constraints.

Target:
- Prefer `summary first, details second`.
- When output is too large, save the full result into a workspace file and send
  a concise summary plus the file path.
- Improve continuation prompts, for example suggesting `/codex send <path>`.

Why it matters:
- The current byte-based chunking prevents hard truncation, but it is still a
  transport-layer fix rather than a product-layer solution.

Implementation plan:
- Introduce a reply delivery policy layer above raw chunking.
- Before sending the final result, classify the payload into one of:
  - short text
  - long text
  - code-heavy output
  - file-oriented output
- For long text and code-heavy output:
  - generate a concise WeChat summary
  - persist the full output under the current workspace, for example `.codex-wechat/artifacts/`
  - send the summary plus saved path
- Reuse the existing `/codex send <path>` flow instead of inventing a second delivery path.
- Add a max-inline threshold based on UTF-8 bytes and section count, not just raw length.
- Prefer preserving headings and short conclusions in WeChat, while moving verbose bodies to saved files.

Likely files:
- `src/shared/wechat-reply-format.js`
- `src/app/wechat-runtime.js`
- `src/infra/weixin/message-utils.js`

Acceptance criteria:
- Very large outputs no longer arrive as a wall of fragmented messages.
- The user always gets a usable summary even when the full output is saved to disk.
- Saved artifact paths are stable and easy to send back with `/codex send`.

## P1

### Complete the Plan mode lifecycle

Current state:
- `/codex plan`
- `/codex plan status`
- `/codex plan show`
- `/codex execute`
- `/codex exit plan`
- Plan files are persisted under `.codex-wechat/plans/`

Missing pieces:
- Plan history browsing
- Re-run plan generation without losing the previous version
- Diff or overwrite confirmation between plan versions
- Marking plan execution progress after `/codex execute`
- Better post-execution linkage from result back to the approved plan

Implementation plan:
- Extend the pending-plan model into a plan-history model keyed by workspace and thread.
- Store each generated plan as an immutable version with metadata:
  - `planId`
  - `threadId`
  - `workspaceRoot`
  - `createdAt`
  - `status`
  - `supersedesPlanId`
- Add commands:
  - `/codex plan list`
  - `/codex plan diff <id1> <id2>`
  - `/codex plan use <id>`
- When a new plan is generated for the same workspace, mark the older one as superseded instead of overwriting it.
- On `/codex execute`, record which plan version is being executed and write that linkage into the final result metadata.
- Optionally add lightweight step completion writeback if the final response clearly references completed steps.

Likely files:
- `src/app/wechat-runtime.js`
- `src/infra/storage/session-store.js`
- `src/shared/command-parsing.js`
- `src/shared/wechat-reply-format.js`

Acceptance criteria:
- Users can see more than one saved plan per workspace.
- Executions are traceable back to the exact approved plan file.
- Replanning does not destroy previous plan history.

### Bring `feat/historyShare` into main

Problem:
The history-sharing capability is still described as experimental and branch-only.

Target:
- Merge the useful parts of `feat/historyShare` into `main`
- Make WeChat-created tasks easier to inspect from the local Codex side
- Define the exact behavior clearly in docs instead of leaving it branch-specific

Why it matters:
- This closes the loop between mobile control and desktop visibility.

Implementation plan:
- Diff the `feat/historyShare` branch against `main` and identify the minimal useful feature slice.
- Keep the first merge scope narrow:
  - expose WeChat-originated task context locally
  - avoid importing branch-only experiments that do not affect daily workflow
- Define where shared history should surface:
  - local Codex thread metadata
  - saved transcript file
  - optional debug view in the repo state
- Update docs so the feature is described as supported mainline behavior instead of a side branch note.

Likely files:
- branch-specific files after diff review
- `README.md`
- `Usage.md`
- `CHANGELOG.md`

Acceptance criteria:
- A task started from WeChat is inspectable from the local side in a documented way.
- The feature no longer depends on users knowing about a special branch.

### Richer inbound attachment workflow

Current state:
- WeChat attachments can already be downloaded into the current workspace.

Missing pieces:
- Better user-facing acknowledgment after save
- Clearer file organization for inbound media
- Optional automatic handoff to Codex as structured context
- Image/document-specific downstream handling instead of generic file persistence

Why it matters:
- The repo already has the transport mechanics, but not the full product flow.

Implementation plan:
- Standardize inbound attachment storage under a predictable workspace directory such as `.codex-wechat/inbox/`.
- Reply with a clearer acknowledgment message that includes:
  - file name
  - saved path
  - detected type
- Add optional attachment-to-context transformation:
  - image -> tell Codex an image is available at path
  - text-like file -> include a short extract or instruct Codex to open the file
  - binary/unknown file -> provide path only
- For multi-attachment messages, generate one structured summary instead of many independent notices.
- Keep the current transport fallback so unsupported attachment types are still safely saved.

Likely files:
- `src/infra/weixin/media-receive.js`
- `src/app/wechat-runtime.js`
- `src/shared/wechat-reply-format.js`

Acceptance criteria:
- Users can immediately tell where inbound files went.
- Inbound attachments become usable task context, not just passive saved files.
- Multi-file inbound messages remain readable.

## P2

### Upgrade workspace preset management

Current state:
- `/codex preset list`
- `/codex preset add <alias> <absolute-path>`
- `/codex preset remove <alias>`
- `/codex use <index|alias>`

Missing pieces:
- Rename preset
- Deduplicate overlapping presets
- Optional global presets shared across WeChat sessions
- Optional default preset selection per user or device

Implementation plan:
- Normalize preset data into a clearer schema that distinguishes:
  - session-local presets
  - user-global presets
  - active default preset
- Add commands:
  - `/codex preset rename <old> <new>`
  - `/codex preset pin <alias>`
  - optional `/codex preset scope <alias> <session|global>`
- Add duplicate-path detection during `add` and `rename`.
- Keep alias-based switching as the preferred path and de-emphasize index-based usage in docs.

Likely files:
- `src/infra/storage/session-store.js`
- `src/shared/command-parsing.js`
- `src/app/wechat-runtime.js`

Acceptance criteria:
- Preset lists stay stable and understandable after many additions.
- Common workspaces can be switched without re-adding them in each WeChat session.

### Documentation synchronization

Problem:
`README.md` is reasonably current, but `Usage.md` and `CHANGELOG.md` are behind
the current fork functionality.

Target:
- Update `Usage.md` to include plan mode, presets, and fork-specific workflows
- Add changelog entries for plan mode, preset support, reply formatting, and
  WeChat send error handling
- Keep fork-specific capabilities explicit so they do not get confused with upstream

Implementation plan:
- Treat docs updates as part of each shipped feature instead of a later cleanup pass.
- Update:
  - `Usage.md` for operator-facing workflows
  - `README.md` for feature positioning
  - `CHANGELOG.md` for release history
- Add one short end-to-end example for each fork-specific workflow:
  - plan then execute
  - preset then use
  - generate artifact then send file back to WeChat

Acceptance criteria:
- A new user can understand fork-only capabilities without reading commit history.
- Release notes reflect the real feature surface of `origin/main`.

### Operational polish

Ideas:
- Health-check command for runtime status
- Better single-instance detection before startup
- More explicit diagnostics around network polling failures
- Optional export/import for `sessions.json` state

Implementation plan:
- Add a CLI or WeChat-visible health check that reports:
  - logged-in account
  - polling health
  - current Codex connectivity
  - active workspace
  - single-instance status
- Add startup locking so a second `codex-wechat` process fails fast with a clear message.
- Improve launchd-friendly logs for network and polling failures.
- Add a safe state export path before introducing state import.

Acceptance criteria:
- Basic runtime failures are diagnosable without reading raw logs first.
- Users are warned before accidentally starting a second instance.

## Deferred

### Native rich Markdown rendering in WeChat

The current plain-text compression is predictable and robust. A richer renderer
could improve readability, but it is lower priority than delivery reliability.

### More aggressive automation around approvals

Workspace-scoped approval persistence already exists. More automation is possible,
but it should be approached carefully to avoid over-granting command prefixes.
