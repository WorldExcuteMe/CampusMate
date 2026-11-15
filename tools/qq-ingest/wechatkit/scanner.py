"""WeChat 4.x 取钥：只读扫描 Weixin.exe 内存（指针解引用 + 页1 HMAC 验证）。

WeChat 4.x 的 32 字节 raw key 存于堆缓冲，其指针位于 Weixin.exe 可写数据段。
扫描模块映像内的指针候选 → 解引用 32 字节 → 用 message_0.db 页1 HMAC-SHA512 验证。
若扫描未命中（版本差异），用 --key 手动提供（可经 chatlog 等工具获取）。
"""
import ctypes
import struct
import subprocess
import re

from qqkit.scanner import k32, MBI, READABLE
from . import decrypt

MEM_IMAGE = 0x1000000
WRITABLE = {0x04, 0x40}


def wechat_pids():
    out = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Weixin.exe", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="gbk", errors="replace",
    ).stdout
    rows = []
    for line in out.splitlines():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 5 and parts[0].lower() == "weixin.exe":
            rows.append((int(parts[1]), int(re.sub(r"[^\d]", "", parts[4]) or 0)))
    return [p for p, _ in sorted(rows, key=lambda r: -r[1])]


def find_key(db_path, cap=6000, log=print):
    pids = wechat_pids()
    if not pids:
        raise SystemExit("Weixin.exe 没在运行：先登录微信再取 key")
    tried = 0
    for pid in pids:
        h = k32.OpenProcess(0x0410, False, pid)
        if not h:
            log(f"  pid {pid}: 打不开内存 (err={ctypes.get_last_error()})")
            continue
        try:
            addr = 0
            while addr < 0x7FFFFFFF0000 and tried < cap:
                mbi = MBI()
                if not k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                    break
                base, size = mbi.BaseAddress, mbi.RegionSize
                addr = base + size
                if not (mbi.State == 0x1000 and mbi.Type == MEM_IMAGE and mbi.Protect in WRITABLE and size):
                    continue
                buf = ctypes.create_string_buffer(size)
                n = ctypes.c_size_t(0)
                if not k32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, size, ctypes.byref(n)):
                    continue
                data = buf.raw[: n.value]
                for off in range(0, len(data) - 8, 8):
                    ptr = struct.unpack_from("<Q", data, off)[0]
                    if not (0x10000 < ptr < 0x7FFFFFFF0000) or ptr % 8:
                        continue
                    kb = ctypes.create_string_buffer(32)
                    got = ctypes.c_size_t(0)
                    if not k32.ReadProcessMemory(h, ctypes.c_void_p(ptr), kb, 32, ctypes.byref(got)) or got.value != 32:
                        continue
                    tried += 1
                    key_hex = kb.raw.hex()
                    if decrypt.verify(db_path, key_hex):
                        log(f"  命中 key（尝试 {tried}）")
                        return key_hex
                    if tried >= cap:
                        break
            log(f"  pid {pid}: 尝试 {tried} 个指针候选")
        finally:
            k32.CloseHandle(h)
    return None