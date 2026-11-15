"""自动取微信 key：优先本地 chatlog.exe，缺失时从真实 GitHub release 下载。

仅用真实 GitHub 链接（api.github.com / release 资产），不替换代理地址。
chatlog 为开源微信数据工具；此处仅用其 `key` 子命令读取本机已登录微信的库密钥。
"""
import os
import re
import subprocess
import urllib.request
import zipfile
import io

from . import decrypt

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(WS, "bin")
CHATLOG = os.path.join(BIN, "chatlog.exe")
API_LATEST = "https://api.github.com/repos/sjzar/chatlog/releases/latest"


def _download_chatlog(log=print):
    os.makedirs(BIN, exist_ok=True)
    log("  本地无 chatlog，从 GitHub release 下载…")
    req = urllib.request.Request(API_LATEST, headers={"User-Agent": "campusmate"})
    import json
    rel = json.load(urllib.request.urlopen(req, timeout=30))
    asset = next((a for a in rel.get("assets", [])
                  if "windows" in a["name"].lower() and "amd64" in a["name"].lower()
                  and a["name"].lower().endswith(".zip")), None)
    if not asset:
        raise RuntimeError("未找到 windows amd64 release 资产")
    url = asset["browser_download_url"]  # 真实 GitHub 资产链接
    log(f"  下载 {url}")
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "campusmate"}), timeout=120).read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        exe = next((n for n in z.namelist() if n.lower().endswith("chatlog.exe")), None)
        if not exe:
            raise RuntimeError("zip 内无 chatlog.exe")
        with open(CHATLOG, "wb") as f:
            f.write(z.read(exe))
    return CHATLOG


def get_key(db_path, log=print):
    exe = CHATLOG if os.path.exists(CHATLOG) else None
    if not exe:
        try:
            exe = _download_chatlog(log)
        except Exception as e:
            log(f"  chatlog 下载失败: {e}")
            return None
    try:
        out = subprocess.run([exe, "key"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=60).stdout
    except Exception as e:
        log(f"  chatlog key 运行失败: {e}")
        return None
    for m in re.finditer(r"\b[0-9a-fA-F]{64}\b", out):
        k = m.group(0).lower()
        if decrypt.verify(db_path, k):
            log("  chatlog 取钥成功并验证")
            return k
    log("  chatlog 输出中无可用 key")
    return None