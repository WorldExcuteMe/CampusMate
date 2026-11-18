# Headless 采集验收与外部基准

2026-11-18。基线为 `origin/develop` 的 `c506d0f0265e0b5c0425e67af15e3a99b6efc38e`，工作区为 `feature/agent-local-workspaces`。沿用已授权的本地 Agent 实施范围，本阶段用团队 Headless Evaluation System。模型独立选工具和执行，评测者只配置来源、提交用户请求和检查可观察结果。此前人工采集的群聊摘录、课表 CSV、电脑桌面和录制的工具结果不进入本阶段。

## 产品与评测范围

| 场景 | 启动条件 | 通过标准 |
| --- | --- | --- |
| S1 群档案 | 每个评测账号只连接自己的只读程序化源 | 真实 HTTP 逐页读至终止游标，稳定 ID 去重，完整保存和下载。独立核对源字节摘要、页数和条数。首次计分使用 10 页、480 条。 |
| S2 课表 | 两个账号、两种学期表述、CSV 与 ICS 门户分别提供 24 周 | 实际创建该账号学期的导入预览，完整课程键集合与独立参照相同，错误为零。 |
| S3 真实平台 | 有对应的已授权程序化来源、范围和独立验证材料 | 群聊使用日期范围和大量可核对记录。课表逐项核对周次、单双周、时间、地点和学期范围。缺权限或未保存产物即失败。 |
| S4 通用执行 | 原有长期任务和文档用例，真实模型 | 分列任务通过、实际下载和复读、耗时、调用、用量。超时保留已成功产物证据，最终任务仍保留超时判定。 |

程序化来源通过账户所选的只读 HTTPS 端点读取。每个连接配置包含 `id`、`label`、`dataset`、`url`、`format`，可配置仅在服务器使用的 `bearer`。支持分页 JSON、CSV、ICS 和带预期标记的 HTML。分页协议提供 `records`（每项有稳定字符串 ID）、`nextCursor`（`null` 表示读取结束）及可选 `total`。游标循环、记录变动、声明总数不符、响应过大、来源要求重新登录都会使采集失败。源原文和模型可见的目录/统计分开，用户可从本地授权接口拿到原文。CSV 和 ICS 进入原有课表校验、预览、确认流程。

