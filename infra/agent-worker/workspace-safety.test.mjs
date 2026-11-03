// R01 regression tests: an agent that tampers with the checkout's git
// metadata (symlinks, hard links, wrong types, swapped directories, races)
// must never make the trusted worker read or write outside the workspace.
// Every scenario keeps a canary file outside the checkout and asserts its
// bytes are unchanged and that collection refuses (or stays correct).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, link, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import { createRepoFixture, makeWork, tempDir } from "./test-support/harness.mjs";
import { collectChanges, discardChanges, prepareWorkspace, workspaceChanges } from "./workspace.mjs";

const CANARY = Buffer.from("CANARY: must never change\n");
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
const TAMPERED = { code: "WORKSPACE_TAMPERED" };

async function setup(t) {
  const root = await tempDir(t, "ws-safety-");
  const repo = await createRepoFixture(root);
  const config = { gitReadFallback: { urlTemplate: `${repo.remoteBase}/{fullName}.git` } };
  const workspace = await prepareWorkspace({ work: makeWork(repo), config, workRoot: path.join(root, "work") });
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  const canary = path.join(outside, "canary");
  await writeFile(canary, CANARY);
  const marker = path.join(root, "pwned");
  const ws = workspace.repoDir;
  return { root, repo, workspace, ws, dotGit: path.join(ws, ".git"), outside, canary, marker };
}

/** A valid git repository outside the checkout whose config is the canary
 * and defines a filter that would create `marker` if git ever used it. The
 * checkout is given a .gitattributes that applies that filter. */
async function outsideRepo(env) {
  const dir = path.join(env.outside, "evil-repo");
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q");
  await writeFile(path.join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = touch ${env.marker}\n\tsmudge = touch ${env.marker}\n`);
  await writeFile(path.join(env.ws, ".gitattributes"), "* filter=x\n");
  const config = path.join(dir, ".git", "config");
  return { dir, gitDir: path.join(dir, ".git"), config, bytes: await readFile(config) };
}

async function assertUnchanged(file, bytes) {
  assert.deepEqual(await readFile(file), bytes, `${file} was modified`);
}

async function assertNoMarker(env) {
  await assert.rejects(stat(env.marker), { code: "ENOENT" }, "a planted filter ran");
}

async function assertAllRefuse(env) {
  await assert.rejects(collectChanges(env.workspace, env.repo.sha), TAMPERED);
  await assert.rejects(workspaceChanges(env.workspace), TAMPERED);
  await assert.rejects(discardChanges(env.workspace, env.repo.sha), TAMPERED);
}

test("R01 normal path: changes are collected from the trusted git directory; in-checkout .git tricks are inert", async (t) => {
  const env = await setup(t);
  // Hiding a change from the agent's own index does not hide it from collection.
  git(env.ws, "update-index", "--skip-worktree", "src/old_helper.py");
  // Planted, but shape-valid, metadata in the checkout's .git.
  await writeFile(path.join(env.dotGit, "config"), `[filter "x"]\n\tclean = touch ${env.marker}\n[core]\n\thooksPath = .git/hooks\n`, { flag: "a" });
  await mkdir(path.join(env.dotGit, "info"), { recursive: true });
  await writeFile(path.join(env.dotGit, "info", "attributes"), "* filter=x\n");
  await mkdir(path.join(env.dotGit, "hooks"), { recursive: true });
  await writeFile(path.join(env.dotGit, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${env.marker}\n`, { mode: 0o755 });
  await writeFile(path.join(env.ws, "src/old_helper.py"), "def old():\n    return 1\n");
  await writeFile(path.join(env.ws, "src/model.py"), "def f(x):\n    return 2 * x\n");
  await writeFile(path.join(env.ws, "src/new.py"), "NEW = 1\n");
  await assertNoMarker(env);

  const change = await collectChanges(env.workspace, env.repo.sha);
  assert.deepEqual(change.files.map((file) => [file.path, file.action]), [
    ["src/model.py", "modify"], ["src/new.py", "add"], ["src/old_helper.py", "modify"],
  ]);
  assert.equal(Buffer.from(change.files[0].contentBase64, "base64").toString(), "def f(x):\n    return 2 * x\n");
  assert.match(change.unifiedDiff, /return 2 \* x/);
  await assertNoMarker(env);
  assert.deepEqual(await workspaceChanges(env.workspace), ["src/model.py", "src/new.py", "src/old_helper.py"]);
  await discardChanges(env.workspace, env.repo.sha);
  assert.deepEqual(await workspaceChanges(env.workspace), []);
  // The worker never wrote into the checkout's .git: the planted config is still there.
  assert.match(await readFile(path.join(env.dotGit, "config"), "utf8"), /filter "x"/);
  await assertUnchanged(env.canary, CANARY);
});

test("R01: .git/config symlinked to a canary outside the checkout is refused, canary unchanged", async (t) => {
  const env = await setup(t);
  await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
  await rm(path.join(env.dotGit, "config"));
  await symlink(env.canary, path.join(env.dotGit, "config"));
  await assertAllRefuse(env);
  await assertUnchanged(env.canary, CANARY);
});

