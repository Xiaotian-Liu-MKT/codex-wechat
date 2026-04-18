# codex-wechat Operations

## Scope

This document records the practical runbook for operating `codex-wechat` on this machine.
It focuses on the parts that are easy to forget during daily use: startup, restart,
workspace presets, permission mode, and troubleshooting when WeChat stops responding.

## Core Rules

- Only run one `codex-wechat` instance at a time.
- If you manually edit `~/.codex-wechat/sessions.json`, restart the service afterward.
- If startup logs show repeated `monitor error: fetch failed`, the process likely does not
  have working network access to the WeChat endpoints.

## Important Paths

- Project repo: `/Users/xiaotian/tools/codex-wechat`
- Env file: `/Users/xiaotian/tools/codex-wechat/.env`
- LaunchAgent plist: `/Users/xiaotian/Library/LaunchAgents/com.xiaotian.codex-wechat.plist`
- Launchd start script: `/Users/xiaotian/tools/codex-wechat/scripts/launchd-start.sh`
- WeChat state dir: `/Users/xiaotian/.codex-wechat`
- Sessions file: `/Users/xiaotian/.codex-wechat/sessions.json`
- Account tokens: `/Users/xiaotian/.codex-wechat/accounts`
- Service stdout log: `/Users/xiaotian/.codex-wechat/logs/launchd.out.log`
- Service stderr log: `/Users/xiaotian/.codex-wechat/logs/launchd.err.log`

## Launchd Service

`codex-wechat` is configured as a user LaunchAgent on this machine.

Label:

```text
com.xiaotian.codex-wechat
```

Check status:

```bash
launchctl print gui/$(id -u)/com.xiaotian.codex-wechat
```

Tail logs:

```bash
tail -f /Users/xiaotian/.codex-wechat/logs/launchd.out.log
tail -f /Users/xiaotian/.codex-wechat/logs/launchd.err.log
```

Restart service:

```bash
launchctl kickstart -k gui/$(id -u)/com.xiaotian.codex-wechat
```

Unload service:

```bash
launchctl bootout gui/$(id -u) /Users/xiaotian/Library/LaunchAgents/com.xiaotian.codex-wechat.plist
```

Load service:

```bash
launchctl bootstrap gui/$(id -u) /Users/xiaotian/Library/LaunchAgents/com.xiaotian.codex-wechat.plist
```

## Manual Start

Run from the project directory:

```bash
cd /Users/xiaotian/tools/codex-wechat
npm run start
```

Healthy startup signs:

- `runtime ready account=...`
- no repeated `monitor error: fetch failed`
- For daily use, prefer the LaunchAgent instead of manual foreground start.

## Login

If the WeChat session expires, log in again:

```bash
cd /Users/xiaotian/tools/codex-wechat
npm run login
```

Check saved accounts:

```bash
cd /Users/xiaotian/tools/codex-wechat
npm run accounts
```

## Restart

Recommended restart sequence:

1. Stop the currently running `codex-wechat` process.
2. Make any `.env` or `sessions.json` changes.
3. Start one fresh instance with `npm run start`.

Do not keep multiple old terminals running `npm run start` at the same time.
Multiple instances can race on WeChat long polling and make messages appear stuck.

## Permission Mode

Default permission behavior is configured in:

```env
CODEX_WECHAT_DEFAULT_CODEX_ACCESS_MODE=...
```

Current practical meanings:

- `default`
  Workspace write enabled, but sensitive actions can still require approval.
- `full-access`
  More permissive default behavior with fewer approval interruptions.

After editing `.env`, restart `codex-wechat`.

## Default Workspace

Configured in:

```env
CODEX_WECHAT_DEFAULT_WORKSPACE=/Volumes/实验一定成功！/Dropbox/Project Bank
```

This is only the fallback default. You can still switch to another workspace in WeChat.

## Workspace Presets

The custom preset feature supports:

- `/codex preset list`
- `/codex preset add <alias> <absolute-path>`
- `/codex preset remove <alias>`
- `/codex use <index|alias>`

Current commonly used presets on this machine:

- `airbnb` -> `/Volumes/实验一定成功！/Dropbox/Project Bank/airbnb复现`
- `donation` -> `/Volumes/实验一定成功！/Dropbox/Project Bank/算法&默认捐款额`
- `home` -> `/Users/xiaotian`
- `multica` -> `/Users/xiaotian/multica`
- `skills` -> `/Users/xiaotian/xiaotian-skills`

Notes:

- Indexes are list-order based, not permanent identifiers.
- Aliases are safer than indexes. Prefer `/codex use multica` over `/codex use 4`.
- Presets are stored in `~/.codex-wechat/sessions.json`.

## Skills Workspace

The actual editable skills source directory is:

```text
/Users/xiaotian/xiaotian-skills
```

`/Users/xiaotian/.codex/skills` contains symlinks that point into this source directory.

## Troubleshooting

### WeChat messages get no response

Check these first:

1. Make sure only one `codex-wechat` instance is running.
2. Look for repeated `monitor error: fetch failed` in the startup terminal.
3. If that error repeats, restart from a normal terminal environment with working network access.
4. If login looks invalid, run `npm run login` again.

### Preset command exists but new preset is missing

If you edited `sessions.json` by hand, restart the service.
The running process does not hot reload session state from disk.

### Startup succeeds but network polling fails

`runtime ready` alone is not enough.
The process must also be able to keep calling the WeChat HTTP endpoints.
Repeated `fetch failed` means the process is not actually healthy for message polling.

## Suggested Daily Usage

For most cases:

```text
/codex preset list
/codex use donation
/codex where
```

Or switch quickly by alias:

```text
/codex use home
/codex use skills
/codex use airbnb
```
