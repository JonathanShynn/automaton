#!/usr/bin/env python3
"""Run a command on disposable Linux with no inherited secrets or new sockets.

This is a network boundary, not a complete filesystem sandbox. Use the
evaluation container on machines containing credentials or personal files.
Requires libseccomp; failure to install the filter aborts the command.
"""
import ctypes
import ctypes.util
import errno
import os
from pathlib import Path
import resource
import socket
import sys


def main():
    command = sys.argv[1:]
    if not command:
        raise SystemExit("Usage: run-offline.py COMMAND [ARGS ...]")
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise SystemExit("libseccomp is required; refusing an online fallback")
    lib = ctypes.CDLL(library, use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise SystemExit("Cannot allocate seccomp filter")
    try:
        # New sockets and outbound network operations are forbidden, including
        # those attempted by spawned children. Existing pipe-based IPC works.
        for name in ("socket", "connect", "sendto", "sendmsg", "sendmmsg"):
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number < 0 or lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0):
                raise SystemExit(f"Cannot deny syscall: {name}")
        if lib.seccomp_load(context):
            raise SystemExit("Cannot load seccomp filter; refusing to run")
    finally:
        lib.seccomp_release(context)
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            connection = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno != errno.EPERM:
                raise
        else:
            connection.close()
            raise SystemExit("Network self-check failed")
    temporary = Path(os.environ.get("TMPDIR", "/tmp"))
    environment = {
        "PATH": str(Path(command[0]).resolve().parent) + ":/usr/local/bin:/usr/bin:/bin",
        "TMPDIR": str(temporary),
        "TZ": "UTC",
        "LANG": "C.UTF-8",
        "NODE_ENV": "test",
        "AUTOMATON_OFFLINE_EVALUATION": "1",
    }
    # Do not hand preconnected service/proxy descriptors to the evaluated code.
    maximum_fd = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    if maximum_fd == resource.RLIM_INFINITY:
        maximum_fd = 1_048_576
    os.closerange(3, maximum_fd)
    print("Offline boundary active: sockets denied; inherited environment removed", flush=True)
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    main()
