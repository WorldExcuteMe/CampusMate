"""群聊「信息本位」导出：不关注发送人，只关注信息本身。

保留满足任一条件的群消息：
  1) 含日期/时间（调课、班会、截止等）；
  2) 含关键词（奖学金/竞赛/比赛/实习/科研/通知/报名/截止/调课/班会/讲座/活动/招募）；
  3) 含文件（PDF/DOCX/文件 占位或文件类型码）。

用法:
  py -3 group_export.py --name 网安2401半官方群 [--db data/nt_msg.plain.db] [--out out]
先运行 qq_cli.py key + decrypt 生成明文库。输出 out/group_<uin>_info.json。
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qqkit import decrypt, exporter, attach

# Windows 控制台默认 GBK，群样例含 emoji 会崩溃；统一 UTF-8 输出，普适各主机。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

WS = os.path.dirname(os.path.abspath(__file__))
PLAIN = os.path.join(WS, "data", "nt_msg.plain.db")

KEYWORDS = ["奖学金", "竞赛", "比赛", "大赛", "实习", "科研", "通知", "报名", "截止",
            "调课", "班会", "讲座", "活动", "招募", "招聘", "助学金", "评选", "开会", "集合"]
DATE_RE = re.compile(r"(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}月\d{1,2}[日号])|(周[一二三四五六日天])|(星期[一二三四五六日天])|(今天|明天|后天)|(\d{1,2}[:：点]\d{2})")
FILE_RE = re.compile(r"(\.pdf|\.docx?|\.pptx?|\.xlsx?|\[文件\]|文件)", re.I)
FILE_TYPES = {3}


def info_score(text, mtype):
    reasons = []
    if DATE_RE.search(text):
        reasons.append("date")
    if any(k in text for k in KEYWORDS):
        reasons.append("keyword")
    if FILE_RE.search(text) or mtype in FILE_TYPES:
        reasons.append("file")
    return reasons


def list_groups(con, names, limit=3, scan=80):
    """普适群发现：枚举本机所有群，按信息密度排序，供 agent 自动定位通知群。

    性能：单次顺序全表扫描，同时累计各群总数与有限解码样例（每群最多 scan 条），
    避免对百万行无索引表做 N 次查询/排序。群名缺失时靠样例内容识别群身份，普适各主机。
    """
    stats = {}
    for uin, ts, blob in con.execute("select [40030],[40050],[40800] from group_msg_table"):
        if not uin:
            continue
        s = stats.get(uin)
        if s is None:
            s = stats[uin] = {"total": 0, "scanned": 0, "info_hits": 0, "samples": []}
        s["total"] += 1
        if s["scanned"] >= scan or not blob:
            continue
        m = exporter.message_of(bytes(blob))
        if not m:
            continue
        mtype, txt = m
        display = exporter.clean(txt) or exporter.LABELS.get(mtype, "")
        s["scanned"] += 1
        if info_score(display, mtype):
            s["info_hits"] += 1
            if len(s["samples"]) < limit:
                s["samples"].append({
                    "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
                    "text": display[:120],
                })
    groups = []
    for uin, s in stats.items():
        groups.append({
            "uin": uin,
            "name": names.get(uin, ""),
            "total": s["total"],
            "scanned": s["scanned"],
            "info_hits": s["info_hits"],
            "info_ratio": round(s["info_hits"] / s["scanned"], 3) if s["scanned"] else 0,
            "samples": s["samples"],
        })
    groups.sort(key=lambda g: (-g["info_ratio"], -g["info_hits"]))
    payload = {"count": len(groups), "groups": groups}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default=None, help="群名称（模糊匹配）")
    ap.add_argument("--uin", type=int, default=None, help="群 uin（直接指定，优先于 --name）")
    ap.add_argument("--db", default=PLAIN)
    ap.add_argument("--out", default=os.path.join(WS, "out"))
    ap.add_argument("--list", action="store_true", help="列出本机所有群（uin/名称/消息数/信息密度/样例），普适定位通知群")
    ap.add_argument("--limit", type=int, default=3, help="--list 时每群样例条数")
    ap.add_argument("--no-attach", action="store_true", help="不提取图片/PDF/DOCX 附件内容")
    ap.add_argument("--max-ocr", type=int, default=12, help="单次运行 OCR/下载 次数上限（限流）")
    ap.add_argument("--no-network", action="store_true", help="附件仅用本地文件，不下载（默认本地缺失且确需时用消息真实链接）")
    a = ap.parse_args()

    if not os.path.exists(a.db):
        # 普适：缺明文库时自动 best-effort 取钥+解密（QQ NT 需已登录），失败给可操作提示
        import subprocess
        cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qq_cli.py")
        for args in (["key"], ["decrypt", "--no-wal"]):
            try:
                subprocess.run([sys.executable, cli, *args], cwd=os.path.dirname(cli), timeout=120, capture_output=True)
            except Exception:
                pass
        if not os.path.exists(a.db):
            print("明文库不存在且自动解密失败：请确认 QQ(NT版) 已登录；或手动 qq_cli.py key && qq_cli.py decrypt --no-wal")
            return 1
    con = decrypt.open_db(a.db)
    names = exporter.name_map(con)

    if a.list:
        return list_groups(con, names, a.limit)

    group_uin = a.uin
    if group_uin is None and a.name and a.name.isdigit() and len(a.name) >= 6:
        group_uin = int(a.name)  # 群号辅助：≥6位纯数字视为群 uin
    if group_uin is None and a.name:
        # 群号辅助：groups.json  name→uin（支持子串匹配）
        gj = os.path.join(WS, "groups.json")
        if os.path.exists(gj):
            da = "".join(re.findall(r"\d+", a.name))
            for g in json.load(open(gj, encoding="utf-8")).get("groups", []):
                gn = g.get("name", "")
                dg = "".join(re.findall(r"\d+", gn))
                if g.get("platform") == "qq" and g.get("uin") and (
                    gn == a.name or a.name in gn or gn in a.name or (da and da == dg)
                ):
                    group_uin = int(g["uin"])
                    break
    if group_uin is None and a.name:
        for uin, nick in names.items():
            if a.name in (nick or ""):
                group_uin = uin
                break
    if group_uin is None:
        print(f"未找到群「{a.name}」。QQ NT 库无群名表，请用 --uin <群号> 或在 groups.json 填 uin。")
        return 1

    rows = con.execute(
        "select [40033],[40050],[40800] from group_msg_table where [40030]=? order by [40050] desc",
        (group_uin,),
    ).fetchall()

    recs = []
    data = attach.find_qq_data() if not a.no_attach else None
    ocr_cache = attach.load_ocr_cache() if not a.no_attach else {}
    budget = [a.max_ocr]
    for sender, ts, blob in rows:
        if not blob:
            continue
        f = exporter.body_fields(bytes(blob))
        mtype = (f.get(45002) or [0])[0]
        if not a.no_attach and mtype in (2, 3):
            meta = attach.parse_attachment(f, ts)
            if meta:
                text, src = attach.attachment_text(
                    meta, data, ocr_cache, use_network=not a.no_network, budget=budget)
                base_name = os.path.splitext(meta["name"])[0]
                display = exporter.clean((base_name + " " + text).strip())
                reasons = info_score(display, mtype)
                if mtype == 3:
                    reasons = reasons or ["file"]  # 文件通知：文件名即标题，收纳
                if not reasons:
                    continue
                recs.append({
                    "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
                    "sender": names.get(sender, str(sender)),
                    "type": mtype,
                    "text": display,
                    "display": display,
                    "reasons": reasons,
                    "attachment": {"kind": meta["kind"], "name": meta["name"], "source": src},
                })
                continue
        m = exporter.message_of(bytes(blob))
        if not m:
            continue
        mtype, txt = m
        txt = exporter.clean(txt)
        label = exporter.LABELS.get(mtype, "")
        display = txt or label
        reasons = info_score(display, mtype)
        if not reasons:
            continue  # 信息本位：无日期/关键词/文件 → 丢弃
        recs.append({
            "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
            "sender": names.get(sender, str(sender)),
            "type": mtype,
            "text": txt,
            "display": display,
            "reasons": reasons,
        })
    if not a.no_attach:
        attach.save_ocr_cache(ocr_cache)

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"group_{group_uin}_info.json")
    payload = {"group": a.name or names.get(group_uin, "") or str(group_uin), "uin": group_uin, "count": len(recs), "records": recs}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    with open(os.path.join(a.out, "last_group_info.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"群「{a.name}」总 {len(rows)} 条，信息本位保留 {len(recs)} 条 → {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())