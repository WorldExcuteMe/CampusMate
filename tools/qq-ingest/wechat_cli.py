"""WeChat 4.x 群通知导出 CLI（本地离线）。

用法:
  py -3 wechat_cli.py key [--key <64hex>]      # 内存取钥或手动提供，存 data/wechat_key.txt
  py -3 wechat_cli.py decrypt                  # 解密 message_0.db + contact.db
  py -3 wechat_cli.py group --name 网安2401班   # 信息本位导出群通知
  py -3 wechat_cli.py run --name 网安2401班     # 一条龙
  py -3 wechat_cli.py clean                    # 删明文库与密钥
需 64 位 Python（建议 C:\\Users\\Asus\\miniconda3\\python.exe），微信已登录。
"""
import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wechatkit import decrypt, scanner, exporter

WS = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(WS, "data")
OUT = os.path.join(WS, "out")
KEY_FILE = os.path.join(DATA, "wechat_key.txt")


def storage_dir():
    cands = glob.glob(os.path.expanduser(r"~\Documents\xwechat_files\*\db_storage"))
    if not cands:
        raise SystemExit("没找到 xwechat_files/*/db_storage")
    return max(cands, key=os.path.getsize)


def msg_db():
    return os.path.join(storage_dir(), "message", "message_0.db")


def contact_db():
    return os.path.join(storage_dir(), "contact", "contact.db")


def load_key():
    if os.path.exists(KEY_FILE):
        k = open(KEY_FILE).read().strip()
        if len(k) == 64:
            return k
    return None


def cmd_key(a):
    import struct
    if struct.calcsize("P") != 8:
        print("需 64 位 Python，例如 C:\\Users\\Asus\\miniconda3\\python.exe")
        return 2
    if a.key:
        k = a.key.strip()
    else:
        k = load_key()
        if k and decrypt.verify(msg_db(), k):
            print(f"已有可用 key: {k[:16]}…")
            return 0
        k = scanner.find_key(msg_db(), log=print)
        if not k and getattr(a, "auto", False):
            from wechatkit import chatlog_key
            k = chatlog_key.get_key(msg_db(), log=print)
    if not k:
        print("未取到 key。用 --auto 自动经 chatlog 获取，或 --key 手动提供。")
        return 1
    if not decrypt.verify(msg_db(), k):
        print("key 校验失败（不对应 message_0.db）")
        return 1
    os.makedirs(DATA, exist_ok=True)
    open(KEY_FILE, "w").write(k)
    print(f"key 已验证保存: {k[:16]}…")
    return 0


def cmd_decrypt(a):
    k = load_key() or (cmd_key(argparse.Namespace(key=None)) or None)
    if not k:
        return 1
    os.makedirs(DATA, exist_ok=True)
    for src, dst in [(msg_db(), os.path.join(DATA, "wechat_message_0.plain.db")),
                     (contact_db(), os.path.join(DATA, "wechat_contact.plain.db"))]:
        if os.path.exists(src):
            n = decrypt.decrypt_db(src, dst, k, log=print)
            print(f"解密 {os.path.basename(src)} {n} 页")
    return 0


def cmd_group(a):
    mp = os.path.join(DATA, "wechat_message_0.plain.db")
    cp = os.path.join(DATA, "wechat_contact.plain.db")
    if not os.path.exists(mp):
        print("先运行 decrypt")
        return 1
    mcon = decrypt.open_db(mp)
    username = a.username
    if not username and os.path.exists(cp):
        ccon = decrypt.open_db(cp)
        username = exporter.find_group_username(ccon, a.name)
    if not username:
        print(f"未找到群「{a.name}」，用 --username <id>@chatroom 指定")
        return 1
    payload = exporter.export_group(mcon, username, OUT, a.name)
    if payload is None:
        print(f"消息库中无表 Msg_md5({username})")
        return 1
    print(f"群「{a.name}」信息本位保留 {payload['count']} 条 → out/last_wechat_group_info.json")
    return 0


def cmd_clean(a):
    for p in glob.glob(os.path.join(DATA, "wechat_*")) + [KEY_FILE]:
        if os.path.exists(p):
            os.remove(p)
            print("已删除", p)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("key"); p.add_argument("--key"); p.add_argument("--auto", action="store_true"); p.set_defaults(func=cmd_key)
    p = sub.add_parser("decrypt"); p.set_defaults(func=cmd_decrypt)
    p = sub.add_parser("group"); p.add_argument("--name", default="网安2401班"); p.add_argument("--username"); p.set_defaults(func=cmd_group)
    p = sub.add_parser("run"); p.add_argument("--name", default="网安2401班"); p.add_argument("--username"); p.add_argument("--auto", action="store_true"); p.set_defaults(func=lambda a: cmd_key(argparse.Namespace(key=None, auto=a.auto)) or cmd_decrypt(a) or cmd_group(a))
    p = sub.add_parser("clean"); p.set_defaults(func=cmd_clean)
    a = ap.parse_args()
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())