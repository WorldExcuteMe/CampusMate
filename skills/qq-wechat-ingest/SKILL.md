---
name: qq-wechat-ingest
description: 从本地已登录 QQ/微信通知群摄取信息（信息本位：日期/关键词/文件，不限发送人），清洗去重后同步到 Inbox/日常任务/机会雷达。用于自动模式群通知同步。
---

# QQ/微信 群通知摄取（信息本位）

## 何时用
- 自动模式下用户要求"同步群通知/看看群里有什么通知"。
- 目标群：QQ「网安2401官方群」、微信「网安2401班」（可配置）。

## 核心原则
- **信息本位**：不关注发送人（班长/班委/任何人），只保留满足任一条件的消息：
  1. 含日期/时间（调课、班会、截止）；
  2. 含关键词（奖学金/竞赛/比赛/实习/科研/通知/报名/截止/调课/班会/讲座/活动/招募）；
  3. 含文件（PDF/DOCX/文件占位/文件类型码）。
- 仅本机、仅用户自有已登录账号与自有群；不外传；用完 `qq_cli.py clean` 删明文库与密钥。

## 流程（QQ，已实现）
1. `py -3 qq_cli.py key`（QQ 运行中，64 位 Python，读内存取原始密钥）。
2. `py -3 qq_cli.py decrypt`（解密 nt_msg.db + WAL → data/nt_msg.plain.db）。
3. `py -3 group_export.py --name 网安2401官方群`（群聊信息本位过滤 → out/last_group_info.json）。
4. Agent 调 `sync_group_notices` 工具 → `fetchGroupNotices` + `syncGroupRecords`：
   - 日常类（调课/班会…）→ `createTask(kind=daily)`；
   - 机会类（竞赛/实习/科研/奖学金…）→ `createInbox(pending_review)` + `createOpportunity`；
   - 其余通知 → `createInbox(pending_review)`；
   - `dedupKey` 去重；同步后 Dashboard/Inbox/日常/雷达自动更新。

## 微信（适配器已实现）
- `wechatkit/`：decrypt.py（SQLCipher page4096/reserve80/HMAC-SHA512/KDF256000）、scanner.py（Weixin.exe 内存指针解引用+页1HMAC 取钥，best-effort）、exporter.py（群信息本位导出，zstd 解压用 Py3.14 compression.zstd）。
- `wechat_cli.py key [--key <64hex>] / decrypt / group --name 网安2401班 / run / clean`。
- 服务端 `/api/ingest/wechat?name=`（dev/llm-proxy.mjs，64 位 Python）；会话页「同步群通知」覆盖 QQ+微信。
- 若内存扫描未命中（版本差异），用 `--key` 手动提供（经 chatlog 等工具获取）；或用户转发导入（粘贴/截图/文件）+ cleanGroupMessage 管线。

## 禁止
- 不绕登录/验证码/反爬；不读非自有群；不把明文聊天记录/密钥上传 GitHub 或外传。