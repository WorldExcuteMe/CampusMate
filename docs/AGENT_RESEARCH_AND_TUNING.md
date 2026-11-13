# CampusMate · Agent 调优与工程调研方案

版本 0.1 · 2026-11-12 · 对应需求 Q4/Q6/Q7/Q8/Q10
实测依据：DeepSeek API 真实调用（deepseek-flash，JSON Mode 成功）+ 官方文档检索。

---

## 0. 结论先行（CampusMate 默认配置）

| 维度 | 默认方案 | 理由 |
|---|---|---|
| 模型路由 | 提取/分类/日常解析 → `deepseek-v4-flash`；规划/核验/复杂推理 → `deepseek-v4-pro` | flash 便宜快（$0.14/$0.28 /M），pro 推理强；按任务分级 |
| 温度 | 提取/分类 0；对话 0.3；规划 0.2 | 精确任务低温，减少幻觉 |
| 上下文窗口 | 模型 1M，但**工作集默认 16K token**，硬上限 64K | 窗口是上限不是推荐值；长上下文慢且贵 |
| 上下文管理 | 稳定 system 前缀（命中 prompt cache）+ 滑动窗口 + 摘要压缩 + 检索注入 | 借鉴 Claude Code/Manus 上下文工程 |
| 输出 | JSON Mode + Zod 校验 + 失败回退规则提取 + 有限重试 | 实测 flash 会输出中文类别/幻觉标题，必须校验 |
| 工具调用 | ReAct 循环 ≤4 轮，schema 化参数，执行器落业务层 | Agent 不绕业务层改库 |
| 记忆 | 三层：工作记忆(会话)/情节记忆(agent_runs+activity)/语义记忆(画像+成长档案) | 用户确认后才进语义记忆 |
| Embedding | 机会/通知向量化（BGE-m3 或 text-embedding）+ 余弦匹配 | 画像精准推送 |
| 密钥 | 仅服务端（.env.local / Supabase Secret），前端零密钥 | 已实现 |

---

## 1. Q4 · Agent 调优策略（参考成熟 Agent）

### 1.1 关于 token / 分词器 / BPE 的正确边界
- **BPE/分词器是模型内部组件，应用层不训练也不替换**。我们做的是**token 计量与预算**：用供应商 tokenizer（DeepSeek 提供 token 计数/usage 返回）做预算控制，而非自研 BPE。
- 每次调用记录 `usage.prompt_tokens/completion_tokens/cached_tokens`（已实现于 agent_runs.token_usage），用于成本与容量治理。
- 中文 token 密度高（约 1 字≈1~2 token），预算按字符×1.5 估算兜底。

### 1.2 上下文窗口与最优默认容量
- DeepSeek V4 系列上下文 **1M**、最大输出 384K（flash/pro 同），但官方与社区一致强调「窗口大≠都应吃进」，常规保持几十 KB。
- **CampusMate 默认工作集 16K token**（system≈1K + 画像≈0.5K + 近 6 轮对话≈4K + 检索注入≈6K + 工具结果≈4K），硬上限 64K；超出触发压缩。
- 管理四件套（借鉴 Claude Code compaction、Manus KV-cache 友好设计）：
  1. **稳定前缀**：system+画像+工具定义放最前且不变 → 命中 prompt cache（flash 缓存命中 $0.028/M，降本一个量级）。
  2. **滑动窗口**：保留近 N 轮，旧轮摘要化。
  3. **摘要压缩**：超阈值时用 flash 生成「会话摘要」替换旧轮。
  4. **检索注入**：长文档/历史通知不整篇塞入，用 embedding 检索 top-k 片段注入。

### 1.3 工具调用（Function Calling）
- 采用 OpenAI 兼容 tools schema（已实现 AGENT_TOOLS）。ReAct 循环 ≤4 轮，防死循环。
- 参数 JSON 解析失败→空对象兜底；工具执行器统一落 Repository（业务层），Agent 不直接改库。
- 实测注意：flash 早期公测曾限制工具调用，当前 API 支持 Function Calling；若供应商不支持 tools，降级为「JSON 指令模式」（模型输出 {tool,args}，本地解析执行）。

### 1.4 默认 Skills / Prompt / 插件
- 默认 skills：notice-extract、daily-parse、opportunity-match、trust-verify、action-plan、search（与 AGENT_TOOLS 一一对应）。
- 默认 system prompt：角色+画像+硬规则（给来源/不编造/未核验≠诈骗/群消息先清洗/日常用 create_daily_task）。已实现于 chat.ts。
- 默认插件：LLM Provider Adapter（mock/proxy/edge）、搜索适配器、OCR、QQ/WX 导入适配器。

### 1.5 Embedding 与记忆留存
- Embedding：机会/通知入库时向量化（BGE-m3 中文友好或供应商 text-embedding），存 pgvector（Supabase 支持）；匹配=硬过滤+向量余弦+权重评分。
- 记忆三层：工作记忆（当前会话上下文）→ 情节记忆（agent_runs/activity_events，可审计）→ 语义记忆（画像/成长档案，**用户确认后才写入**）。
- 留存策略：情节记忆保留 90 天可配置；语义记忆长期；提供导出/删除（隐私）。

### 1.6 参考的成熟 Agent 与借鉴点
| 系统 | 借鉴 |
|---|---|
| Claude Code | 上下文 compaction、稳定前缀缓存、工具最小权限 |
| Manus | 上下文工程、KV-cache 友好、文件系统作外部记忆 |
| OpenAI Agents SDK | handoffs/guardrails、结构化输出校验 |
| LangGraph | 状态机编排、可恢复执行 |
| Cursor/Cline | 仓库/上下文检索注入、diff 最小化 |

