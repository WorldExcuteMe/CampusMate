"""Turn QQ NT c2c rows into plain-text corpus files.

c2c_msg_table: [40030] peer uin, [40033] sender uin, [40050] unix ts,
               [40800] wrapper -> 40800 -> body {45001 id, 45002 type, 45101 text}
"""
import json
import os
import re
from datetime import datetime

TEXT = 1
LABELS = {
    2: "[图片]", 4: "[语音]", 5: "[视频]", 6: "[表情]",
    7: "[引用消息]", 8: "[名片]", 10: "[小程序]", 11: "[表情]",
    16: "[卡片消息]", 21: "[通话]",
}
TEMPLATE_RE = re.compile(r"^(\[自动回复\]|\[表情弹射\]|推荐联系人)")


def parse_proto(b):
    i, out, n = 0, {}, len(b)
    while i < n:
        k = s = 0
        while i < n:
            c = b[i]
            i += 1
            k |= (c & 0x7F) << s
            s += 7
            if not c & 0x80:
                break
        if not k:
            break
        fn, wt = k >> 3, k & 7
        if wt == 0:
            v = s = 0
            while i < n:
                c = b[i]
                i += 1
                v |= (c & 0x7F) << s
                s += 7
                if not c & 0x80:
                    break
            out.setdefault(fn, []).append(v)
        elif wt == 2:
            ln = s = 0
            while i < n:
                c = b[i]
                i += 1
                ln |= (c & 0x7F) << s
                s += 7
                if not c & 0x80:
                    break
            out.setdefault(fn, []).append(b[i : i + ln])
            i += ln
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            break
    return out


def as_str(v):
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            return ""
    return str(v)


def body_fields(blob):
    outer = parse_proto(blob)
    body = outer.get(40800, [b""])[0]
    if not isinstance(body, bytes) or not body:
        return {}
    return parse_proto(body)


def message_of(blob):
    outer = parse_proto(blob)
    body = outer.get(40800, [b""])[0]
    if not isinstance(body, bytes) or not body:
        return None
    f = parse_proto(body)
    mtype = (f.get(45002) or [0])[0]
    if mtype == TEXT:
        txt = as_str((f.get(45101) or [b""])[0])
    elif mtype == 10:
        try:
            txt = json.loads(as_str((f.get(47901) or [b""])[0])).get("prompt", "")
        except Exception:
            txt = ""
    elif mtype == 8:
        nick = as_str((f.get(47705) or [b""])[0])
        card = as_str((f.get(47706) or [b""])[0])
        txt = f"推荐联系人: {nick}" + (f"({card})" if card else "")
    else:
        txt = ""
    return mtype, txt


def clean(t):
    return re.sub(r"[\r\n\t]+", " ", t).strip()


def is_template(t):
    return bool(TEMPLATE_RE.match(t))


def name_map(con):
    names = {}
    for uin, nick, remark in con.execute(
        "select [40030],[40093],[40095] from recent_contact_v3_table"
    ):
        if uin:
            names.setdefault(uin, (nick or "").strip() or (remark or "").strip() or str(uin))
    return names


def peer_stats(con, me):
    """[(peer_uin, her_text_chars, her_text_msgs, total_msgs, first_ts, last_ts)]"""
    from collections import defaultdict
    stat = defaultdict(lambda: [0, 0, 0, None, None])
    for sender, peer, ts, blob in con.execute(
        "select [40033],[40030],[40050],[40800] from c2c_msg_table"
    ):
        s = stat[peer]
        s[2] += 1
        s[3] = ts if s[3] is None else min(s[3], ts)
        s[4] = ts if s[4] is None else max(s[4], ts)
        if not blob or sender != peer:
            continue
        m = message_of(bytes(blob))
        if not m:
            continue
        txt = clean(m[1])
        if txt and not is_template(txt):
            s[0] += len(txt)
            s[1] += 1
    rows = [(p, v[0], v[1], v[2], v[3], v[4]) for p, v in stat.items()]
    return sorted(rows, key=lambda r: -r[1])


def export(con, peer, me, out_dir, with_media=False):
    names = name_map(con)
    peer_name = names.get(peer, str(peer))
    me_name = names.get(me, str(me))
    rows = con.execute(
        "select [40033],[40050],[40800] from c2c_msg_table where [40030]=? order by [40050],[40001]",
        (peer,),
    ).fetchall()

    recs, skipped = [], 0
    for sender, ts, blob in rows:
        m = message_of(bytes(blob)) if blob else None
        if not m:
            skipped += 1
            continue
        mtype, txt = m
        txt = clean(txt)
        label = LABELS.get(mtype, "[消息]") if not txt else ""
        if not txt and not label:
            skipped += 1
            continue
        recs.append({
            "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
            "from": "her" if sender == peer else "me",
            "name": peer_name if sender == peer else me_name,
            "type": mtype,
            "text": txt,
            "display": txt or label,
        })

    her = [r for r in recs if r["from"] == "her" and r["text"]]
    dropped = [r for r in her if is_template(r["text"])]
    her = [r for r in her if not is_template(r["text"])]

    os.makedirs(out_dir, exist_ok=True)
    tag = str(peer)
    files = {
        "clean": os.path.join(out_dir, f"{tag}_her_only.txt"),
        "stamped": os.path.join(out_dir, f"{tag}_her_only_timestamped.txt"),
        "dialogue": os.path.join(out_dir, f"{tag}_dialogue.txt"),
    }
    with open(files["clean"], "w", encoding="utf-8", newline="\n") as f:
        for r in her:
            f.write(r["text"] + "\n")
    with open(files["stamped"], "w", encoding="utf-8", newline="\n") as f:
        for r in her:
            f.write(f"[{r['time']}] {r['text']}\n")
    with open(files["dialogue"], "w", encoding="utf-8", newline="\n") as f:
        for r in recs:
            f.write(f"[{r['time']}] {r['name']}: {r['display']}\n")

    return {
        "peer": peer,
        "name": peer_name,
        "total": len(rows),
        "exported": len(recs),
        "skipped": skipped,
        "her_msgs": len(her),
        "her_chars": sum(len(r["text"]) for r in her),
        "dropped_templates": len(dropped),
        "span": f"{recs[0]['time'][:10]} ~ {recs[-1]['time'][:10]}" if recs else "empty",
        "files": files,
    }
