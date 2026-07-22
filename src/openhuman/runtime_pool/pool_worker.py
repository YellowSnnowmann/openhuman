# OpenHuman runtime-pool Python worker harness (issue #5106).
#
# A single long-lived `python` process that executes inline Python jobs for many
# skill runs, so the fleet pays one warm interpreter instead of one child per
# run.
#
# Protocol (newline-delimited JSON over stdio, see runtime_pool/protocol.rs):
#   1. Print exactly one ready line: {"ready":true,"protocol":1,"lang":"python"}
#   2. For each request line {id,kind:"inline",code,cwd,timeout_ms} reply with
#      {id,ok,stdout,stderr,exit_code,timed_out,elapsed_ms,error}.
#
# Each job runs in this interpreter with stdout/stderr redirected into buffers so
# a job's prints never corrupt the protocol stream. Isolation is per-job globals
# plus the pool's recycle-after-N-jobs; CPython cannot safely kill a running
# thread, so the soft deadline is best-effort SIGALRM on Unix and otherwise the
# Rust side's hard deadline kills + respawns the worker.

import sys
import os
import json
import time
import tempfile
import traceback

PROTOCOL_VERSION = 1

# Private duplicate of the original stdout fd, reserved for NDJSON protocol
# frames. Per-job code redirects fd 1/2 to capture buffers (below), so protocol
# output stays isolated from — and is never corrupted by — job output.
_PROTO = os.fdopen(os.dup(1), "w", buffering=1)

try:
    import signal

    _HAVE_ALARM = hasattr(signal, "SIGALRM") and hasattr(signal, "setitimer")
except Exception:  # pragma: no cover - platform without signal
    signal = None
    _HAVE_ALARM = False


class _JobTimeout(Exception):
    pass


def _run_job(job):
    code = job.get("code") or ""
    cwd = job.get("cwd")
    timeout_ms = job.get("timeout_ms")
    start = time.time()
    exit_code = 0
    timed_out = False
    extra_err = ""

    old_cwd = None
    if cwd:
        try:
            old_cwd = os.getcwd()
            os.chdir(cwd)
        except Exception:
            old_cwd = None

    # Capture at the FILE-DESCRIPTOR level (not just `sys.stdout`) so
    # `os.write(1, ...)`, subprocesses, and native extensions are captured too —
    # otherwise they would leak onto the real stdout, which is the NDJSON
    # protocol channel. Temp files (vs pipes) avoid buffer-deadlock on large
    # output.
    out_f = tempfile.TemporaryFile(mode="w+b")
    err_f = tempfile.TemporaryFile(mode="w+b")
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    os.dup2(out_f.fileno(), 1)
    os.dup2(err_f.fileno(), 2)

    armed = False
    if _HAVE_ALARM and timeout_ms and timeout_ms > 0:
        def _on_alarm(_signum, _frame):
            raise _JobTimeout()

        signal.signal(signal.SIGALRM, _on_alarm)
        signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000.0)
        armed = True

    try:
        # Fresh globals per job so top-level names don't leak between runs.
        g = {"__name__": "__main__", "__builtins__": __builtins__}
        exec(compile(code, "<inline>", "exec"), g, g)
    except _JobTimeout:
        timed_out = True
    except SystemExit as e:  # honour sys.exit(n)
        if e.code is None:
            exit_code = 0
        elif isinstance(e.code, int):
            exit_code = e.code
        else:
            exit_code = 1
            extra_err = str(e.code) + "\n"
    except BaseException:  # noqa: B036 - surface any job failure to the caller
        exit_code = 1
        extra_err = traceback.format_exc()
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
        # Flush Python's buffers to the redirected fds, then restore the real
        # stdout/stderr before reading the captures.
        try:
            sys.stdout.flush()
        except Exception:
            pass
        try:
            sys.stderr.flush()
        except Exception:
            pass
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        if old_cwd is not None:
            try:
                os.chdir(old_cwd)
            except Exception:
                pass

    out_f.seek(0)
    err_f.seek(0)
    stdout = out_f.read().decode("utf-8", "replace")
    stderr = err_f.read().decode("utf-8", "replace") + extra_err
    out_f.close()
    err_f.close()

    return {
        "id": job.get("id"),
        "ok": True,
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": None if timed_out else exit_code,
        "timed_out": timed_out,
        "elapsed_ms": int((time.time() - start) * 1000),
        "error": None,
    }


def _reply(obj):
    _PROTO.write(json.dumps(obj) + "\n")
    _PROTO.flush()


def main():
    _reply({"ready": True, "protocol": PROTOCOL_VERSION, "lang": "python"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except Exception:
            continue  # ignore unparseable lines
        try:
            res = _run_job(job)
        except Exception as e:  # harness-level failure
            res = {
                "id": job.get("id") if isinstance(job, dict) else None,
                "ok": False,
                "stdout": "",
                "stderr": "",
                "exit_code": None,
                "timed_out": False,
                "elapsed_ms": 0,
                "error": repr(e),
            }
        _reply(res)


if __name__ == "__main__":
    main()
