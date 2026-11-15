"""AES-CBC via Windows CNG (bcrypt) - no third-party crypto dependency."""
import ctypes
from ctypes import wintypes

_b = ctypes.WinDLL("bcrypt", use_last_error=True)
_L = ctypes.c_long
_V = ctypes.c_void_p
_U = wintypes.ULONG

_b.BCryptOpenAlgorithmProvider.argtypes = [_V, wintypes.LPCWSTR, wintypes.LPCWSTR, _U]
_b.BCryptOpenAlgorithmProvider.restype = _L
_b.BCryptSetProperty.argtypes = [_V, wintypes.LPCWSTR, _V, _U, _U]
_b.BCryptSetProperty.restype = _L
_b.BCryptGenerateSymmetricKey.argtypes = [_V, _V, _V, _U, _V, _U, _U]
_b.BCryptGenerateSymmetricKey.restype = _L
_b.BCryptDecrypt.argtypes = [_V, _V, _U, _V, _V, _U, _V, _U, ctypes.POINTER(_U), _U]
_b.BCryptDecrypt.restype = _L
_b.BCryptDestroyKey.argtypes = [_V]
_b.BCryptCloseAlgorithmProvider.argtypes = [_V, _U]

CBC = "ChainingModeCBC".encode("utf-16-le")


def _ok(st, what):
    if st != 0:
        raise OSError(f"{what} failed, NTSTATUS=0x{st & 0xFFFFFFFF:08x}")


class AesCbc:
    """One key, many independent CBC decryptions with per-call IV."""

    def __init__(self, key: bytes):
        self.h_alg = _V()
        _ok(_b.BCryptOpenAlgorithmProvider(ctypes.byref(self.h_alg), "AES", None, 0), "open")
        _ok(_b.BCryptSetProperty(self.h_alg, "ChainingMode", CBC, len(CBC), 0), "setprop")
        self.h_key = _V()
        _ok(
            _b.BCryptGenerateSymmetricKey(
                self.h_alg, ctypes.byref(self.h_key), None, 0, key, len(key), 0
            ),
            "genkey",
        )

    def decrypt(self, iv: bytes, data: bytes) -> bytes:
        n = len(data)
        if n % 16:
            n -= n % 16
        out = ctypes.create_string_buffer(n if n else 16)
        got = _U(0)
        buf = ctypes.create_string_buffer(data[:n], n if n else 1)
        st = _b.BCryptDecrypt(
            self.h_key,
            ctypes.cast(buf, _V),
            n,
            None,
            ctypes.cast(ctypes.create_string_buffer(iv, 16), _V),
            len(iv),
            ctypes.cast(out, _V),
            n,
            ctypes.byref(got),
            0,
        )
        _ok(st, "decrypt")
        return out.raw[: got.value]

    def close(self):
        if self.h_key:
            _b.BCryptDestroyKey(self.h_key)
            self.h_key = _V()
        if self.h_alg:
            _b.BCryptCloseAlgorithmProvider(self.h_alg, 0)
            self.h_alg = _V()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
