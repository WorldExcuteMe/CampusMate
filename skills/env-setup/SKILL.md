---
name: env-setup
description: 面向零配置用户的 CampusMate 环境快速配置 workflow。检测 Python/QQ/微信/密钥/工作区，卡点以「grill me」问答提出，用户操作后重检，全部通过即开始抓取。
---

# 零配置环境 setup（grill me 问答式）

## 何时用
- 新用户首次使用自动模式抓取 QQ/微信群通知，机内无任何配置。
- 会话页「配置环境」按钮 / `/api/env/check`。

## 检测项（/api/env/check）
python64 / qqRunning / wechatRunning / qqKey / wechatKey / workspace。

## 问答流程（Agent 提问 → 用户操作/回答 → 重检）
1. 无 64 位 Python？→ 问：是否安装 64 位 Python（miniconda3）？给安装指引，装好重检。
2. QQ 未运行？→ 问：请打开并登录本地 QQ，完成后点「重新检测」。
3. 微信未运行？→ 问：请打开并登录本地微信，完成后重检。
4. 无 QQ key？→ 自动 `qq_cli.py key`（内存取钥）；失败问用户是否手动 --key。
5. 无微信 key？→ 自动 `wechat_cli.py key --auto`；失败问用户是否手动 --key。
6. 工作区？→ 让用户在输入栏左自定义本地路径（保存 localStorage + 服务端 QQ_TOOL_DIR）。

## 开始后
全部通过 → 「同步群通知」一键：QQ `group_export --uin/群号` + 微信 `wechat_cli run --auto` → 信息本位过滤 → 同步 Inbox/日常/雷达/Dashboard。

## 版本通用性
- QQ NT 9.x：页布局/密钥规格稳定，逻辑通用于较新 NT 版本；旧 8.x 不适用。
- 微信 4.x：SQLCipher SHA512/256000/reserve80；3.x 用 SHA1/64000/reserve48，decrypt 自动探测参数集。