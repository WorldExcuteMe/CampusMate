# T6 策划书的阶段执行与可验证文档

Status: accepted（本地），2026-11-15；基线232ac50；主代理；备份v9。沿用批准R5、AC11–13及T10的通用AST前置部分，不扩展任意宿主编程权限。

- 请求意图区分撰写策划书与一般询问。首个checkpoint保存显式kind=proposal、解析后的章节/长度约束和冻结的Plan/非空acceptance。复用PlanStep、stepProgress和当前Task，不建立第二队列或多Agent。
- 阶段为资料、提纲、逐章正文、检查、最多一次定向修订、交付；已完成阶段checkpoint保留。每阶段复用AgentLoop、统一budget/transport/reasoning、现有工具幂等/审批/取消/lease。正文不执行网络副作用；资料只开放只读工具。
- 来源必须来自真实web_fetch结果，保留URL/摘录/取得时间。模型生成的引用只允许关联已取得sourceId；提案/估算/待核实标明，不能把搜索摘要或模型自填URL当官方核验。引用结构检查不等于事实真伪的语义证明。
- shared/document.ts通用受限AST：heading、paragraph、list、table、image、chart、reference。验证边界/引用和安全资源；Markdown与React预览消费同一内容，禁止执行模型HTML。策划书仅为该引擎的一个消费者。
- 独立确定性检查章节、实际正文、明确长度、关联引用、工具错误及产物；“好的”/缺章/工具失败/截断不能succeeded。预算/截断保持paused供原任务恢复；完整生成但材料/验收不足以failed+partial结束并提示新消息，避免缺材料与会话顺序屏障互锁。
- ArtifactStore保存owner、documentId、不可变revision、AST和hash。API授权读取/列出/Markdown下载；工作台预览并真实下载。DOCX/PDF生产依赖和文件渲染在T10实现后验收，不先提供假按钮。

影响：新增core/document-plan/proposal与shared/document；CheckpointState增量documentRun JSON，无新表；Worker在现有执行/保存边界调度。API及web DTO/工作台接产物。源章节与正在执行的messages在CP保留，规范对话保留真实assistant/tool记录；不自动把内部阶段指令变成用户消息。

GWT：真实Worker接“写策划书”而模型答“好的”必须失败；有资料→提纲→章节→检查→MD artifact成功；用户长度/章节优先；虚构sourceId/工具错误/缺章失败且保留草稿；中途预算暂停后恢复不重做已完成章；一次修订仍不足不无限重试；owner可预览/下载同hash版本，其他owner404；普通聊天原有路径不受影响。

验证：先消费者红灯→定向→两侧类型→完整后端/迁移→完整前端/构建，串行。假上游不代表真实模型质量；真实高校来源和模型费用不在本地测试中冒充已验收。

## 实施结果与边界

- 真实Worker的“好的→succeeded”红灯已修复，普通聊天保持原路径。资料阶段只允许web_search/web_fetch/read_artifact；引用仅从实际原生或JSON回退工具观测提取。来源状态retrieved，没有冒充VERIFIED。
- CP保存冻结Plan/要求/章节/修订标志/当前阶段；预算和截断可恢复，输出截断会明确要求本阶段重发完整结构。PGlite重建app context/Worker后继续章节，完成章不重做，旧草稿和新版本均可读取。不是跨进程Postgres实测。
- 字数支持中文数字、区间及上下界，计算正文非空白字符；每个必需章节独立检查实质正文，结构/引用/主张分类/未解决工具失败/产物均有独立检查。最多一次完整修订，仍不满足failed+partial并提示新消息。
- API授权读取/列出/Markdown下载；AST内容哈希与下载字节哈希分别返回。React预览不执行模型HTML，来源和图片使用受限协议。Markdown支持真实下载及客户端字节哈希核对；DOCX/PDF入口等待T10。
- 后端完整253/253，最终相关8/8；前端完整124/124；两侧类型与构建通过。生产构建仍有既有chunk警告；迁移未变化，沿用T5七版本校验。
- 检查只验证可执行的结构契约，不宣称自动证明事实真伪、方案质量或跨模型写作水平。没有消费用户API余额或触及远程环境。真实模型和视觉/E2E继续在T8区分记录。
