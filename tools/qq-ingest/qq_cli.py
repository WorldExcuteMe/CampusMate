"""QQ NT 聊天记录导出 CLI。

用法:
  python qq_cli.py key                       # 从运行中的 QQ 取库密钥
  python qq_cli.py decrypt                   # 解密 nt_msg.db（含 WAL）
  python qq_cli.py peers                      # 按文字量列出联系人
  python qq_cli.py export --peer 123456789    # 导出某个会话
  python qq_cli.py run --peer 123456789       # key + decrypt + export 一条龙
  python qq_cli.py clean                      # 删除明文库与密钥
"""
import argparse
import glob
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from qqkit import decrypt, exporter, scanner

WS = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(WS, "data")
OUT = os.path.join(WS, "out")
KEY_FILE = os.path.join(DATA, "key.txt")
PLAIN_DB = os.path.join(DATA, "nt_msg.plain.db")


def resolve_db(explicit=None):
    if explicit:
        return explicit
    cands = glob.glob(os.path.expanduser(r"~\Documents\Tencent Files\*\nt_qq\nt_db\nt_msg.db"))
    if not cands:
        raise SystemExit("没找到 nt_msg.db，用 --db 指定路径")
    return max(cands, key=os.path.getsize)


def load_key(db_path=None):
    if os.path.exists(KEY_FILE):
        k = open(KEY_FILE).read().strip()
        if len(k) == 64 and (not db_path or decrypt.verify(db_path, k)):
            return k
        print("本地 key 已失效（库换了或 key 过期），重新提取")
    return None


def cmd_key(a):
    import struct
    if struct.calcsize("P") != 8:
        print(f"当前 Python 是 {8*struct.calcsize('P')} 位，读不了 64 位 QQ 进程内存。用 64 位解释器，例如：")
        print(r'  C:\Users\Asus\miniconda3\python.exe qq_cli.py key')
        return 2
    db = resolve_db(a.db)
    k = load_key(db)
    if k:
        print(f"已有可用 key: {k[:16]}… ({KEY_FILE})")
        return 0
    t0 = time.time()
    k = scanner.find_key(db, log=print)
    if not k:
        print("未找到密钥。确认 QQ 已登录、且用 64 位 Python 运行。")
        return 1
    os.makedirs(DATA, exist_ok=True)
    with open(KEY_FILE, "w") as f:
        f.write(k)
    print(f"key 已验证并保存: {k}  ({time.time() - t0:.1f}s)")
    return 0


def cmd_decrypt(a):
    db = resolve_db(a.db)
    k = load_key(db) or (cmd_key(a) or None)
    if not k:
        return 1
    if os.path.exists(a.out) and not a.force:
        print(f"{a.out} 已存在，加 --force 覆盖")
        return 0
    t0 = time.time()
    n, wal = decrypt.decrypt_all(db, a.out, k, with_wal=not a.no_wal, log=print)
    print(f"解密 {n} 页（{os.path.getsize(a.out)/2**20:.0f} MiB），叠加 {wal} 个 WAL 帧，{time.time()-t0:.1f}s")
    con = decrypt.open_db(a.out)
    print(f"表 {len(decrypt.table_names(con))} 张，可用")
    return 0


def cmd_peers(a):
    con = decrypt.open_db(a.db)
    names = exporter.name_map(con)
    me = guess_me(con)
    print(f"本机 QQ: {me} ({names.get(me, '?')})\n")
    print(f"{'QQ号':<12}{'纯文字':<8}{'条数':<6}{'总消息':<8}{'时间跨度':<24}昵称")
    for peer, chars, msgs, total, t0, t1 in exporter.peer_stats(con, me)[: a.top]:
        import datetime
        span = (f"{datetime.datetime.fromtimestamp(t0):%Y-%m-%d}~"
                f"{datetime.datetime.fromtimestamp(t1):%Y-%m-%d}") if t0 else "-"
        print(f"{peer:<14}{chars:<10}{msgs:<8}{total:<10}{span:<26}{names.get(peer, '')}")
    return 0


def guess_me(con):
    row = con.execute(
        "select [40033], count(*) c from c2c_msg_table group by [40033] order by c desc limit 1"
    ).fetchone()
    return row[0] if row else 0


def cmd_export(a):
    con = decrypt.open_db(a.db)
    me = a.me or guess_me(con)
    st = exporter.export(con, a.peer, me, a.out_dir, a.with_media)
    print(f"{st['peer']} ({st['name']})  {st['span']}")
    print(f"库内 {st['total']} 条，导出 {st['exported']}，跳过 {st['skipped']}")
    print(f"她/他的纯文字: {st['her_msgs']} 条 / {st['her_chars']} 字（剔除模板 {st['dropped_templates']} 条）")
    for name, path in st["files"].items():
        print(f"  {name:<9} {path}  ({os.path.getsize(path)/1024:.1f} KB)")
    return 0


def cmd_run(a):
    if not os.path.exists(a.db) and not os.path.exists(PLAIN_DB):
        pass
    if cmd_key(argparse.Namespace(db=a.db)) != 0:
        return 1
    ns = argparse.Namespace(db=a.db, out=PLAIN_DB, force=True, no_wal=False)
    if cmd_decrypt(ns) != 0:
        return 1
    return cmd_export(argparse.Namespace(
        db=PLAIN_DB, peer=a.peer, me=a.me, out_dir=OUT, with_media=a.with_media))


def cmd_clean(a):
    for p in (PLAIN_DB, KEY_FILE):
        if os.path.exists(p):
            os.remove(p)
            print(f"已删除 {p}")
        else:
            print(f"不存在 {p}")
    for p in glob.glob(os.path.join(DATA, "*.db*")):
        os.remove(p)
        print(f"已删除 {p}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="QQ NT 聊天记录导出（本地离线）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_db(p):
        p.add_argument("--db", default=None, help="nt_msg.db 路径（默认自动找）")

    p = sub.add_parser("key", help="从 QQ 进程内存取密钥")
    add_db(p)
    p.set_defaults(func=cmd_key)

    p = sub.add_parser("decrypt", help="解密数据库")
    add_db(p)
    p.add_argument("--out", default=PLAIN_DB)
    p.add_argument("--force", action="store_true")
    p.add_argument("--no-wal", action="store_true", help="不叠加 -wal 里的最新帧")
    p.set_defaults(func=cmd_decrypt)

    p = sub.add_parser("peers", help="列出联系人及文字量")
    p.add_argument("--db", default=PLAIN_DB)
    p.add_argument("--top", type=int, default=15)
    p.set_defaults(func=cmd_peers)

    p = sub.add_parser("export", help="导出某个会话的语料")
    p.add_argument("--db", default=PLAIN_DB)
    p.add_argument("--peer", type=int, required=True)
    p.add_argument("--me", type=int, default=None)
    p.add_argument("--out-dir", default=OUT)
    p.add_argument("--with-media", action="store_true")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("run", help="key + decrypt + export")
    add_db(p)
    p.add_argument("--peer", type=int, required=True)
    p.add_argument("--me", type=int, default=None)
    p.add_argument("--with-media", action="store_true")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("clean", help="删除明文库与密钥")
    p.set_defaults(func=cmd_clean)

    a = ap.parse_args()
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
