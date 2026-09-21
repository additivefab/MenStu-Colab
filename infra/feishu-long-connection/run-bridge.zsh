#!/bin/zsh
set -euo pipefail
setopt extendedglob

trim_config_value() {
  local config_value="$1"
  print -r -- "${${config_value##[[:space:]]#}%%[[:space:]]#}"
}

site_url="${TANYAN_SITE_URL:-https://progress.tz-ndt.com}"
node_bin="${TANYAN_NODE_BIN:-/Users/xiaosheyang123/.local/bin/node}"
bridge_bundle="${TANYAN_BRIDGE_BUNDLE:-/Users/xiaosheyang123/.local/share/tanyan-feishu-bridge/bridge.cjs}"

bot_app_id="$(trim_config_value "${FEISHU_BOT_APP_ID:-}")"
bot_app_secret="$(trim_config_value "${FEISHU_BOT_APP_SECRET:-}")"
bot_verification_token="$(trim_config_value "${FEISHU_BOT_VERIFICATION_TOKEN:-}")"
bot_encrypt_key="$(trim_config_value "${FEISHU_BOT_ENCRYPT_KEY:-}")"
bot_keychain_service="$(trim_config_value "${FEISHU_BOT_KEYCHAIN_SERVICE:-}")"
if [[ -n "$bot_app_id" || -n "$bot_app_secret" || -n "$bot_verification_token" || -n "$bot_encrypt_key" || -n "$bot_keychain_service" ]]; then
  if [[ -z "$bot_app_id" ]]; then
    print -u2 "独立机器人须配置 FEISHU_BOT_APP_ID；不会使用原登录应用凭据"
    exit 64
  fi
  if [[ -z "$bot_app_secret" ]]; then
    bot_keychain_service="${bot_keychain_service:-com.tanyan.feishu-bot-app-secret}"
    bot_app_secret="$(/usr/bin/security find-generic-password -a "$bot_app_id" -s "$bot_keychain_service" -w)"
  fi
  export FEISHU_BOT_APP_ID="$bot_app_id"
  export FEISHU_BOT_APP_SECRET="$bot_app_secret"
else
  # Preserve the existing installation until a dedicated bot is configured.
  app_id="${FEISHU_APP_ID:-cli_aa0d8658e8b89cb6}"
  keychain_service="${FEISHU_KEYCHAIN_SERVICE:-com.tanyan.feishu-app-secret}"
  app_secret="$(/usr/bin/security find-generic-password -a "$app_id" -s "$keychain_service" -w)"
  export FEISHU_APP_ID="$app_id"
  export FEISHU_APP_SECRET="$app_secret"
fi

export TANYAN_SITE_URL="$site_url"

exec "$node_bin" "$bridge_bundle"
