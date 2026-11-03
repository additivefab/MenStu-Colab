// Builds the container command as an argv array (never a shell string).
//
// Parameter passing rule (documented in README):
//   spec.entrypoint.params are appended to spec.entrypoint.argv as
//   `--<key>=<value>`, keys sorted by UTF-16 code unit; booleans become
//   `true`/`false`, numbers use JavaScript's String(). Keys must match
//   /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/. Values are passed verbatim as single argv
//   elements, so shell metacharacters have no meaning.
//
// Fixed mount points inside the container:
//   /src  code checkout (read-only)   /data dataset (read-only)   /out outputs (read-write)

export const CONTAINER_SRC = "/src";
export const CONTAINER_DATA = "/data";
export const CONTAINER_OUT = "/out";

/** Default isolation flags; see README "Isolation" for privilege notes. */
export const DEFAULT_ISOLATION_FLAGS = ["--containall", "--cleanenv", "--no-home", "--net", "--network", "none"];

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_DIGEST = /@(sha256:[0-9a-f]{64})$/;

export function imageDigestFromRef(imageRef) {
  const match = IMAGE_DIGEST.exec(String(imageRef ?? ""));
  return match ? match[1] : "";
}

export function paramArgs(params) {
  const args = [];
  for (const key of Object.keys(params ?? {}).sort()) {
    if (!PARAM_KEY.test(key)) throw new Error(`invalid parameter key: ${JSON.stringify(key)}`);
    const value = params[key];
    if (typeof value === "string") args.push(`--${key}=${value}`);
    else if (typeof value === "boolean") args.push(`--${key}=${value ? "true" : "false"}`);
    else if (typeof value === "number" && Number.isFinite(value)) args.push(`--${key}=${String(value)}`);
    else throw new Error(`invalid parameter value for ${key}`);
  }
  return args;
}

/** Integer seeds taken only from params named `seed` or `seed_*`/`seed-*`. */
export function seedsFromParams(params) {
  return Object.keys(params ?? {})
    .filter((key) => /^seed(?:[_-].*)?$/i.test(key))
    .sort()
    .map((key) => params[key])
    .filter((value) => typeof value === "number" && Number.isInteger(value));
}

function assertBindablePath(label, path) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`${label} must be an absolute path`);
  if (/[:,\n\r\0]/.test(path)) throw new Error(`${label} must not contain ':' ',' or control characters (Apptainer bind syntax)`);
}

/**
 * Resolves the local image for a digest-pinned imageRef. Admins map refs to
 * pre-pulled SIF files; pulling by digest at run time is opt-in.
 */
export function resolveImage(imageRef, apptainerConfig) {
  if (!imageDigestFromRef(imageRef)) throw new Error("entrypoint imageRef must be pinned with @sha256:<digest>");
  const mapped = apptainerConfig.images?.[imageRef];
  if (mapped) return mapped;
  if (apptainerConfig.allowPullByDigest) return `docker://${imageRef}`;
  throw new Error(`image ${imageRef} is not provisioned on this runner (apptainer.images)`);
}

/**
 * Returns { argv, env } for the job launcher. `env` contains only
 * APPTAINERENV_* values (passed into the container even with --cleanenv) and
 * the host variables the apptainer binary itself needs.
 */
export function buildContainerCommand({ spec, runId, srcDir, dataPath, outDir, apptainer }) {
  assertBindablePath("code checkout path", srcDir);
  assertBindablePath("dataset path", dataPath);
  assertBindablePath("output path", outDir);
  if (spec.network !== "deny") throw new Error("spec.network must be deny");
  if (!Array.isArray(spec.entrypoint?.argv) || !spec.entrypoint.argv.length || spec.entrypoint.argv.some((arg) => typeof arg !== "string")) {
    throw new Error("spec.entrypoint.argv must be a non-empty string array");
  }
  const image = resolveImage(spec.entrypoint.imageRef, apptainer);
  const isolation = apptainer.isolationFlags ?? DEFAULT_ISOLATION_FLAGS;
  const resources = spec.resources ?? {};
  const argv = [
    apptainer.binary || "apptainer",
    "exec",
    ...isolation,
    ...(resources.gpuCount > 0 ? ["--nv"] : []),
    ...(apptainer.applyMemoryLimit && resources.memoryGb > 0 ? ["--memory", `${resources.memoryGb}G`] : []),
    "--bind", `${srcDir}:${CONTAINER_SRC}:ro`,
    "--bind", `${dataPath}:${CONTAINER_DATA}:ro`,
    "--bind", `${outDir}:${CONTAINER_OUT}:rw`,
    // `--cwd` per current Apptainer docs ("synonym for --pwd"); Apptainer 1.0 needs "--pwd".
    apptainer.cwdFlag || "--cwd", CONTAINER_SRC,
    ...(apptainer.extraFlags ?? []),
    image,
    ...spec.entrypoint.argv,
    ...paramArgs(spec.entrypoint.params),
  ];
  const env = {
    APPTAINERENV_TANYAN_RUN_ID: runId,
    APPTAINERENV_TANYAN_SRC_DIR: CONTAINER_SRC,
    APPTAINERENV_TANYAN_DATA_DIR: CONTAINER_DATA,
    APPTAINERENV_TANYAN_OUT_DIR: CONTAINER_OUT,
  };
  return { argv, env };
}
