# CampusMate v21 正文恢复实测

状态：v21证据已收集，固定集与Gate通过，长任务仍卡在导出前；后续v22已打通真实交付，但整体质量目标尚未全达。最新事实见[v22收尾报告](AGENT_DRAFT_DELIVERY_20261117.md)。2026-11-17，主代理独立执行；分支`codex/agent-evaluation-quality-20261116`，v21影子快照；不push、不合并main、不改凭证、不写云端业务库。上轮失败与Gate拒绝见[v20记录](AGENT_EVAL_QUALITY_20261116.md)。

## 修复

1. SSE区分提前EOF/网络关闭与调用方取消、长度截断和协议错误，只有普通正文允许自动续写一次。续写时不给工具，不执行原生或JSON工具指令，不重放旧动作；预算、截止和轮次限制保持。
2. 保存原始草稿和续写标记到检查点；进程替换后恢复能保留前半篇；重复前缀去重，第二次截断仍暂停。摘要结构化JSON不走普通正文续写。
3. 显式索取自己的私有系统/开发者指令或内部工具定义由Runtime拒绝，不依赖模型输出。普通功能询问、执行进度和分析攻击例子仍可到模型。它是有边界的请求规则，不是通用提示词注入检测器，也不是模型拒绝能力证明。

## 验证

- 新行为回归先RED：9项中6失败，旧实现只暂停、不续写，且直接调用模型处理私有指令请求。实现后9/9。附加传输回归区分EOF/length/cancel及损坏JSON；54项相关回归通过。
- 全后端553项：552 pass、0 fail、1外部数据库skip；66248ms；类型检查通过。日志`.local/eval-v21-backend.log`。前端代码本轮未变，沿用v20前端227/227和构建记录，不把它说成v21新跑。
- fast `20261117-123620_scripted_quality-v21-fast-2026111_0fcb52`：计分16/16，安全负样本照常被抓出。
- business/conversation/replay `20261117-123620_api-memory_quality-v21-contract-202_1b7697`：11/11，另3条通道不适用。
- LIVE-007 `20261117-123410_live_quality-v21-private-boun_b6a3b2`：1/1、105ms、0模型/工具调用；Runtime拒绝，不能写成Gemma真实拒绝。
- 当前源码指纹`.local/eval-v21-source.json`共241个生产源文件，未包含holdout内容。git脏状态下不能只用相同commit号充当相同候选。

## 真实长任务与后续门槛

- 两项原10步任务：`20261117-123512_live_quality-v21-long-recover_ed2de2`，真实Gemma/API/工具/内存业务库，不改原prompt、断言或时限。
- 原失败15轮会话：`20261117-123512_live_quality-v21-long-convers_de2a2c`。
- LONG-002原15轮通过。两项HORIZON第9步正文完成，第10步各180秒无有效首字，0工具、0文件；v21仍不具备本次长任务交付通过证据。此失败保留，不能用后续v22结果改写。
- 固定`20261117-124639_live_quality-v21-fixed-a-2026_e34db1`：live9/9+conversation3/3；`20261117-125553_live_quality-v21-fixed-b-2026_529233`：live9/9。留出api-memory `20261117-130125_api-memory_quality-v21-holdout-api_498554`2/2、live `20261117-130126_live_quality-v21-holdout-live_ed94eb`3/4，原阈值Gate PASS，日志`.local/eval-v21-gate-verified.log`。先前协调日志runId正则误带中文label，不是有效Gate；保留并以修正后真实CLI日志为准。留出只经CLI加载，不查看其提示词或按其内容调优。

## 剩余问题

v20人工发现的离线核验建议把域名外观当“高可信/确认标准”、工具调用均值增长50%（目标≤20%）、多轮Parity60%低于默认80%，尚未由本修复解决。长任务使用用户给定材料，不是带外部研究来源的长报告；跨轮文档版本编辑、多轮图片、审批后真实模型恢复、云PG/RLS等仍无本轮验收。

本机Codex另按用户要求安装Microsoft/UC Berkeley的TokenEconomizer，使用官方插件CLI、Windows启动适配、隔离hook冒烟及标准TUI信任5个hook。宿主配置会话已执行，未提交模型任务；真实项目学习/节省未测。后续新Codex会话启用，不能热挂入此对话。本机安装记录保存在Codex私有安装备份目录，不进入项目配置或凭证。
