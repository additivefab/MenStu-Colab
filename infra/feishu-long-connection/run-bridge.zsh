#!/bin/zsh
set -euo pipefail

app_id="${FEISHU_APP_ID:-cli_aa0d8658e8b89cb6}"
keychain_service="${FEISHU_KEYCHAIN_SERVICE:-com.tanyan.feishu-app-secret}"
site_url="${TANYAN_SITE_URL:-https://progress.tz-ndt.com}"
node_bin="${TANYAN_NODE_BIN:-/Users/xiaosheyang123/.local/bin/node}"
bridge_bundle="${TANYAN_BRIDGE_BUNDLE:-/Users/xiaosheyang123/.local/share/tanyan-feishu-bridge/bridge.cjs}"

app_secret="$(/usr/bin/security find-generic-password -a "$app_id" -s "$keychain_service" -w)"

export FEISHU_APP_ID="$app_id"
export FEISHU_APP_SECRET="$app_secret"
export TANYAN_SITE_URL="$site_url"

exec "$node_bin" "$bridge_bundle"
