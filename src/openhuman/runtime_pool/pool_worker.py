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
import io
import json
import time
import contextlib
import traceback

PROTOCOL_VERSION = 1

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
    out = io.StringIO()
    err = io.StringIO()
    exit_code = 0
    timed_out = False

    old_cwd = None
    if cwd:
        try:
            old_cwd = os.getcwd()
            os.chdir(cwd)
        except Exception:
            old_cwd = None

    armed = False
    if _HAVE_ALARM and timeout_ms and timeout_ms > 0:
        def _on_alarm(_signum, _frame):
            raise _JobTimeout()

        signal.signal(signal.SIGALRM, _on_alarm)
        signal.setitimer(signal.ITIMER_REAL, timeout_ms / 1000.0)
        armed = True

    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
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
            err.write(str(e.code) + "\n")
    except BaseException:  # noqa: B036 - surface any job failure to the caller
        exit_code = 1
        err.write(traceback.format_exc())
    finally:
        if armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
        if old_cwd is not None:
            try:
                os.chdir(old_cwd)
            except Exception:
                pass

    return {
        "id": job.get("id"),
        "ok": True,
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
        "exit_code": None if timed_out else exit_code,
        "timed_out": timed_out,
        "elapsed_ms": int((time.time() - start) * 1000),
        "error": None,
    }


def _reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


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
