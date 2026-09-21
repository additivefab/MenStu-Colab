import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FeishuBotConfigError, resolveFeishuBotConfig } from "../lib/feishu-bot-config.ts";

const legacy = {
  FEISHU_APP_ID: "cli_1111111111111111",
  FEISHU_APP_SECRET: "test-legacy-secret",
  FEISHU_VERIFICATION_TOKEN: "test-legacy-token",
  FEISHU_ENCRYPT_KEY: "test-legacy-encryption",
};

test("unconfigured and blank bot settings retain the original application's configuration", () => {
  assert.deepEqual(resolveFeishuBotConfig({}), {
    mode: "legacy", appId: "", appSecret: "", verificationToken: "", encryptKey: "",
  });
  assert.deepEqual(resolveFeishuBotConfig({
    ...legacy,
    FEISHU_BOT_APP_ID: " ", FEISHU_BOT_APP_SECRET: "",
    FEISHU_BOT_VERIFICATION_TOKEN: "\n", FEISHU_BOT_ENCRYPT_KEY: "\t",
  }), {
    mode: "legacy", appId: legacy.FEISHU_APP_ID, appSecret: legacy.FEISHU_APP_SECRET,
    verificationToken: legacy.FEISHU_VERIFICATION_TOKEN, encryptKey: legacy.FEISHU_ENCRYPT_KEY,
  });
});

test("a complete bot pair never inherits the old webhook verifier or changes input credentials", () => {
  const values = Object.freeze({
    ...legacy,
    FEISHU_BOT_APP_ID: " cli_2222222222222222 ",
    FEISHU_BOT_APP_SECRET: " test-bot-secret ",
  });
  assert.deepEqual(resolveFeishuBotConfig(values), {
    mode: "dedicated", appId: "cli_2222222222222222", appSecret: "test-bot-secret",
    verificationToken: "", encryptKey: "",
  });
  assert.equal(values.FEISHU_APP_ID, legacy.FEISHU_APP_ID);
  assert.equal(values.FEISHU_APP_SECRET, legacy.FEISHU_APP_SECRET);
});

test("dedicated webhook settings come only from the new application", () => {
  const config = resolveFeishuBotConfig({
    ...legacy, FEISHU_BOT_APP_ID: "cli_2222222222222222", FEISHU_BOT_APP_SECRET: "test-bot-secret",
    FEISHU_BOT_VERIFICATION_TOKEN: " new-token ", FEISHU_BOT_ENCRYPT_KEY: " new-encryption ",
  });
  assert.equal(config.verificationToken, "new-token");
  assert.equal(config.encryptKey, "new-encryption");
});

test("partial bot credentials or isolated webhook settings cannot fall back to old credentials", () => {
  for (const settings of [
    { FEISHU_BOT_APP_ID: "cli_2222222222222222" },
    { FEISHU_BOT_APP_SECRET: "test-bot-secret" },
    { FEISHU_BOT_APP_ID: "cli_2222222222222222", FEISHU_BOT_APP_SECRET: " " },
    { FEISHU_BOT_VERIFICATION_TOKEN: "test-bot-token" },
    { FEISHU_BOT_ENCRYPT_KEY: "test-bot-encryption" },
  ]) {
    assert.throws(() => resolveFeishuBotConfig({ ...legacy, ...settings }), FeishuBotConfigError);
  }
});

const launcher = fileURLToPath(new URL("../infra/feishu-long-connection/run-bridge.zsh", import.meta.url));
const hasZsh = spawnSync("zsh", ["--version"], { encoding: "utf8" }).status === 0;

test("launcher passes a dedicated pair without replacing the original login credentials", { skip: !hasZsh }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tanyan-bot-config-"));
  try {
    const checkPath = join(directory, "check.mjs");
    await writeFile(checkPath, `
      import assert from 'node:assert/strict';
      assert.equal(process.env.FEISHU_BOT_APP_ID, 'cli_2222222222222222');
      assert.equal(process.env.FEISHU_BOT_APP_SECRET, 'test-bot-secret');
      assert.equal(process.env.FEISHU_APP_ID, 'cli_1111111111111111');
      assert.equal(process.env.FEISHU_APP_SECRET, 'test-legacy-secret');
    `);
    const result = spawnSync("zsh", [launcher], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH, ...legacy,
        FEISHU_BOT_APP_ID: "cli_2222222222222222", FEISHU_BOT_APP_SECRET: "test-bot-secret",
        TANYAN_NODE_BIN: process.execPath, TANYAN_BRIDGE_BUNDLE: checkPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher rejects secret-only or verifier-only settings before consulting the legacy Keychain", { skip: !hasZsh }, () => {
  for (const settings of [
    { FEISHU_BOT_APP_SECRET: "test-bot-secret" },
    { FEISHU_BOT_VERIFICATION_TOKEN: "test-bot-token" },
    { FEISHU_BOT_ENCRYPT_KEY: "test-bot-encryption" },
    { FEISHU_BOT_KEYCHAIN_SERVICE: "test-bot-keychain" },
  ]) {
    const result = spawnSync("zsh", [launcher], {
      encoding: "utf8", env: { PATH: process.env.PATH, ...legacy, ...settings },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /独立机器人须配置 FEISHU_BOT_APP_ID/);
    assert.equal(result.stdout, "");
  }
});

test("launcher trims bot settings before choosing a mode and looking up a Keychain account", { skip: !hasZsh }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tanyan-bot-launcher-"));
  try {
    for (const dedicatedMode of [false, true]) {
      const expectedAppId = dedicatedMode ? "cli_2222222222222222" : legacy.FEISHU_APP_ID;
      const expectedService = dedicatedMode ? "com.tanyan.feishu-bot-app-secret" : "com.tanyan.feishu-app-secret";
      const expectedSecret = dedicatedMode ? "test-bot-secret" : legacy.FEISHU_APP_SECRET;
      const checkPath = join(directory, "check.mjs");
      await writeFile(checkPath, `
        import assert from 'node:assert/strict';
        assert.equal(process.env.FEISHU_APP_ID, 'cli_1111111111111111');
        assert.equal(process.env.FEISHU_APP_SECRET, 'test-legacy-secret');
        assert.equal((process.env.FEISHU_BOT_APP_ID || '').trim(), ${JSON.stringify(dedicatedMode ? expectedAppId : "")});
        assert.equal((process.env.FEISHU_BOT_APP_SECRET || '').trim(), ${JSON.stringify(dedicatedMode ? expectedSecret : "")});
      `);
      // A zsh function shadows the absolute executable so no real Keychain is ever accessed.
      const wrapper = `function /usr/bin/security() {
        [[ "$*" == "find-generic-password -a ${expectedAppId} -s ${expectedService} -w" ]] || return 70
        print -r -- "${expectedSecret}"
      }
      source "$1"`;
      const result = spawnSync("zsh", ["-c", wrapper, "launcher-test", launcher], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH, ...legacy,
          FEISHU_BOT_APP_ID: dedicatedMode ? " cli_2222222222222222 \t" : " \t",
          FEISHU_BOT_APP_SECRET: " ", FEISHU_BOT_VERIFICATION_TOKEN: "\n ",
          FEISHU_BOT_ENCRYPT_KEY: "\t", FEISHU_BOT_KEYCHAIN_SERVICE: " ",
          TANYAN_NODE_BIN: process.execPath, TANYAN_BRIDGE_BUNDLE: checkPath,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
