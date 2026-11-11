"""Publish a validated sibling directory without replacing any existing destination."""
import ctypes
import errno
import os
import stat
import sys


def publish(parent, staging, destination, parent_dev, parent_ino, stage_dev, stage_ino):
    if any('/' in name or name in ('', '.', '..') for name in (staging, destination)):
        raise ValueError('publication requires sibling names')
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        observed = os.fstat(fd)
        if (observed.st_dev, observed.st_ino) != (parent_dev, parent_ino):
            raise ValueError('publication parent changed')
        observed = os.stat(staging, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISDIR(observed.st_mode) or (observed.st_dev, observed.st_ino) != (stage_dev, stage_ino):
            raise ValueError('owned staging changed')
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform == 'darwin':
            operation, flag = getattr(libc, 'renameatx_np', None), 4  # RENAME_EXCL
        elif sys.platform.startswith('linux'):
            operation, flag = getattr(libc, 'renameat2', None), 1  # RENAME_NOREPLACE
        else:
            operation, flag = None, 0
        if operation is None:
            raise OSError(errno.ENOTSUP, 'exclusive publication unavailable')
        operation.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        operation.restype = ctypes.c_int
        if operation(fd, os.fsencode(staging), fd, os.fsencode(destination), flag):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        publish(*sys.argv[1:4], *(int(value) for value in sys.argv[4:]))
    except OSError as error:
        print(str(error), file=sys.stderr)
        sys.exit(17 if error.errno in (errno.EEXIST, errno.ENOTEMPTY) else 1)
    except (ValueError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
