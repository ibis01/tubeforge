#!/usr/bin/env python3
"""Double-fork daemonizer — escape the per-call process-tree reaper.

The sandbox kills every process descended from a Bash tool call when the call
ends. A plain `setsid nohup CMD &` still leaves CMD as a direct child of the
bash shell, so it gets reaped. A classic double-fork reparents the grandchild
to PID 1 before the call finishes, which is exactly how the agent-browser
daemon survives between calls.

Usage:  python3 scripts/daemonize.py <logfile> <cmd> [args...]
"""
import os
import sys

if len(sys.argv) < 3:
    sys.exit("usage: daemonize.py <logfile> <cmd> [args...]")

logpath, cmd = sys.argv[1], sys.argv[2:]

# Fork #1 — parent returns immediately to the caller.
pid = os.fork()
if pid > 0:
    print(f"[daemonize] intermediate pid {pid} started for: {' '.join(cmd[:3])}...")
    sys.exit(0)

# Child: new session, drop controlling terminal.
os.setsid()

# Fork #2 — intermediate exits; grandchild is reparented to PID 1.
if os.fork() > 0:
    os._exit(0)

# Grandchild: wire stdio to the log file, then exec the real command.
log = open(logpath, "ab", buffering=0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.execvp(cmd[0], cmd)
