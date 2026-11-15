"""WeChat WCDB/SQLCipher 解密，多参数集自动探测（版本通用）。

参数集:
  wechat4: page4096 reserve80 HMAC-SHA512 KDF256000 (4.x)
  wechat3: page4096 reserve48 HMAC-SHA1   KDF64000  (3.x)
布局: page1 [salt16][ct usable-16][iv16][hmac]; pageN [ct usable][iv16][hmac]。
enc=PBKDF2(hash,key,salt,kdf,32); hk=PBKDF2(hash,enc,salt^0x3a,2,32)。
"""
import hashlib
import hmac
import os
import sqlite3
import time

from qqkit.aes_cng import AesCbc

PAGE = 4096
MAGIC = b"SQLite format 3\x00"

PARAM_SETS = [
    {"name": "wechat4", "hash": "sha512", "kdf": 256000, "reserve": 80, "hmac_len": 64},
    {"name": "wechat3", "hash": "sha1", "kdf": 64000, "reserve": 48, "hmac_len": 20},
]


def _derive(key, salt, p):
    enc = hashlib.pbkdf2_hmac(p["hash"], key, salt, p["kdf"], 32)
    hk = hashlib.pbkdf2_hmac(p["hash"], enc, bytes(b ^ 0x3A for b in salt), 2, 32)
    return enc, hk


def _parts(page, pgno, p):
    usable = PAGE - p["reserve"]
    hl = p["hmac_len"]
    if pgno == 1:
        return page[16:usable], page[usable:usable + 16], page[usable + 16:usable + 16 + hl]
    return page[0:usable], page[usable:usable + 16], page[usable + 16:usable + 16 + hl]


def verify_with(src, key_hex, p):
    key = bytes.fromhex(key_hex)
    with open(src, "rb") as f:
        page = f.read(PAGE)
    salt = page[0:16]
    _, hk = _derive(key, salt, p)
    ct, iv, mac = _parts(page, 1, p)
    msg = ct + iv + (1).to_bytes(4, "little")
    return hmac.new(hk, msg, getattr(hashlib, p["hash"])).digest() == mac


def detect_params(src, key_hex):
    for p in PARAM_SETS:
        if verify_with(src, key_hex, p):
            return p
    return None


def verify(src, key_hex):
    return detect_params(src, key_hex) is not None


def decrypt_db(src, dst, key_hex, every=50_000, log=print):
    p = detect_params(src, key_hex)
    if not p:
        raise SystemExit("HMAC 校验失败：key 不对应此库（已尝试 wechat4/wechat3 参数集）")
    log(f"  参数集: {p['name']}")
    key = bytes.fromhex(key_hex)
    with open(src, "rb") as f:
        salt = f.read(16)
        f.seek(0)
        enc, _ = _derive(key, salt, p)
        npages = os.path.getsize(src) // PAGE
        t0 = time.time()
        with open(dst, "wb") as out, AesCbc(enc) as aes:
            for pgno in range(1, npages + 1):
                page = f.read(PAGE)
                if len(page) < PAGE:
                    break
                ct, iv, _ = _parts(page, pgno, p)
                pt = aes.decrypt(iv, ct)
                if pgno == 1:
                    pt = MAGIC + pt
                out.write(pt + b"\x00" * (PAGE - len(pt)))
                if every and pgno % every == 0:
                    log(f"  {pgno}/{npages} pages {time.time()-t0:.1f}s")
    return npages


def open_db(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.execute("select count(*) from sqlite_master").fetchone()
    return con


def table_names(con):
    return [r[0] for r in con.execute("select name from sqlite_master where type='table' order by name")]