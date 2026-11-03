# Agent worker (lab side)

This Node 22+ daemon runs on a trusted lab machine. It pulls confirmed research
tasks from the platform and runs a coding agent on each one in an isolated
checkout. Codex is the first provider and Claude the second. Each run uses the
task owner's own subscription credentials. The worker returns a constrained
change set: `ChangedFile[]` plus a unified diff.

The worker never pushes to GitHub. The platform's trusted publisher creates the
branch and the draft PR after review (spec §6.2).

Contract: `docs/科研闭环_实施规格_v1.md` §7.2, with types from
`lib/research-loop/contracts.ts`. The worker imports those types directly, so
it must run with `node --experimental-strip-types`.

> **Status: not yet validated against live Codex or Claude accounts.** All
> tests use a fake platform, a fake adapter, an injected fake Codex SDK module
> and a fake `claude` binary. Before going live, run one real attempt per
> provider with a test account and check the event mapping, usage fields and
> cancellation (see "Live validation checklist").

## Flow

```
claim ──► verify contextSnapshotSha256 = sha256(canonicalJson({task, baseCommitSha})) (else CONTEXT_MISMATCH)
      ──► work/<attemptId>/repo: git fetch exactly baseCommitSha (short-lived read token via
          one-shot http.extraHeader env; never in argv/.git/config), verify HEAD, no remotes
      ──► prompt + policy from the task snapshot and worker config only (repo text grants nothing)
      ──► per-profile lock (<profilesDir>/<id>/.run.lock, O_EXCL, stale-pid recovery)
      ──► adapter.start → streamEvents → sanitize (redact, cap 16 kB, monotonic sequence, ≤100/batch)
      ──► heartbeat every 30 s: cancelRequested → adapter.requestCancel; 409 LEASE_LOST → stop, no result
      ──► budget: task.budget.maxAgentMinutes (capped by limits.maxAgentMinutes) → cancel, then give up
          after cancelGraceSeconds (profile stays locked until the stray run ends)
      ──► collect: restore trusted .git/config, drop hooks, `git add -A`, raw diff vs base → files
          (base64 + sha256 + mode 100644/100755), `git diff --binary` → unifiedDiff
      ──► local evaluatePathPolicy: outside allowed → failed POLICY_VIOLATION (no files sent);
          protected touched → change_ready + status event (platform sets requires_extra_review)
      ──► result (tests = real commands with provider-reported exit codes; usage)
```

Result error codes: `CONTEXT_MISMATCH`, `POLICY_VIOLATION`, `BUDGET_EXCEEDED`, `AGENT_UNRESPONSIVE`,
`NO_CHANGES`, `CHANGE_TOO_LARGE`, `SECRET_IN_CHANGES`, `UNSUPPORTED_CHANGE`
(symlink or submodule), `WORKSPACE_ERROR`, `WORKSPACE_TAMPERED`,
`NO_READ_ACCESS`, `PROFILE_NOT_FOUND`, `PROFILE_INSECURE`, `PROFILE_INVALID`,
`PROVIDER_UNSUPPORTED`, `AGENT_FAILED`, `AGENT_START_FAILED`, `MAX_TURNS`,
`WORKER_SHUTDOWN`, `WORKER_ERROR`.

A platform cancel gives outcome `canceled`.

## Files

| File | Purpose |
|---|---|
| `worker.mjs` | Config, main loop, `runAttempt`, event sink, result |
| `platform-client.mjs` | `POST /api/lab/agent-attempts` (claim, heartbeat, events, result) and `LeaseLostError` |
| `workspace.mjs` | Fetch and checkout, credential stripping, binary-safe change collection |
| `prompt.mjs` | `buildAgentPolicy` and `buildPrompt` (task snapshot + config only) |
| `profiles.mjs` | Profile paths, permission checks, per-profile lock |
| `sanitize.mjs` | Redactor (exact secrets + patterns), payload capping, redacting logger |
| `adapters/base.mjs` | AgentAdapter contract and `UnsupportedError` |
| `adapters/codex.mjs`, `adapters/claude.mjs`, `adapters/fake.mjs` | Providers; `fake` is for tests |
| `config.example.json` | Example config |

## Adapter capabilities (T24)

| | streaming | cancel | resume | toolApproval | structuredResult | usage |
|---|---|---|---|---|---|---|
| codex | yes | yes (AbortSignal → SDK kills `codex exec`) | **no**: `resume()` rejects `UnsupportedError` | no (`approvalPolicy: "never"`) | no | yes (`turn.completed.usage`) |
| claude | yes | yes (SIGINT, then SIGTERM, then SIGKILL) | **no**: `resume()` rejects `UnsupportedError` | no (`dontAsk`) | no | yes (`result.usage`, `num_turns`, cost estimate) |

