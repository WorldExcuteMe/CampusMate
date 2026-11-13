# CampusMate · 零配置环境 setup workflow（grill me）

版本 0.1 · 2026-11-13 · 面向未做过任何环境配置的用户（Demo/真实版通用）。

## 目标
用户机内无 Python/QQ/微信配置时，通过「检测→问答→重检」快速配好环境并开始抓取群通知。

## 入口
- 会话页输入栏左「工作区」自定义本地路径 + 「配置环境」按钮（SetupWizard）。
- 服务端 `GET /api/env/check`（dev/llm-proxy.mjs，本地进程/文件检查）。

## 检测项
python64 / qqRunning / wechatRunning / qqKey / wechatKey / workspace。

## grill me 问答流程
Agent 逐项检测，对每个卡点提出问题，用户操作/回答后点「我已操作，重新检测」：
1. 无 64 位 Python → 给安装指引（miniconda3 x64），装好重检。
2. QQ 未运行 → 「请打开并登录本地 QQ」→ 重检。
3. 微信未运行 → 「请打开并登录本地微信」→ 重检。
4. 无 QQ key → 自动 `qq_cli.py key`；失败问是否手动 --key。
5. 无微信 key → 自动 `wechat_cli.py key --auto`；失败问是否手动 --key。
6. 工作区 → 输入栏左自定义路径（localStorage + 服务端 QQ_TOOL_DIR）。

全部通过 → 「同步群通知」一键抓取（QQ group_export --uin/群号 + 微信 run --auto）→ 信息本位过滤 → 同步 Inbox/日常/雷达/Dashboard。

## 附件输入
输入框支持：附件按钮（回形针）、拖拽文件入聊天框、Ctrl+V 粘贴图片；PDF/DOCX 解析为文本（pdfjs/mammoth），图片以 dataURL 附件随消息发送。

## 版本通用性
- QQ NT 9.x：页布局（1024 伪头+4096 页）与密钥规格（x'<key><salt>'）稳定，逻辑通用于较新 NT 版本；旧 8.x 不适用。
- 微信：decrypt 自动探测参数集 wechat4(SHA512/256000/reserve80) 与 wechat3(SHA1/64000/reserve48)，跨 3.x/4.x 通用；key 内存位置为版本敏感点。