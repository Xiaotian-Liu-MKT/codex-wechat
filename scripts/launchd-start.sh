#!/bin/zsh

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd /Users/xiaotian/tools/codex-wechat
exec /opt/homebrew/bin/node ./bin/codex-wechat.js start