The Codex SDK has `resumeThread()`, but this adapter does not implement "resume
with approved context". It reports `resume: false` instead of pretending.

### Codex invocation

`new Codex({ env, config })`. `env` replaces `process.env` entirely: the
child gets only `PATH`, `HOME` (per attempt), `TMPDIR` (per attempt),
`LANG` and `CODEX_HOME=<profilesDir>/<profileId>/codex`. `config` sets
`project_doc_max_bytes=0`, so AGENTS.md is not auto-injected as instructions.
It also sets `cli_auth_credentials_store="file"` and `history.persistence="none"`.

`startThread({ model, sandboxMode: "workspace-write", workingDirectory: <checkout>,
skipGitRepoCheck: false, networkAccessEnabled: false, webSearchMode: "disabled",
approvalPolicy: "never" })`, then `runStreamed(prompt, { signal })`.

The workspace is never marked trusted, so Codex skips the repository's
`.codex/` config, hooks and rules. Do not add a `[projects]` entry for
`workRoot` to a profile's `config.toml`.

### Claude invocation (exact argv)

```
claude -p --output-format stream-json --verbose --safe-mode
  --setting-sources user --settings '{"disableAllHooks":true}' --strict-mcp-config
  --tools Read,Edit,Write,Glob,Grep,Bash
  --allowedTools Read,Edit,Write,Glob,Grep,Bash(<prefix>),Bash(<prefix> *)…   # one pair per agent.testCommandPrefixes entry
  --disallowedTools WebFetch,WebSearch,mcp__*,Bash(curl *),Bash(wget *),Bash(ssh *),Bash(scp *),Bash(git push *),Bash(git remote *),Bash(git config *),Bash(pip install *),Bash(npm install *)
  --permission-mode dontAsk --max-turns <agent.maxTurns> --no-session-persistence --model <modelId>
```

The prompt goes in on stdin. With no test prefixes configured, `Bash` is
dropped from `--tools`.

Child env, an allowlist: `PATH`, `HOME` and `TMPDIR` (per attempt), `LANG`,
`CLAUDE_CONFIG_DIR=<profile>/claude/config`,
`CLAUDE_CODE_OAUTH_TOKEN=<contents of <profile>/claude/oauth_token>`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.

Nothing else from the worker's environment is passed. That excludes
`ANTHROPIC_API_KEY`, which would otherwise take precedence over the OAuth
token.

`--bare` is deliberately **not** used: the docs state that bare mode does not
read `CLAUDE_CODE_OAUTH_TOKEN`. Without it, `claude -p` would run project
hooks and `.mcp.json` servers from an untrusted folder. These flags keep that
out:

- `--safe-mode`: no CLAUDE.md, skills, plugins, hooks or MCP.
- `--setting-sources user`: project settings files and `.mcp.json` are not read.
- `--settings '{"disableAllHooks":true}'`
- `--strict-mcp-config` with no `--mcp-config`

As a further check, the adapter aborts with `POLICY_VIOLATION` if the
`system/init` message lists any MCP server, `WebFetch`, `WebSearch` or an
`mcp__*` tool.

Test records: Claude Code marks a non-zero Bash exit as `is_error`. The exit
code is recorded only when it is 0 (no error) or when the output states
`Exit code N`. Otherwise no test record is created and a
`test_exit_code_unknown` status event is emitted instead. Codex records use the
CLI's `exit_code`.

## Provisioning a credential profile

The platform stores only the mapping user ↔ profile id ↔ worker. Credentials
exist only on the worker, under the dedicated service user.

1. **Register on the platform (super admin).** Call
   `POST /api/admin/agent-credential-profiles` with
   `{"action":"create","userId":"…","provider":"codex"|"claude","workerId":"agent-worker-lab01"}`.
   Note the returned profile id (`cred_…`). Use `{"action":"deactivate","id":"…"}`
   to revoke it.
2. **Create the directory on the worker** as the service user:
   `install -d -m 0700 /var/lib/tanyan-agent-worker/profiles/cred_…`