test("R01: .git/info symlinked to an outside directory is refused, outside files unchanged", async (t) => {
  const env = await setup(t);
  const dir = path.join(env.outside, "info");
  await mkdir(dir);
  await writeFile(path.join(dir, "attributes"), CANARY);
  await writeFile(path.join(dir, "exclude"), CANARY);
  await rm(path.join(env.dotGit, "info"), { recursive: true, force: true });
  await symlink(dir, path.join(env.dotGit, "info"));
  await assertAllRefuse(env);
  await assertUnchanged(path.join(dir, "attributes"), CANARY);
  await assertUnchanged(path.join(dir, "exclude"), CANARY);
  await assertUnchanged(env.canary, CANARY);
});

test("R01: .git/hooks symlinked to an outside directory with files is refused, nothing is deleted", async (t) => {
  const env = await setup(t);
  const dir = path.join(env.outside, "hooks");
  await mkdir(dir);
  for (const name of ["pre-commit", "post-checkout", "keep.txt"]) await writeFile(path.join(dir, name), CANARY);
  await rm(path.join(env.dotGit, "hooks"), { recursive: true, force: true });
  await symlink(dir, path.join(env.dotGit, "hooks"));
  await assertAllRefuse(env);
  for (const name of ["pre-commit", "post-checkout", "keep.txt"]) await assertUnchanged(path.join(dir, name), CANARY);
  await assertUnchanged(env.canary, CANARY);
});

test("R01: .git/config hard-linked to the canary (either direction) is refused, canary unchanged", async (t) => {
  const env = await setup(t);
  const config = path.join(env.dotGit, "config");
  await rm(config);
  await link(env.canary, config);
  await assertAllRefuse(env);
  await assertUnchanged(env.canary, CANARY);

  // The agent keeps the original config but adds a second name for it outside.
  const other = await setup(t);
  const outsideName = path.join(other.outside, "config-alias");
  await link(path.join(other.dotGit, "config"), outsideName);
  const before = await readFile(outsideName);
  await assertAllRefuse(other);
  await assertUnchanged(outsideName, before);
});

test("R01: unexpected types in the .git chain are refused", async (t) => {
  const cases = {
    "config is a directory": async (env) => {
      await rm(path.join(env.dotGit, "config"));
      await mkdir(path.join(env.dotGit, "config"));
    },
    "config is a FIFO": async (env) => {
      await rm(path.join(env.dotGit, "config"));
      execFileSync("mkfifo", [path.join(env.dotGit, "config")]);
    },
    "config is missing": async (env) => rm(path.join(env.dotGit, "config")),
    "hooks is a file": async (env) => {
      await rm(path.join(env.dotGit, "hooks"), { recursive: true, force: true });
      await writeFile(path.join(env.dotGit, "hooks"), "x");
    },
    "info/attributes symlinked to the canary": async (env) => {
      await mkdir(path.join(env.dotGit, "info"), { recursive: true });
      await symlink(env.canary, path.join(env.dotGit, "info", "attributes"));
    },
    ".git is a gitfile pointing outside": async (env) => {
      const evil = await outsideRepo(env);
      await rm(env.dotGit, { recursive: true });
      await writeFile(env.dotGit, `gitdir: ${evil.gitDir}\n`);
    },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const env = await setup(st);
      await tamper(env);
      await assert.rejects(collectChanges(env.workspace, env.repo.sha), TAMPERED);
      await assertUnchanged(env.canary, CANARY);
      await assertNoMarker(env);
    });
  }
});

test("R01: .git replaced by a symlink to a valid outside repository is refused; its config and filters are never used", async (t) => {
  const env = await setup(t);
  const evil = await outsideRepo(env);
  await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
  await rename(env.dotGit, path.join(env.root, "stashed-dot-git"));
  await symlink(evil.gitDir, env.dotGit);
  await assertAllRefuse(env);
  await assertUnchanged(evil.config, evil.bytes);
  await assertNoMarker(env);

  // A real directory copy (same content, new inode) is refused as a replacement too.
  const copy = await setup(t);
  await cp(copy.dotGit, path.join(copy.root, "copy"), { recursive: true });
  await rm(copy.dotGit, { recursive: true });
  await rename(path.join(copy.root, "copy"), copy.dotGit);
  await assert.rejects(collectChanges(copy.workspace, copy.repo.sha), { code: "WORKSPACE_TAMPERED", message: /\.git was replaced/ });
});

test("R01 race: .git swapped for a symlink between the check and the git run is detected; nothing outside is touched", async (t) => {
  const env = await setup(t);
  const evil = await outsideRepo(env);
  await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
  let swapped = false;
  env.workspace.testHooks = {
    afterVerify: async () => {
      if (swapped) return;
      swapped = true;
      await rename(env.dotGit, path.join(env.root, "stashed-dot-git"));
      await symlink(evil.gitDir, env.dotGit);
    },
  };
  await assert.rejects(collectChanges(env.workspace, env.repo.sha), TAMPERED);
  assert.ok(swapped);
  await assertUnchanged(evil.config, evil.bytes);
  await assertUnchanged(env.canary, CANARY);
  await assertNoMarker(env);
});

