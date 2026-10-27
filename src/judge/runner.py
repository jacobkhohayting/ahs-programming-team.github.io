#!/usr/bin/env python3
"""
Sandboxed process runner used by the judge.

    python3 -I runner.py spec.json

The spec (JSON) describes a command to run with resource limits. The result is
printed to stdout as one JSON object. This runs the program in a fresh session
(process group) so that everything it spawns can be killed together, applies
RLIMITs (CPU, memory, processes, file size, open files, core dumps), optionally
unshares the network namespace, and optionally drops privileges to an
unprivileged user when the judge itself runs as root.
"""
import json
import os
import resource
import signal
import subprocess
import sys
import time


def main():
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        spec = json.load(f)

    cmd = spec['cmd']
    cwd = spec.get('cwd') or os.getcwd()
    cpu_limit = int(spec.get('cpu_limit_sec') or 10)
    wall_limit = float(spec.get('wall_limit_ms') or 10000) / 1000.0
    as_bytes = spec.get('as_bytes')
    stack_bytes = spec.get('stack_bytes')
    nproc = int(spec.get('nproc') or 128)
    fsize = int(spec.get('fsize_bytes') or 64 * 1024 * 1024)
    nofile = int(spec.get('nofile') or 64)
    uid = spec.get('uid')
    gid = spec.get('gid')
    unshare_net = bool(spec.get('unshare_net'))
    env = spec.get('env') or {'PATH': '/usr/local/bin:/usr/bin:/bin'}

    stdin_f = open(spec['stdin'], 'rb') if spec.get('stdin') else subprocess.DEVNULL
    stdout_f = open(spec['stdout'], 'wb')
    stderr_f = open(spec['stderr'], 'wb')

    def fail(msg):
        try:
            os.write(2, ('[sandbox] ' + msg + '\n').encode())
        finally:
            os._exit(125)

    def preexec():
        # 1) Network isolation. As root a plain network namespace is enough; as a
        #    normal user we need a user namespace as well.
        if unshare_net:
            try:
                if os.geteuid() == 0:
                    os.unshare(os.CLONE_NEWNET)
                else:
                    os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
            except Exception as e:  # pragma: no cover
                fail('network isolation failed: %s' % e)
        # 2) Resource limits.
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_limit, cpu_limit + 1))
            resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
            resource.setrlimit(resource.RLIMIT_NOFILE, (nofile, nofile))
            try:
                resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
            except Exception:
                pass
            if stack_bytes:
                try:
                    resource.setrlimit(resource.RLIMIT_STACK, (int(stack_bytes), int(stack_bytes)))
                except Exception:
                    pass
            if as_bytes:
                resource.setrlimit(resource.RLIMIT_AS, (int(as_bytes), int(as_bytes)))
        except Exception as e:
            fail('setting resource limits failed: %s' % e)
        # 3) Drop privileges (only possible when the judge runs as root).
        if uid is not None and os.geteuid() == 0:
            try:
                os.setgroups([])
                os.setgid(int(gid if gid is not None else uid))
                os.setuid(int(uid))
            except Exception as e:
                fail('dropping privileges failed: %s' % e)

    result = {
        'ok': True, 'exit_code': None, 'signal': None, 'timed_out': False,
        'cpu_ms': 0, 'wall_ms': 0, 'max_rss_kb': 0, 'sandbox_error': None,
    }

    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd, env=env, stdin=stdin_f, stdout=stdout_f, stderr=stderr_f,
            preexec_fn=preexec, start_new_session=True, close_fds=True,
        )
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'could not start process: %s' % e}))
        return

    timed_out = False
    try:
        proc.wait(timeout=wall_limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(proc)
    wall_ms = int((time.monotonic() - start) * 1000)
    # Kill anything the program left behind in its process group.
    kill_group(proc)

    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    rc = proc.returncode
    result['timed_out'] = timed_out
    result['cpu_ms'] = int((usage.ru_utime + usage.ru_stime) * 1000)
    result['wall_ms'] = wall_ms
    result['max_rss_kb'] = int(usage.ru_maxrss)
    if rc is not None and rc < 0:
        result['signal'] = -rc
    else:
        result['exit_code'] = rc
    if rc == 125:
        result['ok'] = False
        result['sandbox_error'] = 'sandbox setup failed (see stderr)'
    print(json.dumps(result))


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        pass
    for _ in range(50):
        try:
            proc.wait(timeout=0.1)
            break
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass


if __name__ == '__main__':
    main()