3. **Codex (ChatGPT sign-in).** The user signs in with their own account. Do
   this on the worker if device-code login is enabled, or copy a freshly
   created `auth.json`:

   ```sh
   sudo -u tanyan-agent env CODEX_HOME=/var/lib/tanyan-agent-worker/profiles/cred_…/codex \
     sh -c 'install -d -m 0700 "$CODEX_HOME" && printf "cli_auth_credentials_store = \"file\"\n" > "$CODEX_HOME/config.toml" && codex login --device-auth'
   chmod 600 /var/lib/tanyan-agent-worker/profiles/cred_…/codex/auth.json
   ```

   Check that `auth.json` has `auth_mode` `"chatgpt"` and a refresh token.
   Codex refreshes and rewrites `auth.json` during runs, roughly every 8
   days. **Never overwrite it from the original seed.** Use one `auth.json`
   per profile on one machine only. The worker serializes runs per profile
   because concurrent jobs can rotate the refresh token underneath each other.
4. **Claude (`claude setup-token`).** The user runs `claude setup-token` on
   any machine where they can open a browser. It prints a one-year OAuth
   token for their Pro/Max/Team/Enterprise subscription and saves nothing.
   Store the token on the worker:

   ```sh
   sudo -u tanyan-agent sh -c 'umask 077; install -d -m 0700 /var/lib/tanyan-agent-worker/profiles/cred_…/claude && cat > /var/lib/tanyan-agent-worker/profiles/cred_…/claude/oauth_token'
   # paste the token, then Ctrl-D; do not put it in shell history or a command line
   ```

The worker refuses to run (`PROFILE_INSECURE`) in these cases:

- `auth.json` or `oauth_token` is readable by group or other.
- `auth.json` or `oauth_token` is a symlink.
- The `codex` directory is not mode 0700.

## Configuration

Copy `config.example.json` and edit it. Relative paths resolve against the
config file. The worker token comes from `AGENT_WORKER_TOKEN` or from
`tokenFile` (mode 0600), never from the config itself.

- `gitReadFallback` is used when claim returns `repository: null`, which means
  the platform has no GitHub App. It can point at a read-only deploy key or at
  a local mirror (`urlTemplate: "file:///srv/mirrors/{fullName}.git"`).
- `agent.testCommandPrefixes` controls two things: which Bash commands Claude
  may run without asking, and which commands are reported as tests for either
  provider.
- `maxConcurrentAttempts` lets different profiles run in parallel. Runs on the
  same profile always queue.

```sh
cd infra/agent-worker && npm ci                # installs @openai/codex-sdk 0.166.0 (+ codex binary)
npm install -g @anthropic-ai/claude-code       # or the native installer; put it at claude.claudePath
node --experimental-strip-types worker.mjs --config /etc/tanyan-agent-worker/config.json
```

### systemd unit (example)

```ini
[Unit]
Description=Tanyan agent worker
After=network-online.target
Wants=network-online.target

[Service]
User=tanyan-agent
Group=tanyan-agent
WorkingDirectory=/opt/tanyan/infra/agent-worker
ExecStart=/usr/bin/node --experimental-strip-types /opt/tanyan/infra/agent-worker/worker.mjs --config /etc/tanyan-agent-worker/config.json
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/tanyan-agent-worker
ReadOnlyPaths=/etc/tanyan-agent-worker
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
# Do not set RestrictNamespaces=yes without testing: the Codex Linux sandbox
# may need unprivileged user namespaces on your distribution.

[Install]
WantedBy=multi-user.target
```

On SIGTERM the worker stops claiming and cancels running agents. It reports
them as `failed`/`WORKER_SHUTDOWN`.

## Isolation: what is real and what is assumed

| Property | Enforced by | Status |
|---|---|---|
| Agent never gets GitHub write credentials | Worker only ever holds a contents:read token, used for one fetch through env; there is no remote and no push | Real (tested) |
| Read token not persisted | Not in argv, `.git/config` or the remote list; registered for redaction | Real (tested) |
| Other profiles' credentials not visible to the agent | The child env holds only its own profile. **Files under `profilesDir` are readable by the service user, so a shell command from the agent could read them unless the OS prevents it** | **Assumed.** Needs the OS measures below |
| Only allowed paths change | Worker-side `evaluatePathPolicy` before sending; platform re-checks | Real (tested, T04) |
| Protected paths flagged | Worker status event; platform sets `requires_extra_review` | Real on the worker (tested, T05); the platform side belongs to W3 |
| Repository text cannot widen policy | Policy and prompt are pure functions of the task snapshot and config; Claude runs with repository settings, hooks and MCP disabled; Codex runs in an untrusted project with AGENTS.md injection off | Real at the worker level (tested, T14). Model behaviour is not tested |
| No network except the model | Codex `networkAccessEnabled:false` (workspace-write sandbox). Claude has no web tools, and Bash is limited to test prefixes, **but a test command such as `pytest` can still run arbitrary repository code** | **Partly assumed.** Needs an egress firewall |
| No access to datasets | No data paths are mounted or passed | **Assumed.** Needs a dedicated user with no data mounts |
| Bounded runtime | `maxAgentMinutes` budget, cancel and force-stop; Claude `--max-turns` | Real (tested, T16) |
| Planted git filters and hooks don't run on the worker | Trusted `.git/config` restored, hooks dir removed, `--no-ext-diff --no-textconv`, `GIT_NO_REPLACE_OBJECTS` | Real (tested) |

