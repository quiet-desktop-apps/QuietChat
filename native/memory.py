"""Release unused native heap pages after UI resources have been discarded."""
import ctypes
import gc


try:
    # Optional glibc facility. Other platforms still benefit from object cleanup.
    _trim = ctypes.CDLL(None).malloc_trim
    _trim.argtypes = [ctypes.c_size_t]
    _trim.restype = ctypes.c_int
except (AttributeError, OSError):
    _trim = None


def release_unused():
    gc.collect()
    return bool(_trim(0)) if _trim else False
