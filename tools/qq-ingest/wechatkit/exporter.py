"""WeChat 4.x 群消息「信息本位」导出（不关注发送人，只关注信息本身）。

保留满足任一：日期/时间；关键词（奖学金/竞赛/实习/科研/通知/报名/截止/调课/班会/讲座/活动）；文件（PDF/DOCX/文件）。
message_content 若被 WCDB zstd 压缩（WCDB_CT_message_content=1/4），用 Python3.14 compression.zstd 解压。
"""
import hashlib
import json
import os
import re
from datetime import datetime

KEYWORDS = ["奖学金", "竞赛", "比赛", "大赛", "实习", "科研", "通知", "报名", "截止",
            "调课", "班会", "讲座", "活动", "招募", "招聘", "助学金", "评选", "开会", "集合"]
DATE_RE = re.compile(r"(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}月\d{1,2}[日号])|(周[一二三四五六日天])|(星期[一二三四五六日天])|(今天|明天|后天)|(\d{1,2}[:：点]\d{2})")
FILE_RE = re.compile(r"(\.pdf|\.docx?|\.pptx?|\.xlsx?|\[文件\]|文件)", re.I)


def info_score(text, local_type):
    reasons = []
    if DATE_RE.search(text):
        reasons.append("date")
    if any(k in text for k in KEYWORDS):
        reasons.append("keyword")
    if FILE_RE.search(text) or local_type == 49:
        reasons.append("file")
    return reasons


def maybe_decompress(content, ct_flag):
    if isinstance(content, bytes) and ct_flag in (1, 4):
        try:
            import compression.zstd as zstd
            return zstd.decompress(content).decode("utf-8", "replace")
        except Exception:
            try:
                return content.decode("utf-8", "replace")
            except Exception:
                return ""
    if isinstance(content, bytes):
        return content.decode("utf-8", "replace")
    return content or ""


def find_group_username(contact_con, name):
    cols = [c[1] for c in contact_con.execute("pragma table_info(contact)")]
    if not cols:
        return None
    for row in contact_con.execute("select username, nick_name, remark from contact"):
        username, nick, remark = row[0], row[1] or "", row[2] or ""
        if username and username.endswith("@chatroom") and (name in nick or name in remark):
            return username
    return None


def _table_for(con, username):
    md5 = hashlib.md5(username.encode()).hexdigest()
    want = f"Msg_{md5}"
    names = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
    return want if want in names else None


def export_group(msg_con, username, out_dir, group_name):
    table = _table_for(msg_con, username)
    if not table:
        return None
    cols = [c[1] for c in msg_con.execute(f'pragma table_info("{table}")')]
    has = lambda n: n in cols
    recs = []
    q = f'select create_time, local_type, message_content' + (", WCDB_CT_message_content" if has("WCDB_CT_message_content") else "") + f' from "{table}" order by create_time'
    for row in msg_con.execute(q):
        ts, ltype, content = row[0], row[1], row[2]
        ct_flag = row[3] if len(row) > 3 else 0
        text = maybe_decompress(content, ct_flag)
        text = re.sub(r"[\r\n\t]+", " ", text).strip()
        if ltype == 49:
            m = re.search(r"<title>(.*?)</title>", text, re.S)
            if m:
                text = m.group(1).strip()
        reasons = info_score(text, ltype)
        if not reasons or not text:
            continue
        recs.append({
            "time": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
            "type": ltype, "text": text, "display": text, "reasons": reasons,
        })
    os.makedirs(out_dir, exist_ok=True)
    payload = {"group": group_name, "username": username, "count": len(recs), "records": recs}
    with open(os.path.join(out_dir, "last_wechat_group_info.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload