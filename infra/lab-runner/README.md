# Lab compute runner (`infra/lab-runner/`)

> **Status: not yet validated on real GPU hardware, real Slurm, or real Apptainer.**
> Everything below is covered only by hermetic tests against a fake platform, a
> fake Slurm (`test-support/fake-slurm.mjs`) and an Apptainer stand-in that
> provides **no isolation** (`test-support/apptainer-shim.mjs`). Acceptance
> items T14, T15 and T22 still need a real-environment check.

The runner is a Node 22+ daemon on the lab's GPU servers. It implements spec
§7.1 (`docs/科研闭环_实施规格_v1.md`) against the protocol in
`lib/research-loop/contracts.ts`:

- It **pulls** work from `POST /api/lab/runs` over HTTPS with a Bearer runner
  token. It opens no inbound ports (D4).
- It runs only approved, immutable RunSpecs, inside Apptainer, through a
  scheduler adapter (`local` or `slurm`).
- Jobs **compute on data but never copy it out** (D5). The data is bound read-only, the job
  has no network, and every output passes the egress gate before anything
  leaves the lab.

## Layout

| File | Role |
|---|---|
| `runner.mjs` | Main loop: claim → execute or reconcile → heartbeat → complete. CLI entry. |
| `job-launcher.mjs` | Runs on the execution node: probes `nvidia-smi`, spawns the container argv, enforces walltime, records `status.json`. |
| `egress.mjs` | Egress gate (pure; reads `out/` with lstat and writes nothing). |
| `manifest.mjs` | `RunManifest` builder. It uses only real values. |
| `schedulers/local.mjs`, `schedulers/slurm.mjs` | Scheduler adapters with one interface: `submit`, `findByTag`, `query`, `cancel`. |
| `lib/checkout.mjs` | Fetches exactly `executedCommitSha`, without persisting the token. |
| `lib/container.mjs` | Builds the Apptainer argv and applies the parameter-passing rule. |
| `lib/dataset.mjs` | Checks the dataset manifest hash and extracts per-file hashes. |
| `lib/config.mjs` | Validates the config and loads the token. |
| `runner.config.example.json` | Example configuration. |
| `lab-runner.service` | Example systemd unit. |

## Install

1. Node 22.6+ on the runner host. Under Slurm, you also need Node on every compute
   node, at the same path as `nodePath`.
2. Check out this repository, for example at `/opt/tanyan`. The runner imports
   `lib/research-loop/contracts.ts` directly, so it needs
   `node --experimental-strip-types`. Node 23.6+ strips types by default. No `npm install` is needed: the runner uses only Node built-ins.
3. Register the runner (superuser): `POST /api/admin/lab {action:"register_runner", kind:"compute"}`.
   The token is shown only once. Save it to `/etc/tanyan/lab-runner.token`,
   owned by the service user with `chmod 600`, or provide it as
   `TANYAN_LAB_RUNNER_TOKEN`. The config refuses a `token` key, and every log line is
   redacted.
4. Copy `runner.config.example.json` to `/etc/tanyan/lab-runner.json` and edit
   it (see below).
5. Install `lab-runner.service` (systemd) and run `systemctl enable --now lab-runner`.

Only one runner may use a given `workRoot`. A lock file (`.runner.lock`) enforces this.

## Configuration

