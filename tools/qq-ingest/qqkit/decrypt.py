"""Decrypt QQ NT databases (fake 1024B header + SQLCipher pages, raw key).

Verified layout (page_size 4096):
  page 1 : [salt 16][ct 4032][iv 16][hmac 20][pad 12]
  page n : [ct 4048][iv 16][hmac 20][pad 12]
Plaintext page = decrypted bytes + zero padding; page 1 keeps the standard
"SQLite format 3" magic that the fake file header replaces with "SQLite header 3".
"""
import hashlib
import hmac
import os
import sqlite3
import time

from .aes_cng import AesCbc

PAGE = 4096
JUNK = 1024
MAGIC = b"SQLite format 3\x00"


def page_plain(aes, page, pgno):
    if pgno == 1:
        return MAGIC + aes.decrypt(page[4048:4064], page[16:4048])
    return aes.decrypt(page[4048:4064], page[0:4048])


def verify(src, key_hex):
    key = bytes.fromhex(key_hex)
    with open(src, "rb") as f:
        f.seek(JUNK)
        page = f.read(PAGE)
    salt = page[0:16]
    hk = hashlib.pbkdf2_hmac("sha512", key, bytes(b ^ 0x3A for b in salt), 2, 32)
    msg = page[16:4048] + page[4048:4064] + (1).to_bytes(4, "little")
    return hmac.new(hk, msg, hashlib.sha1).digest() == page[4064:4084]


def decrypt_db(src, dst, key_hex, every=50_000, log=print):
    key = bytes.fromhex(key_hex)
    total = os.path.getsize(src) - JUNK
    npages = total // PAGE
    t0 = time.time()
    with open(src, "rb") as f, open(dst, "wb") as out, AesCbc(key) as aes:
        f.seek(JUNK)
        for pgno in range(1, npages + 1):
            page = f.read(PAGE)
            if len(page) < PAGE:
                break
            pt = page_plain(aes, page, pgno)
            out.write(pt + b"\x00" * (PAGE - len(pt)))
            if every and pgno % every == 0:
                log(f"  {pgno}/{npages} pages  {time.time() - t0:.1f}s")
    return npages


def apply_wal(db_path, wal_path, key_hex, log=print):
    """Overlay the committed frames of a still-open -wal onto the plaintext db."""
    if not os.path.exists(wal_path) or os.path.getsize(wal_path) < 32:
        return 0
    with open(wal_path, "rb") as f:
        data = f.read()
    fsz = int.from_bytes(data[8:12], "big")
    if fsz not in (1024, 2048, 4096, 8192, 16384, 32768, 65536):
        return 0
    frames, pending, final_size = [], [], 0
    off = 32
    while off + 24 + fsz <= len(data):
        fh = data[off : off + 24]
        pgno = int.from_bytes(fh[0:4], "big")
        dbsize = int.from_bytes(fh[4:8], "big")
        pending.append((pgno, data[off + 24 : off + 24 + fsz]))
        if dbsize:
            frames.extend(pending)
            pending = []
            final_size = dbsize
        off += 24 + fsz
    if not frames:
        return 0
    key = bytes.fromhex(key_hex)
    with AesCbc(key) as aes, open(db_path, "r+b") as db:
        for pgno, page in frames:
            pt = aes.decrypt(page[4048:4064], page[0:4048])
            db.seek((pgno - 1) * fsz)
            db.write(pt + b"\x00" * (fsz - len(pt)))
        db.truncate(final_size * fsz)
    return len(frames)


def decrypt_all(src, dst, key_hex, with_wal=True, every=50_000, log=print):
    if not verify(src, key_hex):
        raise SystemExit("HMAC 校验失败：这个 key 不对应这个库")
    n = decrypt_db(src, dst, key_hex, every, log)
    wal = 0
    if with_wal:
        try:
            wal = apply_wal(dst, src + "-wal", key_hex, log)
        except Exception as e:
            log(f"  WAL 叠加跳过: {e}")
    return n, wal


def open_db(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.execute("select count(*) from sqlite_master").fetchone()
    return con


def table_names(con):
    return [r[0] for r in con.execute(
        "select name from sqlite_master where type='table' order by name")]