Required OS measures (recommended deployment):

1. A dedicated unprivileged user (`tanyan-agent`) with no sudo, no docker
   group and no data mounts. Do not run the worker on a GPU host that has
   dataset mounts.
2. An egress firewall for that user: allow only the model endpoints
   (`chatgpt.com`/`api.openai.com` for Codex, `api.anthropic.com` and
   `claude.ai` for Claude), `github.com` for the fetch, and the platform URL.
   Deny everything else.
3. Ideally, run each attempt in its own container or VM with only
   `work/<attemptId>` and that one profile mounted. This closes the gap
   above where an agent shell command could read another profile's files.
   The current worker does not do this.

## Subscription terms caveat

D3 uses each person's own consumer or team subscription, not API keys. Both
vendors' docs recommend API keys for automation:

- The Codex CI/CD guide says to use ChatGPT-managed auth only for trusted
  private automation that must run as your account.
- `claude setup-token` is documented for CI and scripts, but the token is tied
  to the user's plan.

Each user must confirm that running their subscription on a lab machine for
their own research tasks complies with the provider terms and their
organisation's policy. One profile belongs to exactly one person, and
profiles must never be shared. Usage counts against that person's plan
limits. Claude's `total_cost_usd` is a client-side estimate, not a bill.

## Live validation checklist (not done yet)

- Codex: confirm on a real account that `codex exec` honours the
  `project_doc_max_bytes=0` and `history.persistence="none"` overrides.
  Check that `item.*` events, `turn.completed.usage` and abort behave as the
  0.166.0 typings describe, and that `auth.json` is rewritten in place after
  a refresh.
- Claude: confirm the argv above runs with a `setup-token` token on the
  deployed CLI version (`--safe-mode` and `dontAsk` need a recent CLI). Check
  that `system/init` shows no MCP servers and that `tool_result` content for
  failing Bash commands states the exit code. Also confirm SIGINT ends the run
  with a `result` message.
- Both: confirm the egress firewall blocks a test command that tries
  `curl https://example.com`.

## Tests

```sh
node --experimental-strip-types --test infra/agent-worker/*.test.mjs   # also run by the root `npm test`
```

Fakes only, with no network beyond 127.0.0.1 and no SDK install needed. The
real adapters load `@openai/codex-sdk` and spawn `claude` lazily.

## Sources relied on (checked 2026-11-03)

- `@openai/codex-sdk@0.166.0` published typings and `dist/index.js`, inspected
  from the npm tarball (CodexOptions.env replaces process.env; ThreadOptions;
  ThreadEvent and ThreadItem; TurnOptions.signal; Usage). Source:
  https://github.com/openai/codex/tree/main/sdk/typescript
- Codex auth: https://learn.chatgpt.com/docs/auth.md
- Codex CI/CD auth (persist refreshed `auth.json`, one file per serialized
  stream): https://learn.chatgpt.com/docs/auth/ci-cd-auth
- Codex config keys: https://learn.chatgpt.com/docs/config-file/config-sample.md
- Codex project trust: https://learn.chatgpt.com/docs/config-file/config-basic.md
- Claude headless mode, `--bare` and OAuth, stream-json, SIGINT/SIGTERM:
  https://code.claude.com/docs/en/headless
- Claude CLI flags (`--safe-mode`, `--setting-sources`, `--tools`,
  `--disallowedTools`, `--max-turns`, `--permission-mode`, `setup-token`):
  https://code.claude.com/docs/en/cli-reference
- What `claude -p` loads from an untrusted folder:
  https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder
- `setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`, auth precedence, and bare mode
  not reading the token: https://code.claude.com/docs/en/authentication
- Environment variables: https://code.claude.com/docs/en/env-vars
