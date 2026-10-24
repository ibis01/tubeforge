import os, sys, time
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
print("dev server restarted (daemonized)")
