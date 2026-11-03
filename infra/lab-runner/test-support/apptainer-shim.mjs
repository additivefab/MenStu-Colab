// Test-only stand-in for `apptainer exec`. It provides NO isolation: it parses
// the argv the runner built, records it, maps the bind mounts back to host
// paths and runs the entrypoint directly. Used only to exercise the runner's
// control flow without Apptainer or a GPU.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const VALUE_FLAGS = new Set(["--network", "--memory", "--bind", "-B", "--cwd", "--pwd", "--network-args", "--env", "--env-file"]);

export async function main(recordPath) {
  const args = process.argv.slice(2);
  if (args[0] !== "exec") {
    process.stderr.write("shim: only exec is supported\n");
    process.exit(64);
  }
  const flags = [];
  const binds = new Map();
  let cwd = "/";
  let index = 1;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) break;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      flags.push(arg, value);
      if (arg === "--bind" || arg === "-B") {
        const [source, destination, mode] = value.split(":");
        binds.set(destination, { source, mode });
      }
      if (arg === "--cwd" || arg === "--pwd") cwd = value;
      index += 1;
    } else flags.push(arg);
  }
  const image = args[index];
  const entry = args.slice(index + 1);
  const toHost = (value) => {
    for (const [destination, bind] of binds) {
      if (value === destination) return bind.source;
      if (value.startsWith(`${destination}/`)) return bind.source + value.slice(destination.length);
    }
    return value;
  };
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const containerEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("APPTAINERENV_")) {
      containerEnv[name.slice("APPTAINERENV_".length)] = value;
      env[name.slice("APPTAINERENV_".length)] = toHost(value);
    }
  }
  appendFileSync(recordPath, `${JSON.stringify({ argv: args, flags, binds: Object.fromEntries(binds), image, entry, containerEnv, hostEnvKeys: Object.keys(process.env).sort() })}\n`);

  const child = spawn(entry[0], entry.slice(1), { cwd: toHost(cwd), env, stdio: "inherit", shell: false });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("close", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 143 : 137)));
}