| Key | Meaning |
|---|---|
| `platformUrl` | Platform origin. HTTPS is required. Plain HTTP is accepted only for `localhost` / `127.0.0.1` (tests). |
| `runnerId` | The registered runner id. It appears in manifests and lab locators. |
| `tokenFile` | Path to the runner token. `TANYAN_LAB_RUNNER_TOKEN` takes precedence. |
| `workRoot` | Absolute path. Per-run directory: `<workRoot>/<runId>/{state.json, src/, out/, job.json, job.mjs, status.json, env.json}`. Under Slurm it must be on a filesystem shared with the compute nodes. |
| `nodePath` | Interpreter written into each run's `job.mjs` shebang. |
| `git`, `githubBaseUrl` | Git binary, and the base URL used with the minted token. |
| `nvidiaSmi` | Path to `nvidia-smi`, or `null` to skip. If it is missing or fails, driver and GPU are reported as `""` and never guessed. |
| `scheduler.type` | `local` or `slurm`. |
| `scheduler.passEnv` | Host variables passed to scheduler commands. Names that look like credentials are refused. |
| `scheduler.slurm` | Command paths, `extraArgs` (`--partition=…`, `--account=…`), `sacctLookbackDays`. |
| `limits.submitVisibilitySeconds`, `limits.submitVisibilityPollSeconds` | How long (default 300 s) and how often (default 10 s) a submit with an unknown outcome is reconciled by `submitTag` before the run fails `SUBMIT_OUTCOME_UNKNOWN`. Set the window above the cluster's worst `squeue`/`sacct` visibility delay. |
| `apptainer.*` | See "Isolation". `images` maps each digest-pinned `imageRef` to a pre-pulled SIF. `allowPullByDigest` lets the runner use `docker://<imageRef>` instead. |
| `datasets[]` | `{versionId, dataPath, manifestPath, splitManifestPath?}` for each dataset version hosted here. |
| `gitReadFallback` | `{url}` used when the claim returns `repository: null` (no GitHub App, or reconcile mode). Typical values are a local mirror path or an SSH URL that uses the host's own read-only deploy key. |
| `limits` | `maxConcurrentRuns` (1), `heartbeatSeconds` (30), `pollSeconds` (15), `claimIntervalSeconds` (20), `killGraceSeconds` (30), `maxArtifacts` (500), `requestTimeoutSeconds` (60). |

### Dataset manifest format

`manifestPath` must hash, byte for byte, to `spec.dataset.manifestSha256`. When
the spec names a split manifest, `splitManifestPath` must match
`splitManifestSha256`. On a mismatch the run fails **before** checkout or
submission. Per-file hashes are read from either:

- JSON, where every property named `sha256` at any depth counts; or
- `sha256sum` output (`<hex>  <path>`).

If the manifest yields no per-file hashes, the run fails, because the raw-copy check
would be meaningless. The manifest's own hash and the split manifest's hash are
also added to the blocked set.

## Execution flow

1. **claim**. The runner validates `runId` and `submitTag` and writes `state.json`.
   Repository tokens are kept in memory only. An immediate heartbeat confirms the lease
   and picks up a pending cancel.
2. **execute**:
   1. Check the data binding (above).
   2. Check out the code (below).
   3. Write `job.json` and `job.mjs`.
   4. Call **`findByTag(submitTag)`**. If a job is found, adopt it. If an earlier
      submit has no recorded job id, reconcile it (see "Unknown submit outcomes").
      Otherwise submit, once.
   5. Record the job id at once.
   6. Poll the scheduler and send a heartbeat every `heartbeatSeconds`, with phase
      `dispatching` → `running` → `collecting`.
   7. Run the egress gate, then build the manifest and metrics.
   8. Send `complete`.
3. **reconcile**. The runner runs `findByTag`, falling back to the recorded job id
   from the claim, local state or submit receipt, then reports `{found, schedulerJobId, schedulerState}`.
   If the job is not found **and no submit was ever started** (no `submitStartedAt`, no receipt),
   the run goes back to dispatching and is submitted under this lease, again after a `findByTag`.
   If a submit was started, an empty `findByTag` is not proof of absence: see below. If it is pending or running, the runner monitors it. If it
   has finished, the runner collects outputs and sends `complete`. If it has failed
   or been canceled, the run is terminal on the platform and nothing more is done.
   The reconcile response (`ComputeReconcileResponse = {status, leaseExpiresAt,
   cancelRequested}`) takes precedence: its `cancelRequested` is persisted like a
   heartbeat's, and its lease time renews the local lease clock. No heartbeat is
   sent before the reconcile call, because the platform answers heartbeats for a
   run in `reconciling` with `409 RECONCILE_REQUIRED`.
4. **cancel** (`cancelRequested` in a heartbeat):
   - Before submission, the run completes as `canceled` without starting anything.
   - After submission, the runner calls `cancel(<recorded job id>)` and polls until
     the scheduler reports the job ended. It re-issues the cancel periodically
     and never sends `complete` before that confirmation. Then it collects partial
     outputs through the gate and sends `complete` with `outcome:"canceled"`.
   - `state.json` keeps the outcome, so neither a restart nor a duplicate claim
     revives the run: the job is found by tag and is already terminal (T13).

### Never submitting twice (T11)

- Every submit is preceded by `findByTag`, and `scheduler.submit` is called **at most once per
  run**: there is no retry.
- `state.submitStartedAt`, `state.submitAttempts` and `state.submit: "submitting"` are persisted
  before submit, and the job id right after.