test("R01 race: the trusted git directory replaced between the check and the git run is detected", async (t) => {
  const env = await setup(t);
  await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
  let swapped = false;
  env.workspace.testHooks = {
    afterVerify: async () => {
      if (swapped) return;
      swapped = true;
      const aside = path.join(env.root, "git-aside");
      await rename(env.workspace.gitDir, aside);
      await cp(aside, env.workspace.gitDir, { recursive: true });
    },
  };
  await assert.rejects(collectChanges(env.workspace, env.repo.sha), { code: "WORKSPACE_TAMPERED", message: /trusted git directory was replaced/ });
  await assertUnchanged(env.canary, CANARY);
});

test("R01 race: a tight loop flipping .git to an outside repository never leaks; collection refuses or is correct", async (t) => {
  const env = await setup(t);
  const evil = await outsideRepo(env);
  await rm(path.join(env.ws, ".gitattributes"));
  await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
  const real = path.join(env.root, "real-dot-git");
  let stop = false;
  let flips = 0;
  const flipper = (async () => {
    while (!stop) {
      await rename(env.dotGit, real);
      await symlink(evil.gitDir, env.dotGit);
      await tick();
      await unlink(env.dotGit);
      await rename(real, env.dotGit);
      flips += 1;
      await tick();
    }
  })();
  const outcomes = { ok: 0, refused: 0 };
  try {
    for (let round = 0; round < 25; round += 1) {
      try {
        const change = await collectChanges(env.workspace, env.repo.sha);
        assert.deepEqual(change.files.map((file) => file.path), ["src/model.py"]);
        outcomes.ok += 1;
      } catch (error) {
        assert.equal(error.code, "WORKSPACE_TAMPERED", error.message);
        outcomes.refused += 1;
      }
    }
  } finally {
    stop = true;
    await flipper;
  }
  assert.ok(flips > 0 && outcomes.refused > 0, JSON.stringify({ flips, ...outcomes }));
  await assertUnchanged(evil.config, evil.bytes);
  await assertUnchanged(env.canary, CANARY);
  await assertNoMarker(env);
  // Once the agent stops, the (same-inode) .git verifies again and collection works.
  const change = await collectChanges(env.workspace, env.repo.sha);
  assert.deepEqual(change.files.map((file) => file.path), ["src/model.py"]);
});

test("R01: tampering with the trusted git directory itself is refused", async (t) => {
  const cases = {
    "config modified": async (env) => writeFile(path.join(env.workspace.gitDir, "config"), `[filter "x"]\n\tclean = touch ${env.marker}\n`, { flag: "a" }),
    "config symlinked to the canary": async (env) => {
      await rm(path.join(env.workspace.gitDir, "config"));
      await symlink(env.canary, path.join(env.workspace.gitDir, "config"));
    },
    "config hard-linked": async (env) => link(path.join(env.workspace.gitDir, "config"), path.join(env.outside, "alias")),
    "hooks/ planted": async (env) => mkdir(path.join(env.workspace.gitDir, "hooks")),
    "info/ planted": async (env) => mkdir(path.join(env.workspace.gitDir, "info")),
    "trusted directory is a symlink": async (env) => {
      await rename(env.workspace.gitDir, path.join(env.root, "git-aside"));
      await symlink(path.join(env.root, "git-aside"), env.workspace.gitDir);
    },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    await t.test(name, async (st) => {
      const env = await setup(st);
      await writeFile(path.join(env.ws, "src/.gitattributes"), "*.py filter=x\n");
      await writeFile(path.join(env.ws, "src/model.py"), "changed\n");
      await tamper(env);
      await assert.rejects(collectChanges(env.workspace, env.repo.sha), TAMPERED);
      await assertUnchanged(env.canary, CANARY);
      await assertNoMarker(env);
    });
  }
});

test("R01: the trusted git directory sits outside the checkout and holds no credentials, hooks or remotes", async (t) => {
  const env = await setup(t);
  assert.equal(path.dirname(env.workspace.gitDir), env.workspace.root);
  assert.ok(!env.workspace.gitDir.startsWith(env.ws + path.sep));
  await assert.rejects(stat(path.join(env.workspace.gitDir, "hooks")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(env.workspace.gitDir, "FETCH_HEAD")), { code: "ENOENT" });
  assert.doesNotMatch(env.workspace.trustedGitConfig, /remote|url\s*=|extraheader/i);
  // The agent's checkout is a working repository (objects via alternates).
  assert.equal(git(env.ws, "rev-parse", "HEAD").trim(), env.repo.sha);
  assert.match(git(env.ws, "log", "--oneline", "-1"), /seed/);
});
