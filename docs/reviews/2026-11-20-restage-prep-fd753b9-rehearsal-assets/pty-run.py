#!/usr/bin/python3
"""Run a command with a pseudo-terminal on stdin, stdout and stderr, for commands that refuse to apply
without a terminal (`triangle identity upgrade-registry --confirm`). The command's output goes to stdout
with the terminal's CR LF line ends turned back into LF; the last stderr line is `pty-exit: N`.

usage: pty-run.py COMMAND [ARG...]
"""
import os
import pty
import sys


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: pty-run.py COMMAND [ARG...]\n")
        return 64
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write("exec failed: %s\n" % error)
            os._exit(127)
    chunks = []
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    sys.stdout.buffer.write(b"".join(chunks).replace(b"\r\n", b"\n"))
    sys.stdout.flush()
    sys.stderr.write("pty-exit: %d\n" % code)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
