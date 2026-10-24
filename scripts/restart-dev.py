import os, sys, time, subprocess

# Fully restart the Next.js dev server:
#   1. kill any existing next dev / next-server processes (they hold port 3000)
#   2. wipe .next (Turbopack caches compiled modules — stale chunks from an
#      older Prisma client or schema otherwise keep getting served)
#   3. start a fresh daemonized `next dev -p 3000` logging to dev.log

# 1) kill old servers
try:
    out = subprocess.run(
        ["pkill", "-f", "next dev -p 3000"],
        capture_output=True, text=True, timeout=30,
    )
except FileNotFoundError:
    out = None
try:
    subprocess.run(["pkill", "-f", "next-server"], capture_output=True, text=True, timeout=30)
except FileNotFoundError:
    pass
# also catch the `npm exec next dev` wrapper processes
try:
    subprocess.run(["pkill", "-f", "npm exec next dev"], capture_output=True, text=True, timeout=30)
except FileNotFoundError:
    pass
time.sleep(2)

# 2) wipe the build cache
subprocess.run(["rm", "-rf", "/home/z/my-project/.next"], timeout=60)

# 3) wait for the port to actually free up
for _ in range(20):
    probe = subprocess.run(
        ["bash", "-c", "ss -tln | grep -q ':3000 ' && echo busy || echo free"],
        capture_output=True, text=True,
    )
    if probe.stdout.strip() == "free":
        break
    time.sleep(1)

# 4) daemonize the fresh server
pid = os.fork()
if pid == 0:
    os.setsid()
    pid2 = os.fork()
    if pid2 == 0:
        os.chdir("/home/z/my-project")
        with open("/home/z/my-project/dev.log", "ab") as log:
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            os.execvp("npx", ["npx", "next", "dev", "-p", "3000"])
    os._exit(0)
os.waitpid(pid, 0)

# 5) wait until it answers
deadline = time.time() + 120
import urllib.request
while time.time() < deadline:
    try:
        urllib.request.urlopen("http://localhost:3000/api/videos?limit=1", timeout=5)
        print("dev server restarted (daemonized, .next wiped)")
        sys.exit(0)
    except Exception:
        time.sleep(2)
print("dev server restarted (daemonized) — port 3000 not answering yet, may still be compiling")
