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

### Bring `feat/historyShare` into main

Problem:
The history-sharing capability is still described as experimental and branch-only.

Target:
- Merge the useful parts of `feat/historyShare` into `main`
- Make WeChat-created tasks easier to inspect from the local Codex side
- Define the exact behavior clearly in docs instead of leaving it branch-specific

Why it matters:
- This closes the loop between mobile control and desktop visibility.

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

### Documentation synchronization

Problem:
`README.md` is reasonably current, but `Usage.md` and `CHANGELOG.md` are behind
the current fork functionality.

Target:
- Update `Usage.md` to include plan mode, presets, and fork-specific workflows
- Add changelog entries for plan mode, preset support, reply formatting, and
  WeChat send error handling
- Keep fork-specific capabilities explicit so they do not get confused with upstream

### Operational polish

Ideas:
- Health-check command for runtime status
- Better single-instance detection before startup
- More explicit diagnostics around network polling failures
- Optional export/import for `sessions.json` state

## Deferred

### Native rich Markdown rendering in WeChat

The current plain-text compression is predictable and robust. A richer renderer
could improve readability, but it is lower priority than delivery reliability.

### More aggressive automation around approvals

Workspace-scoped approval persistence already exists. More automation is possible,
but it should be approached carefully to avoid over-granting command prefixes.
