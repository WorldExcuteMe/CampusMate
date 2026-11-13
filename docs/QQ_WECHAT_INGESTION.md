# QQ/微信 群通知摄取 · Workflow

版本 0.1 · 2026-11-13 · 信息本位（不关注发送人，只关注信息本身）

## 目标
把本地已登录 QQ/微信通知群中的有效通知（含日期/关键词/文件）自动摄取、清洗、去重，同步进 CampusMate 容器（Inbox / 日常任务 / 机会雷达 / Dashboard）。

## 通道与状态
| 通道 | 状态 | 说明 |
|---|---|---|
| QQ 官方本地解密（QQ工具） | ✅ 已实现 | key→decrypt→group_export→sync；仅本机自有账号 |
| 微信转发导入 | ✅ 已实现 | 粘贴/截图/文件 → cleanGroupMessage 管线 |
| 微信本地解密 | ✅ 适配器已实现 | wechatkit（SQLCipher SHA512）+ wechat_cli；key 内存扫描(best-effort)/--key；群导出信息本位 |

## 信息本位过滤（group_export.py / clean.ts）
保留满足任一：日期/时间正则；关键词（奖学金/竞赛/比赛/实习/科研/通知/报名/截止/调课/班会/讲座/活动/招募）；文件（.pdf/.docx/[文件]/类型码）。不区分发送人。

## 端到端流程
1. 摄取：QQ `qq_cli.py key && decrypt` → `group_export.py --name <群>` → `out/last_group_info.json`；或服务端 `/api/ingest/qq?name=<群>`（dev/llm-proxy.mjs 本地 spawn）。
2. 同步：`syncGroupRecords`（src/lib/ingest/qq.ts）→ 日常→tasks(kind=daily)；机会→inbox+opportunities；其余→inbox；dedupKey 去重。
3. 容器联动：Dashboard/Inbox/日常/雷达 读同一 Repository，自动刷新（TanStack Query invalidate）。
4. Agent 内置：`sync_group_notices` 工具（自动模式）+ 会话页「同步群通知」按钮；skill `skills/qq-wechat-ingest/SKILL.md`。

## 双预设
- 自动模式：全工具 + sync_group_notices 主动摄取。
- 日常模式：聚焦 extract/create_daily/sync，谨慎创建机会。

## 安全
仅本机自有账号/群；不绕登录/验证码/反爬；明文与密钥不上传；用完 `qq_cli.py clean`。

## 实验记录
- 目标群：QQ 网安2401官方群 / 微信 网安2401班。
- 见 project.md 变更日志（key/decrypt/group_export 实测结果）。