- Slurm: the adapter creates `<runDir>/submit-receipt.json` with `O_EXCL` **before** `sbatch` runs
  and writes the job id into it afterwards. A second submit for the same run returns the recorded
  job id, or refuses (`SubmitOutcomeUnknownError`) when the receipt has none. A job name is not a
  uniqueness constraint in Slurm, so the receipt is what makes submit exclusive.
- Local: the job record is published exclusively (`link(2)`, `EEXIST` like `O_EXCL`) before the
  process is spawned, and `submit` is idempotent per `submitTag` (it returns the recorded job id).
- Slurm `findByTag` merges `squeue -h -n <tag> -o %i|%T` (active jobs) with
  `sacct -n -X -P --name=<tag> -S <now-lookback> -o JobID,State,ExitCode`
  (finished jobs). `sacct` defaults to today's jobs only, hence the explicit `-S`.

### Unknown submit outcomes (R05)

`state.submit` follows this state machine:

```
(none) ─► submitting ─► submitted                 scheduler returned a job id
                     ├► rejected                  definitive refusal → complete failed "SUBMIT_REJECTED: …"
                     └► unknown ─► adopted        a job with the tag became visible → monitored as usual
                               └► unknown_reported  window passed, nothing visible → "SUBMIT_OUTCOME_UNKNOWN: …"
```

- **Rejected vs unknown.** A submit error is *rejected* only when the adapter proves no job exists:
  `sbatch` could not be started, or it exited non-zero with a controller refusal such as
  `Invalid partition name specified`, `Invalid account`, `Requested node configuration is not
  available`, `Job violates accounting/QOS policy`, or an option-parsing error, and the message
  contains no transport wording (timeout, socket, connect, slurmctld…). Everything else
  (lost responses, timeouts, signals, unparseable output, unclassified messages) is *unknown*.
- **Unknown is never retried.** The runner polls `findByTag` (plus any job id from the claim, state
  or receipt) every `limits.submitVisibilityPollSeconds` (default 10) for
  `limits.submitVisibilitySeconds` (default 300), counted from `state.submitUnknownSince`, the first
  moment the outcome was known to be unknown. Scheduler errors during polling count as "not
  visible yet". A restart that finds `submitStartedAt` or a receipt without a job id enters the
  same state; the window is persisted, so restarts do not extend it.
- **Window passed, nothing visible.** The run is handed to a human, never resubmitted:
  - execute mode (platform status `dispatching`): `complete` with `outcome:"failed"`,
    `failureReason:"SUBMIT_OUTCOME_UNKNOWN: …"`, `manifest:null` (nothing is collected: outputs
    could belong to an unseen job);
  - reconcile mode: `reconcile` with `{found:false, submitOutcome:"unknown"}`. The platform moves
    the run from `reconciling` to `failed` with that reason code instead of to `dispatching`
    (`ComputeReconcileRequest.submitOutcome` in `contracts.ts`).
  An operator checks the scheduler for jobs named `<submitTag>` and reruns deliberately (a rerun
  is a new attempt with a new tag). If the job surfaces before the platform recorded the failure,
  the runner adopts it instead.
- **Reconcile mode and the lease.** Heartbeats are refused while a run is `reconciling`, so the
  wait is capped at the claim's lease minus `requestTimeoutSeconds + pollSeconds`. If the lease
  budget runs out while the window is still open, the runner reports nothing and leaves the run in
  `reconciling`; the next reconcile claim continues the same window.
- **Duplicate live jobs.** If `findByTag` returns more than one live job for a tag, the runner
  cancels **all** of them (best effort; failures are recorded in `state.duplicateJobs`) and fails
  the run with `DUPLICATE_JOBS: …`, without collecting outputs. Keeping the earliest is not safe:
  every job of a run writes into the same `runDir` (`out/`, `status.json`), so its results could
  not be attributed. In reconcile mode the earliest job (lowest Slurm job id) is reported first so
  the platform leaves `reconciling`, then the run is failed the same way.

### Lease-loss policy

On `409 {code:"LEASE_LOST"}`, or when the local lease clock expires while
heartbeats keep failing, the runner **abandons all local actions for that run**:
- no submit;
- no cancel;
- no `complete`;
- heartbeats stop;
- `state.abandonedLeaseEpoch` is recorded.

**The scheduler job is not killed.** The platform re-dispatches the run in
reconcile mode, and whoever holds the new lease adopts the job by `submitTag`. That is usually
this runner after its next claim. If the platform decides to cancel, the new lease
holder learns this from the heartbeat. An orphaned job is bounded by its walltime.
On shutdown (SIGTERM) the runner stops claiming and leaves jobs running for the
same reason.

