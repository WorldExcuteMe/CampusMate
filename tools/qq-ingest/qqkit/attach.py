"""附件（图片/PDF/DOCX）通知提取。

本地优先：图片读 Pic/<月>/Ori|Thumb，文件读本地真实文件或 File/Thumb 首页预览；
OCR 用 Windows 内置 WinRT（ocr.ps1，无第三方依赖）；DOCX 用标准库 zip 解包。
仅当图片本地缺失且任务确需其内容时，才用消息自带的真实下载链接（45816 主机 + 45804 路径）
下载后 OCR；该链接逐字来自消息数据，不做任何代理替换。
"""
import os
import re
import json
import glob
import subprocess
import zipfile
import datetime
import urllib.request

from qqkit import exporter

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OCR_PS1 = os.path.join(WS, "ocr.ps1")
CACHE_DIR = os.path.join(WS, "out", "attach_cache")
OCR_CACHE = os.path.join(CACHE_DIR, "ocr.json")
# 真实下载链接不可达（如 CDN 需鉴权返回 400）时熔断，本次运行不再重试下载。
_NET_OK = [True]


def find_qq_data():
    base = os.path.join(os.path.expanduser("~"), "Documents", "Tencent Files")
    if not os.path.isdir(base):
        return None
    for uin in sorted(os.listdir(base)):
        p = os.path.join(base, uin, "nt_qq", "nt_data")
        if os.path.isdir(p):
            return p
    return None


def _s(f, k):
    v = (f.get(k) or [b""])[0]
    if isinstance(v, bytes):
        return exporter.as_str(v)
    return "" if v is None else str(v)


def parse_attachment(f, ts):
    mt = (f.get(45002) or [0])[0]
    if mt == 2:
        host = _s(f, 45816)
        dl = _s(f, 45804) or _s(f, 45803) or _s(f, 45802)
        url = ("https://" + host + dl) if (host and dl.startswith("/")) else None
        return {"kind": "image", "name": _s(f, 45402), "url": url, "ts": ts}
    if mt == 3:
        md5b = (f.get(45406) or [b""])[0]
        return {"kind": "file", "name": _s(f, 45402),
                "md5": md5b.hex() if isinstance(md5b, bytes) else "", "ts": ts}
    return None


def _local_image(meta, data):
    if not data or not meta.get("name"):
        return None
    mon = datetime.datetime.fromtimestamp(meta["ts"]).strftime("%Y-%m")
    for sub in ("Ori", "Thumb"):
        p = os.path.join(data, "Pic", mon, sub, meta["name"])
        if os.path.exists(p):
            return p
    hits = (glob.glob(os.path.join(data, "Pic", "*", "Ori", meta["name"]))
            + glob.glob(os.path.join(data, "Pic", "*", "Thumb", meta["name"])))
    return hits[0] if hits else None


def _file_thumb(meta, data):
    if not data or not meta.get("md5"):
        return None
    p = os.path.join(data, "File", "Thumb", meta["md5"] + "_750.jpg")
    return p if os.path.exists(p) else None


def load_ocr_cache():
    try:
        return json.load(open(OCR_CACHE, encoding="utf-8"))
    except Exception:
        return {}


def save_ocr_cache(c):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(OCR_CACHE, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False)


def ocr(path, cache=None):
    key = os.path.basename(path)
    if cache is not None and key in cache:
        return cache[key]
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
             "-File", OCR_PS1, "-Path", os.path.abspath(path).replace("/", "\\")],
            capture_output=True, timeout=90)
        txt = r.stdout.decode("utf-8", "replace").strip()
    except Exception:
        txt = ""
    if cache is not None:
        cache[key] = txt
    return txt


def extract_docx(path):
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        return " ".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml)).strip()
    except Exception:
        return ""


def extract_pdf(path):
    try:
        from pypdf import PdfReader
        r = PdfReader(path)
        return "\n".join((p.extract_text() or "") for p in r.pages).strip()
    except Exception:
        return ""


def _download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def attachment_text(meta, data, cache=None, use_network=True, budget=None):
    """返回 (text, source)。budget=[剩余OCR/下载次数]，耗尽则不做 OCR/下载。"""
    def spend():
        if budget is None:
            return True
        if budget[0] <= 0:
            return False
        budget[0] -= 1
        return True

    if meta["kind"] == "image":
        p = _local_image(meta, data)
        src = "image-local"
        if not p and use_network and meta.get("url") and _NET_OK[0]:
            try:
                p = _download(meta["url"], os.path.join(CACHE_DIR, meta["name"]))
                src = "image-download"
            except Exception:
                _NET_OK[0] = False  # 真实链接不可达（CDN 需鉴权等），本次运行不再重试
                p = None
        if p:
            if not spend():
                return "", None
            return ocr(p, cache), src
        return "", None

    name = meta.get("name", "")
    ext = os.path.splitext(name)[1].lower()
    for root in (os.path.join(os.path.expanduser("~"), "Downloads"),
                 os.path.join(os.path.expanduser("~"), "Desktop"),
                 os.path.join(os.path.expanduser("~"), "Documents")):
        p = os.path.join(root, name)
        if os.path.exists(p):
            if ext == ".docx":
                return extract_docx(p), "docx-local"
            if ext == ".pdf":
                t = extract_pdf(p)
                if t:
                    return t, "pdf-local"
    th = _file_thumb(meta, data)
    if th:
        if not spend():
            return "", None
        return ocr(th, cache), "file-thumb"
    return "", None