---

## 2. Q6/Q7 · QQ/微信通知获取 + 日常任务专区

### 2.1 成熟且稳定的合规方案（分通道）
**原则**：只读取用户自有/被授权的群，不绕登录/验证码/反爬；优先官方通道，第三方协议（NapCat/Lagrange/wechaty 个人号 hook）有封号与合规风险，**不作主通道**。

| 通道 | 稳定性 | 合规 | 实现 |
|---|---|---|---|
| **QQ 官方机器人**（主自动通道） | 高 | 官方 | 群主把机器人拉入通知群并设「获取群内全部消息」→ webhook 收 GROUP_MESSAGE_CREATE → 导入管线 |
| **企业微信群机器人/会话存档** | 高 | 官方 | 若通知群为企业微信群，用 WeCom webhook/会话存档 API |
| **用户转发导入**（微信个人群主通道） | 最高 | 用户授权 | 粘贴/截图/文件 → 清洗 → 提取（已实现） |
| **截图 OCR** | 高 | 用户授权 | 群截图 → Vision LLM/OCR → 文本 → 管线 |

QQ 官方机器人事实（2026）：进群能力全面开放，普通群可用；群主授权「接收全量消息」后机器人可收群内所有成员发言；支持主动推送；个人主体可建 5 个机器人；需 AppID/Token/AppSecret + webhook。来源见文末。

### 2.2 导入清洗管线（已实现 src/lib/ingest/clean.ts）
去噪（时间戳/发送者/@/表情/引用）→ 归一 → **去重**（dedupKey 哈希）→ **日常时间提取**（今天/明天/周X/具体日期+时刻）→ 分类（日常 vs 机会）→ 落库。
- 日常任务专区（/app/daily）：调课/班会/讲座等含日期时间信息 → kind="daily" 任务，突出时间。
- 机会类 → Inbox 闭环。

### 2.3 适配器接口（待接官方凭证）
`IngestChannel { id, type: qq-bot|wecom|manual|ocr, receive(msg)→clean→pipeline }`。manual/ocr 已可用；qq-bot/wecom 适配器预留，配置 AppID/Secret（服务端）+ 群主授权后即启用。

---

## 3. Q8 · 搜索工具 + 广泛来源 + 画像精准推送

### 3.1 LLM 调用搜索工具
`search_opportunities(query, category)` 已注册为工具。执行器接**搜索适配器**：
- 实时全网：接搜索 API（Bing/Google/SerpAPI/博查），服务端调用，返回标题+URL+摘要；LLM 再筛选+核验。
- 官方白名单优先：高校就业网/教务/竞赛官网 RSS + Fetch/Cheerio（不绕反爬）。
- 受保护平台（BOSS直聘等）不爬取，改用其**公开/官方合作接口**或搜索引擎收录的公开页。

### 3.2 广泛来源清单
- 经典赛事：互联网+、挑战杯、ACM/CCPC、数学建模、电子设计、机器人锦标赛、大广赛、生命科学竞赛。
- 新颖赛事：AI 创新大赛、开源黑客松、Kaggle/天池、机器人/无人机新赛道、碳中和/社会创新赛。
- 求职：本校就业网春招/秋招宣讲与双选会 → 目标高校就业网 → 大厂校招官网（字节/腾讯/阿里/华为/美团等）→ 公开聚合（实习僧/牛客/搜索引擎收录）。
- 科研：本校实验室/课题组招募、科研院所公开招募、大学生创新训练计划。

### 3.3 画像精准推送
硬过滤（年级/专业/资格）→ 向量余弦（兴趣/技能/目标）→ 权重评分（25/25/20/15/15 可配）→ 可解释理由 → 按优先级+截止推送至 Dashboard/雷达。

---

## 4. Q10 · 轻量化 Harness 与简洁 UI

- 单一 Orchestrator + 专业工具，不堆独立 LLM Agent（已实现）。
- UI：左侧极简导航 + 左下「Agent 设置/调优」；对话页单列气泡、重点突出；卡片克制、不堆叠；截止/风险高亮；移动可用。
- 容器简洁：每个页面一个主任务容器 + 必要辅助容器；错误/空/加载态统一。
- 参考 Claude Code/Cline 的「单主循环+工具」轻量 harness，避免重型多代理框架。

---

## 5. 落地状态与下一步

已实现：模型路由代理、供应商设置（密钥服务端）、Agent 对话+工具循环、日常任务专区+清洗去重、搜索/匹配工具、JSON 校验回退。
下一步：接 QQ 官方机器人凭证启用自动通道；接搜索 API 启用实时检索；pgvector embedding 匹配；上下文压缩与 prompt cache 优化；模型分级路由（flash/pro）。

## Sources
- [DeepSeek API 更新日志](https://api-docs.deepseek.com/updates/)
- [DeepSeek Your First API Call](https://api-docs.deepseek.com/)
- [DeepSeek 模型对比（V4 flash/pro 1M 上下文）](https://www.secondtalent.com/resources/every-deepseek-ai-model-explained-compared/)
- [QQ 机器人官方文档 · Agent 接入](https://bot.qq.com/wiki/agent-qqbot/)
- [QQ Bot 介绍与接入指南](https://bot.qq.com/)
- [QQ Bot 常见问题（群全量消息权限）](https://bot.qq.com/wiki/bot_FAQ/)
- [2026 QQ 群机器人现状与误区](https://blog.csdn.net/NHKYQYGZSZJDYHM/article/details/163636162)