本地产品用 `--source-config <workspace 以外的连接配置>` 绑定连接。在账号有官方授权时配置相应端点。该机制可以接正规群档案、门户导出和校园服务 API。内置 QQ 客户端登录、微信小程序登录和校园统一认证各有自己的授权范围。太原理工大学官网确认学生入口需认证，本轮环境未提供可独立复核的程序化学生课表连接。参考 [QQ 官方机器人接入](https://bot.q.qq.com/wiki/develop/api-v2/) 和 [太原理工大学教务部学生入口说明](https://jwc.tyut.edu.cn/info/1229/5525.htm)。

Headless 真实平台评测使用 `--source-eval-config <本地文件>`。配置按用例 ID 映射，包含 `grants`、`sourceId`、`sha256`、可选 `minPages` 和课表用例的 `scheduleDigest`、`term`。学期仅提供 `name`、`startDate`、`endDate`、`totalWeeks`、`timezone` 元数据。独立参照摘要只交给评分器。分页产物为 UTF-8 JSONL，无尾换行，保持服务记录顺序并按稳定 ID 去重。CSV 和 ICS 摘要使用原文 UTF-8。课表摘要使用规范化 `scheduleKey` 集合排序后的 JSON。实际评测先在本机配置好允许使用该数据的模型，再用 `--allow-private-model-data --runs <本地证据目录>` 执行。该配置不会上传仓库。合成源由 Headless 在回环地址启动，使用真实 HTTP 和模型，评测过程不预先生成 Agent 要交付的文件。

## 生效入口与影响

- `backend/src/runtime/linked-sources.ts` 和本地启动入口实现来源绑定、读、持久化和课表预览。
- `backend/src/api/server.ts` 的授权产物下载与现有日历导入接口实现回读。
- `backend/src/evaluation/targets/api.ts` 与 `backend/scripts/eval.ts` 将同一产品工具接入 Headless。每个用例独立用户，来源答复与独立快照比对。前端无需参与。
- 用例和固定检查见 `headless-source-generalization.json` 和 `headless-private-sources.json`。未改既有留出集。

## 已观测的失败和修复

- 原长程和文档套件的探索性用例各 1 条，以配置中的 Gemma-4-31B-IT 真跑。HORIZON-001、DRAFT-001 均超过 150 秒。DRAFT-001 的 `document_create`、`document_inspect` 和三次导出都已执行，最后一轮模型调用前已检查文件。超时仍计为该次任务失败。
- 新采集套件首跑 0/5。三条隔离用例都从目录找到源而且调用采集，但存储返回 `Artifact content hash mismatch`。改为保留原文件内容摘要和存储对象摘要，复用项目的规范序列化。
- 两条真实平台用例的 `source_catalog` 返回空列表。独立评分发现实际产物 0、真实课表预览 0，由此判定失败，即使运行状态显示 `succeeded`。真实平台连接验收仍待来源授权。
- 代码回归覆盖每账号隔离、分页去重、总数不符、游标循环、登录页错误以及 24 周课表预览。最后一次后端类型检查和 45 项定向回归测试通过。

## 真实模型复跑

| Headless 运行 | 判定 | 证据 |
| --- | --- | --- |
| `20261118-113459_live_headless-source-candidat_b30046` | 隔离用例 0/3，真实账户 0/2 | 三个隔离用例因产物摘要契约失败，两条真实账户用例均没有授权源。 |
| `20261118-114233_live_headless-hash-repair_41037c` | 隔离用例 2/3 | 两套课表通过。群源已完整读到 480 条并通过下载复核，最终回复超时。 |
| `20261118-114802_live_headless-source-final_09c24d` | 隔离用例 3/3 | 群档案 10 页 480 条，69.1 秒。CSV、ICS 课表预览均为 24 条且零错误，分别为 55.9、79.2 秒。 |
| `20261118-115127_live_headless-document-rechec_677eda` | 文档探索用例 1/1 | Markdown、DOCX、PDF 都下载并复读，任务 50.7 秒，17,035 tokens。长程原基线的超时判定仍有效。 |

源档案复跑针对已观测到的冗余复读和额外文档生成缩小返回上下文，保留模型独立选工具与原评分条件。评测用量从已完成模型轮次取证，取消前已报告的 11,866 tokens 不再因任务快照未刷新而丢失。实际提供商计费仍需单独核对。

## 外部基准选择

| 能力 | 基准 | 收录理由和 CampusMate 对应指标 |
| --- | --- | --- |
| 编程和长程终端 | [Terminal-Bench 2.0](https://github.com/harbor-framework/terminal-bench) | 采用独立沙箱和执行态验证，记录首跑通过率、退出结果和恢复后重复副作用。先选数据处理和工程任务。完整上游成绩必须从原 harness 得出。 |
| 多工具长程 | [AppWorld](https://github.com/StonyBrookNLP/appworld) | API 环境和任务后状态独立检查，适用于跨用户、分页、权限以及复杂动作顺序。报告通过率、覆盖和越权事件。 |
| 文档与办公 | [GDPval](https://openai.com/index/gdpval/) 与 [OfficeBench](https://github.com/zlwang-cs/OfficeBench) | 以交付物和项目评分规则为主，复开文件检查真实性和结构，独立复核可核对事实。需同时保留任务超时率和交付物部分通过率。 |
| 仓库修复参考 | [SWE-bench](https://github.com/SWE-bench/SWE-bench) | 使用独立测试验证修复可参考其方法。公开 Verified 的污染和测试缺陷使其不适合作主门槛。见 [OpenAI 复核](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)。 |

外部基准调研日期 2026-11-18。当前分数来自 CampusMate 用例，未运行外部排行榜全套。可把上游测试结构映射到内部任务，以保留证据格式和留出用例。