## Parameter-passing rule

`spec.entrypoint.argv` is used verbatim. Each entry of `spec.entrypoint.params`
is appended as **`--<key>=<value>`**:
- keys are sorted by UTF-16 code unit;
- booleans become `true` / `false`;
- numbers use JavaScript `String()`;
- keys must match `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`.

Each pair is a single argv element. There is no shell anywhere: every process is started with
`spawn(file, argv, {shell:false})`, and a test checks the sources for
shell/exec APIs.

Inside the container:
- `/src` holds the code (read-only);
- `/data` holds the dataset (read-only);
- `/out` holds the outputs (read-write).

The environment variables `TANYAN_RUN_ID`, `TANYAN_SRC_DIR`, `TANYAN_DATA_DIR` and `TANYAN_OUT_DIR` are passed as
`APPTAINERENV_*`. The job's stdout and stderr go to `/out/logs/job.log`, which is
subject to the egress gate like any other output.

Seeds in the manifest come only from integer params named `seed` or `seed_*`.

## Isolation

Default command (each part is configurable):

```
apptainer exec --containall --cleanenv --no-home --net --network none [--nv]
  [--memory <N>G] --bind <src>:/src:ro --bind <data>:/data:ro --bind <out>:/out:rw
  --cwd /src <image.sif> <argv…> --k=v…
```

Flags checked against the Apptainer docs (apptainer.org, `apptainer exec`, the networking and cgroups pages):

| Flag | Effect | Privilege / admin setup |
|---|---|---|
| `--containall` (`-C`) | Contains file systems, PID, IPC and environment. `/tmp` and `$HOME` are empty, per-container directories. | none |
| `--cleanenv` (`-e`) | Cleans the host environment. `APPTAINERENV_*` still injects the variables we set. Verify this on your version. | none |
| `--no-home` | Does not mount the user's home directory. | none |
| `--net --network none` | New network namespace with loopback only. Per the docs, `none` is the only network type unprivileged users may request by default. | Needs either a setuid install or working unprivileged user namespaces. **Verify on the host.** |
| `--nv` | NVIDIA driver and libraries in the container. Added only when `gpuCount > 0`. | NVIDIA driver on the node. `CUDA_VISIBLE_DEVICES` from Slurm is forwarded via `APPTAINERENV_`. |
| `--bind src:dst:ro` | Read-only bind. Paths containing `:` or `,` are refused. | none |
| `--memory <N>G` | Opt-in (`applyMemoryLimit`). | Unprivileged use needs cgroups v2 (unified hierarchy), systemd ≥ 224 with controller delegation, and kernel ≥ 4.15. |
| `--cwd` | Initial working directory. The current docs call it a "synonym for --pwd". Set `cwdFlag: "--pwd"` for Apptainer 1.0. | none |

**What is real and what is assumed:**

- **Real, enforced by the runner:**
  - argv-only execution;
  - an explicit, minimal environment for every child process;
  - the token is never on disk, in argv or in logs;
  - the SHA is checked after checkout and `.git/config` is scanned for credentials;
  - the data-binding hash check;
  - the egress gate;
  - walltime, enforced by the launcher (SIGTERM, then SIGKILL after `killGraceSeconds`) and also by Slurm `--time`.
- **Delegated to Apptainer, the kernel and the admins (assumed, not yet verified on hardware):**
  - network denial;
  - read-only binds;
  - PID/IPC containment;
  - no access to other students' directories or the Docker socket (T15);
  - memory/GPU limits. Slurm cgroups apply on Slurm. On `local`, memory is limited only with `applyMemoryLimit` and GPUs are not arbitrated between concurrent runs.
- **Writable paths:** besides `/out`, `--containall` gives the job writable, ephemeral
  `/tmp` and `$HOME` directories, discarded when the job exits. The SIF image is
  read-only.
- **Image trust:** `apptainer.images` maps a digest-pinned ref to a local SIF.
  The manifest reports the digest from `imageRef`. That the SIF was built from that
  digest is the admin's assertion.
- **Shared runner account:** jobs run under the runner's Unix account. Cross-project
  isolation relies on the binds above, not on separate users.

## Egress gate (D5)

For each entry under `out/`, using `lstat` and never following links:

