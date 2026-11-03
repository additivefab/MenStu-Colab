#!/usr/bin/env python3
"""Isolation probe, Python port of probe.mjs (same plan, same output schema).

Used by the lab-runner preflight inside training images that ship Python but
not Node. Reports only outcomes ("allowed" / "blocked" + error code); it never
prints file contents or environment values other than CUDA_VISIBLE_DEVICES.

    python3 probe.py <plan.json>
"""
import errno
import json
import os
import re
import socket
import subprocess
import sys

PROBE_SCHEMA = "tanyan.isolation-probe/v1"
PLAN_SCHEMA = "tanyan.isolation-probe-plan/v1"


def code_of(exc):
    if isinstance(exc, socket.timeout):
        return "TIMEOUT"
    if isinstance(exc, socket.gaierror):
        return "ENOTFOUND"
    num = getattr(exc, "errno", None)
    if isinstance(num, int) and num in errno.errorcode:
        return errno.errorcode[num]
    return type(exc).__name__


def resolve_target(op):
    if op.get("envBase"):
        base = os.environ.get(op["envBase"])
        if not base:
            return None, "BASE_UNSET"
        return os.path.join(base, op.get("rel", "")), None
    return op.get("path"), None


def probe_read(target):
    try:
        if os.path.isdir(target):
            os.listdir(target)
            return {"outcome": "allowed", "kind": "dir"}
        with open(target, "rb") as handle:
            handle.read(1)
        return {"outcome": "allowed", "kind": "file"}
    except Exception as exc:  # noqa: BLE001 - every failure means "blocked"
        return {"outcome": "blocked", "code": code_of(exc)}


def probe_write(target):
    name = os.path.join(target, ".tanyan-probe-" + os.urandom(6).hex())
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except Exception as exc:  # noqa: BLE001
        return {"outcome": "blocked", "code": code_of(exc)}
    try:
        os.write(fd, b"x")
    except Exception:  # noqa: BLE001
        pass
    finally:
        os.close(fd)
        try:
            os.unlink(name)
        except Exception:  # noqa: BLE001
            pass
    return {"outcome": "allowed"}


def probe_connect(family, address, timeout_ms):
    sock = None
    try:
        if family == "tcp":
            sock = socket.create_connection(address, timeout=timeout_ms / 1000.0)
        else:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(timeout_ms / 1000.0)
            sock.connect(address)
        return {"outcome": "allowed"}
    except Exception as exc:  # noqa: BLE001
        return {"outcome": "blocked", "code": code_of(exc)}
    finally:
        if sock is not None:
            sock.close()


def probe_gpu():
    try:
        dev_nodes = len([n for n in os.listdir("/dev") if re.match(r"^nvidia\d+$", n)])
    except Exception:  # noqa: BLE001
        dev_nodes = 0
    result = {"outcome": "info", "devNodes": dev_nodes, "smiCount": None, "cudaVisibleDevices": os.environ.get("CUDA_VISIBLE_DEVICES")}
    try:
        out = subprocess.run(["nvidia-smi", "-L"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True).stdout.decode("utf-8", "replace")
        result["smiCount"] = len([line for line in out.splitlines() if re.match(r"^GPU \d+:", line.strip())])
    except Exception as exc:  # noqa: BLE001
        result["code"] = code_of(exc)
    return result


def run_probe(plan):
    if plan.get("schema") != PLAN_SCHEMA or not isinstance(plan.get("ops"), list):
        raise ValueError("not a tanyan isolation probe plan")
    results = []
    for op in plan["ops"]:
        base = {"id": str(op.get("id")), "check": str(op.get("check")), "op": op.get("op"), "expect": op.get("expect")}
        kind = op.get("op")
        if kind in ("read", "write"):
            target, error = resolve_target(op)
            if error:
                outcome = {"outcome": "error", "code": error}
            else:
                outcome = probe_read(target) if kind == "read" else probe_write(target)
        elif kind == "connect":
            outcome = probe_connect("tcp", (str(op["host"]), int(op["port"])), int(op.get("timeoutMs") or 3000))
        elif kind == "unix":
            outcome = probe_connect("unix", str(op["path"]), int(op.get("timeoutMs") or 2000))
        elif kind == "exists":
            try:
                os.lstat(str(op["path"]))
                outcome = {"outcome": "allowed"}
            except Exception as exc:  # noqa: BLE001
                outcome = {"outcome": "blocked", "code": code_of(exc)}
        elif kind == "env":
            present = [n for n in op.get("names", []) if n in os.environ]
            outcome = {"outcome": "allowed" if present else "blocked", "present": present}
        elif kind == "gpu":
            outcome = probe_gpu()
        else:
            outcome = {"outcome": "error", "code": "UNKNOWN_OP"}
        base.update(outcome)
        results.append(base)
    return {
        "schema": PROBE_SCHEMA,
        "uid": os.getuid() if hasattr(os, "getuid") else None,
        "gid": os.getgid() if hasattr(os, "getgid") else None,
        "runtime": "python " + sys.version.split()[0],
        "results": results,
    }


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: probe.py <plan.json>\n")
        sys.exit(64)
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        plan = json.load(handle)
    sys.stdout.write(json.dumps(run_probe(plan)) + "\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("probe failed: %s\n" % exc)
        sys.exit(1)
