"""QQ NT 聊天记录导出工具（本地、离线）。

流程：取 key（只读扫描 QQ.exe 内存）→ 解密 nt_msg.db → 导出语料。
"""
__all__ = ["aes_cng", "scanner", "decrypt", "exporter"]