| Condition | Decision |
|---|---|
| Symbolic link, FIFO, socket or device; name that is not a normalized relative path (backslash, control characters, `.git`); resolved path outside `out/` | `rejected` |
| sha256 equals any dataset-manifest file hash, or the manifest hashes themselves | `rejected` (raw-data copy) |
| Hard link (link count > 1) | `held` |
| Extension not in `allowedExtensions` (or no extension) | `held` |
| Image (`EGRESS_IMAGE_EXTENSIONS` in `contracts.ts`: `.png .jpg .jpeg .gif .bmp .tif(f) .webp .svg .pdf .eps .ico .heic .heif .avif`, the same list the platform re-check uses) with `allowImages=false` | `held` |
| Size > `maxFileBytes`, or > `LIMITS.maxPublishedArtifactBytes` | `held` |
| Running total of published bytes would exceed `maxTotalBytes` (paths in sorted order) | `held` |
| Otherwise | `published` |

- Only published files are sent inline (base64) in `complete`. Held and rejected
  files stay on lab storage. Each artifact carries an opaque
  `labLocator = lab://<runnerId>/<runId>/out/<path>`, which is not a URL.
- `kind` is derived from path and extension only.
- Non-regular entries are reported with `sha256: ""` and `sizeBytes: 0`. The contract
  allows an empty hash only together with `egressDecision: "rejected"`; the platform
  records such entries and never publishes them.
- The raw-copy check matches exact bytes only. A transformed or re-encoded copy of
  data is not detected. That case is covered by the extension, image and size rules
  and by human review of held outputs.

Metrics come only from a **published** `out/metrics.json`. Whenever that file is a
published regular file, the runner reports `metricsArtifactPath: "metrics.json"`, even if
it fails the runner's own check (`validateMetricsFile`, protocol hash equal to the
spec's); the reason is logged and kept in `state.metricsNote`. The platform validates
the file again and records `technical_validity = "invalid"` (T19). Without a published
`metrics.json` the path is `null` and the platform records `unknown`.

## Manifest

All fields come from the claim, from the spec, or from measurements on the execution node:
- `environment.driverVersion` and `gpuModel` come from `nvidia-smi` on the node that
  ran the job, or `""` when it is unavailable;
- `startedAt`, `endedAt` and `exitCode` come from the launcher's `status.json`.

`exitCode` is the process's exit code, or 128 plus the signal number. If the job started but no
exit code could be determined (the launcher was SIGKILLed and the scheduler has
no code), both `manifest.execution.exitCode` and the `complete` request's `exitCode`
are `null` (unknown); the platform compares the two with null-aware equality. When the
job never started, the manifest is `null` and `exitCode` is `null`.

## Slurm vs local

- **slurm:** submits with `sbatch --parsable --job-name=<submitTag> --time=<ceil(walltimeMinutes)>
  --mem=<memoryGb>G [--gres=gpu:<n>] --output=<runDir>/slurm-%j.log --chdir=<runDir> <extraArgs> <runDir>/job.mjs`,
  and cancels with `scancel <jobId>`. Slurm commands run with a minimal environment, because
  sbatch's default `--export=ALL` would otherwise copy the runner's environment into the job.
  `workRoot` and this repository must be visible from the compute nodes.
- **local:** runs the job launcher as a detached child. Job records live in
  `<workRoot>/.local-scheduler/<submitTag>.json`. There is no queue and no GPU arbitration, and liveness
  is tracked by PID, so PID reuse after a host reboot is not detected. Use it for a single-GPU workstation
  with `maxConcurrentRuns: 1`.

## Tests

`npm test` covers `infra/lab-runner/*.test.mjs`. The runner tests use:
- a fake platform with a scripted lease state machine;
- a fake Slurm whose jobs really run as detached processes;
- the Apptainer shim, which runs a tiny Node entrypoint from a temporary git repository.

These tests simulate the platform, Slurm and Apptainer. They are not integration tests.

## Contract decisions (settled by the W8 integration)

- `ComputeReconcileResponse = {status, leaseExpiresAt, cancelRequested}` is defined in
  `contracts.ts`; platform and runner both use it.
- `ManifestArtifact.sha256` may be `""` only for `rejected` entries (non-regular files).
- Unknown exit codes are `null`, never `-1`.
- Invalid metrics are reported (path set) so the platform marks them `invalid`.

`tests/research-loop-e2e.test.mjs` runs this runner unmodified against the real
platform Worker (Miniflare) with simulated GitHub and container.
