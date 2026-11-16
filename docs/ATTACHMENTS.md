# 聊天附件保护

附件先在当前浏览器解析；PDF/DOCX在独立Worker运行，发送时才把文本/图片交给当前模型。不会执行附件程序，不自动OCR，不将原始文档上传到文件服务器。

## 当前上限

| 项目 | 上限 |
| --- | --- |
| 格式 | PNG/JPEG/WebP/GIF/AVIF、PDF、DOCX、UTF-8 TXT/MD；不支持EXE、ZIP、HTML、SVG、旧DOC等 |
| 每条附件数量 | 8个，包含待解析/失败附件 |
| 原始文件大小 | 单个5MiB、每条合计10MiB |
| 图片 | 最多4张、原始内容合计4MiB；基本签名检查，不按扩展名盲目接收 |
| PDF | 50页；超限整份拒绝，不只取前50页 |
| 文档文字 | 单个100,000、合计200,000个UTF-16字符单位；不截断 |
| DOCX内部内容 | 最多512条ZIP记录、实际解压总量20MiB；不信任ZIP声明大小 |
| 解析任务 | 最多2个并行；每个文档Worker超过20秒会终止 |
| 发送体 | 前端预检7MiB编码JSON预算；后端保留8MiB硬上限 |

MiB=1024×1024字节，界面简写MB。图片上限为base64膨胀和API体积留出空间，不代表模型一定具备视觉能力。

选取/拖拽/粘贴时先检查元数据；混合选择中有不支持或超限文件会整批拒绝，不改已有草稿。解析过程中才发现的页数、文本或DOCX展开超限会保留可移除的错误附件，禁止发送不完整内容。原始File在本机草稿中保留，用户可移除后拆分/转换再添加。旧草稿、冲突恢复、发送前都会重新检查，不自动删除或覆盖旧内容。

PDF/DOCX不在UI线程解压/解析；PDF使用显式独立解析端口，成功/失败均清理资源，外层超时直接终止解析Worker。移除附件/删除会话/离开账号会取消对应排队与运行任务，不让废弃文件持续占用解析队列；未发送原文件仍按草稿规则留在本机。文档损坏、密码保护、扫描无文本会明确报错。限制不能替代模型上下文预算、文件杀毒或完整恶意文件沙箱。

## 回归入口

在web目录执行：

```text
npm test -- src/lib/__tests__/attachment-limits.test.ts src/lib/__tests__/attachment-documents.test.ts src/lib/__tests__/composer-drafts.test.ts src/features/agent/AgentChatPage.test.tsx
npm run test:e2e -- attachment-budget.spec.ts attachment-limit.spec.ts
npm run build
```

浏览器测试使用隔离Demo夹具、真实小型PDF/DOCX、脚本模型响应，不读取个人文件，不调用收费模型。单测中的PDF模拟用于精确验证边界/清理，不能替代真实浏览器Worker回归。
