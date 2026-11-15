"""Locate the QQ NT SQLCipher raw key by read-only scan of QQ.exe memory.

QQ keeps the key as a SQLCipher keyspec string:  x'<64 hex key><32 hex salt>'
The salt suffix identifies which database the key belongs to, and the page-1
HMAC proves the key before we use it.
"""
import ctypes
import hashlib
import hmac
import re
import subprocess
from ctypes import wintypes

PAGE = 4096
JUNK = 1024
READABLE = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
k32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.CloseHandle.argtypes = [wintypes.HANDLE]


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD), ("_a1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong), ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD), ("_a2", wintypes.DWORD),
    ]


def db_salt(db_path):
    with open(db_path, "rb") as f:
        f.seek(JUNK)
        return f.read(16)


def verify(db_path, key_hex):
    """Page-1 HMAC check: hmac_key = PBKDF2-SHA512(key, salt^0x3a, 2)."""
    key = bytes.fromhex(key_hex)
    with open(db_path, "rb") as f:
        f.seek(JUNK)
        page = f.read(PAGE)
    salt = page[0:16]
    hk = hashlib.pbkdf2_hmac("sha512", key, bytes(b ^ 0x3A for b in salt), 2, 32)
    msg = page[16:4048] + page[4048:4064] + (1).to_bytes(4, "little")
    return hmac.new(hk, msg, hashlib.sha1).digest() == page[4064:4084]


def qq_pids():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq QQ.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="gbk", errors="replace",
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 5 and parts[0].lower() == "qq.exe":
            rows.append((int(parts[1]), int(re.sub(r"[^\d]", "", parts[4]) or 0)))
    return [p for p, _ in sorted(rows, key=lambda r: -r[1])]


def scan(salt_hex, log=print):
    """Return distinct 64-hex keys that are immediately followed by salt_hex."""
    found, needles = set(), (salt_hex.lower().encode(), salt_hex.upper().encode())
    hexset = set(b"0123456789abcdefABCDEF")
    CHUNK = 8 << 20
    pids = qq_pids()
    if not pids:
        raise SystemExit("QQ.exe 没在运行：先登录 QQ 再取 key")
    for pid in pids:
        h = k32.OpenProcess(0x0410, False, pid)
        if not h:
            log(f"  pid {pid}: 打不开内存 (err={ctypes.get_last_error()})，可能权限或位数不符")
            continue
        buf = ctypes.create_string_buffer(CHUNK + 256)
        scanned = 0
        try:
            addr, limit = 0, 0x7FFFFFFF0000
            while addr < limit:
                mbi = MBI()
                if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                    break
                base, size = mbi.BaseAddress, mbi.RegionSize
                addr = base + size
                if not (mbi.State == 0x1000 and mbi.Protect in READABLE and size > 0):
                    continue
                off = 0
                while off < size:
                    back = 256 if off else 0
                    want = min(CHUNK, size - off)
                    nread = ctypes.c_size_t(0)
                    ok = k32.ReadProcessMemory(
                        h, ctypes.c_void_p(base + off - back), buf, want + back, ctypes.byref(nread)
                    )
                    off += want
                    if not ok or not nread.value:
                        continue
                    data = buf.raw[: nread.value]
                    scanned += len(data)
                    for needle in needles:
                        i = data.find(needle)
                        while i != -1:
                            start = i - 64
                            if start >= 0 and all(b in hexset for b in data[start:i]):
                                found.add(data[start:i].decode().lower())
                            i = data.find(needle, i + 1)
            log(f"  pid {pid}: 扫描 {scanned / 2**20:.0f} MiB，命中 {len(found)}")
        finally:
            k32.CloseHandle(h)
    return found


def find_key(db_path, log=print):
    salt = db_salt(db_path)
    log(f"目标库 salt: {salt.hex()}")
    for key_hex in scan(salt.hex(), log):
        if verify(db_path, key_hex):
            return key_hex
    return None
