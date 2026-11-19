# CampusMate Agent 外部基准回归

2026-11-18。基线为 `c506d0f0265e0b5c0425e67af15e3a99b6efc38e` 上的既有本地工作区候选。仓库及适用祖先未发现 AGENTS.md 或 agent.md。独立运行团队 Headless 与外部官方评分。沿用合成数据源和既有的用户授权范围。保留原题、判据和预算。新题按官方公开顺序选样，结果单列。

## 基线与方案

上一轮 GDPval 有 13 次搜索、零正文读取和零交付。检索工具将部分英文复合关键词缩为单词或末段修饰语，返回空页面和失焦线索。搜索服务是否还能取得足量正文需用实跑证实。研究文档提供公开学术索引的可选检索范围，保留网页检索默认行为。文档循环触发一次阶段提醒，仍由模型决定查阅和写作。依据是 [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) 2026-11-18 的公开元数据契约。索引只返回线索，文档事实仍须有真实读取正文。

Terminal-Bench 的首次有效评分为 0。模型用全行子串匹配日志级别，结果存在但计数不符。将输入结构、反例和内容验证提到已授权的编程工作区指令里。验证不依赖本题数据、答案或隐藏检查。由于模型采样和测试环境均会变动，保留同题复测与新题的原始记录。

AppWorld 的会话连续性调整只在模拟评测桥接层，用已登录的同一应用会话调用原 API。该适配层的变化与产品外部服务授权分开。OfficeBench 使用官方程序化操作和评估入口，准备用例时只取公开题面和工具契约。

## 影响面与验收

| ID | Given | When | Then | 影响面与验证 |
| --- | --- | --- | --- | --- |
| R1 | 英文复合检索含多个主题词及可选限定词 | 首次搜索偏题 | 重试保留多个主题词，过滤只匹配孤立修饰语的结果 | web-search.ts relevantSearchHits、searchWeb，保留中文赛事和站点过滤回归 |
| R2 | 用户请求公开学术资料 | 模型选择学术检索范围 | 固定公开域返回可追溯 DOI、标题和年份，失败仍显式报告，结果定位为元数据线索 | web-search.ts 新函数、cloud-tools.ts CLOUD_TOOLS/executeCloudTool，保留默认 Bing 和离线限制 |
| R3 | 用户明确请求研究和文档文件，所需工具可用 | 反复搜索但没有读取正文 | 只追加一次真实来源与交付阶段提醒，文档工具和权限不变 | generation-policy.ts 新指令、agent-loop.ts 约 213–257 和主循环，验证恢复与普通信息请求 |
| R4 | 工作区同时授权写文件和程序执行 | 执行编程任务 | 要求根据输入格式解析、检查边界和反例，再验证实际输出 | agent-loop.ts 模型输入，非工作区和仅可读工具不受影响 |
| R5 | 外部公开样本和内部能力套件 | 使用相同模型进行串行复测 | 记录通过、工具数、模型用量、时长、证据和环境异常 | AppWorld、Terminal-Bench、GDPval、OfficeBench，以及内部长程、文档与源连接 |

开始修改前备份目标文件。回滚按本轮补丁操作，保留既有本地工作区改动及原始评分。全套排行榜和真实 QQ、微信账号自动采集仍使用各自独立验收条件。

## 2026-11-18 复测结果

团队 Headless 实跑使用 `Gemma-4-31B-IT`。按原题、原限时和原评分门槛执行。AppWorld 选取相异场景，含同题 1 个和新增题 1 个。OfficeBench 使用隔离的 Python 工作区适配器和上游 `evaluation.evaluate_output`。适配器保活后按原输出路径验收。模型仅收到题面、公开工具和任务输入。Terminal-Bench 继续使用原始 `test.sh`、`test_outputs.py` 和官方任务镜像。

| 能力 | 本轮结果 | 行为与边界 |
| --- | --- | --- |
| 授权数据源 | 3/3，12/12 项检查 | 合成群消息源 10 页共 480 条，CSV 和 ICS 各 24 节课，课表预览逐条相符。群消息用例未调用 `campus_browser`。 |
| 文档交付 | DRAFT-001 通过 9/9，146.1 秒 | 实际导出并回读 Markdown、DOCX、PDF。探索性用例独立计分。 |
| 长程任务 | HORIZON-001 通过 15/22 项，用例失败 | 前两轮成功，第三轮发出模型请求后触及 150 秒评测时限，未观察到模型响应。探索性用例独立计分。 |
| 应用操作 | AppWorld 0/2，每题 0/5 项 | `3d9a636_1` 获得模拟会话和查询结果，后续反复提交不匹配的参数，耗尽 35 次工具预算。`fd1f8fa_1` 在 12 次工具调用后遇到模型连接失败。 |
| 表格与文件交付 | OfficeBench `1-11/0` 0/1 | 生成了 `sorted_score.xlsx`，但位置是根目录。上游评分器在 `./data/sorted_score.xlsx` 查找失败。 |
| 终端编程 | Terminal-Bench 无有效复测分数 | Agent 在首次 `workspace_list` 后等模型响应超时。Harbor 验证器随后在依赖安装阶段超过 900 秒，结果是 `VerifierTimeoutError`。保留上一次正式评分 0.0，本次不合并进评分。 |
| 外部研究与报告 | GDPval `GDPVAL-0005` 0/1 | 240.1 秒达到时限，16 次工具调用，24,629 tokens，取得一份 arXiv 摘要入口的可读页面文本，无 DOCX。上次候选为 20 次工具、99,218 tokens、211.1 秒，无 DOCX。单例用量变化不足以估计普遍节省或缓存命中率。 |

学术检索的 `openAccessOnly` 从 [OpenAlex Works](https://help.openalex.org/data/works/attributes/) 读取公开落地页候选。2026-11-18 用独立关键词核对到开放获取标志和落地页字段。下游仍通过 `web_fetch` 读取页面，索引命中不会生成证据。文档循环在累计 4 次检索仍未尝试读取，或累计 3 次读取没有可用正文时，仅发送一次恢复提醒。针对性测试先重现 2 项缺陷，修复后 24 项通过。类型检查通过，后端 615 通过、0 失败、1 跳过。隔离 PostgreSQL 用例缺少 `TEST_DATABASE_URL`。

运行记录位于 `C:/Users/Asus/CodeBuddy/campusmate-builds/acceptance-20261118/external-benchmarks`。

- 数据源 `comprehensive-headless-runs/20261118-142750_live_connected-sources-regres_0fd4e8/report.md`
- 文档和长程 `comprehensive-headless-runs/20261118-142245_live_document-and-horizon-reg_6ea7f2/report.md`
- AppWorld `appworld/headless-runs/20261118-141039_live_campusmate-headless-2026_fc0b65/report.md`
- OfficeBench `officebench/runs/20261118-145524-6436da/result.json`
- Terminal-Bench `terminal-bench/jobs/campusmate-log-summary-regression-02/result.json`
- GDPval `gdpval/headless-runs/20261118-145833_live_gdpval-regression-03_40d079/report.md`

内部连接用例使用合成源。QQ 群 881289395 和太理助手Pro 的完整课表由用户按此前决定人工验收。

## 下一轮变更与原门槛

| ID | Given | When | Then | 影响面与验证 |
| --- | --- | --- | --- | --- |
| R6 | 已授权读写和执行工作区，需交付文件 | Agent 创建或转换文件 | 提前确认输出的相对路径和工作目录。只给文件名的转换任务默认在输入所在目录交付，并回读最终文件 | agent-loop.ts 编程指导及作用域测试；OfficeBench 原题与评分器 |
| R7 | 用户要求在线研究并交付文件 | 检索命中可用的来源入口，但连续搜索未读取 | 进度提醒要求取得候选后尽早读取，再针对证据缺口补查。可在独立来源上同轮发起多个读取 | generation-policy.ts、agent-loop.ts 提醒触发及通用用例；GDPval 原题和 DOCX 复读门槛 |
| R8 | 外部工具声明公开请求结构 | 请求携带未知字段或缺少所需参数 | 评测桥报告缺失字段、未知字段和公有签名。仅使用已有登录会话引用，无推测参数或代填数据 | 外部 AppWorld 适配器和原状态评分 |
| R9 | 长程及其它样本发生连接停顿 | 在同一供应商选择可用模型 | 使用评测进程级独立配置，对照真实响应、分数和耗时 | 先跑 V4 Flash 长程对照；保留 Gemma 基线、每题时限及全部检查 |

OfficeBench 的题面只指定文件名，上游 Agent 指令公开将任务文件放在 testbed/data。本轮在适配器补回这一公开环境说明，涵盖所有用例；官方输入和评分器按原件使用。参考 OfficeBench 的 utils/policies.py。研究和应用纠错不使用题目答案、不更改评分。回滚使用本轮变更前的快照。核验原工作树中的核心文件前未发现附加 AGENTS.md。


## 复测后新增回归

| ID | Given | When | Then |
| --- | --- | --- | --- |
| R10 | 用户仅要求预览导入，已授权工具返回真实预览 URL、正数行数及零错误 | 继续执行到工具结果 | 由运行时给出预览链接与行数，免去模型重复转述。混合请求、警告及无效预览继续由 Agent 处理 |
| R11 | 用户要求研究交付，某网址已经返回不可读的 2xx，或 HTTP 401、403、404、410 | Agent 重复提交相同 URL | 执行循环保留原始错误并返回已尝试观测，不重复发网络请求；临时故障可重试 |
| R12 | 开放获取最优入口不可读，且索引有其它开放版本 | Agent 查阅检索观测 | 提供同一作品的公共备用入口，文章仍需通过 web_fetch 读取 |

保持原场景、工具授权、评测预算和评分规则。预览收据仅基于工具观测，不会绕过用户的审批或确认。AppWorld 公开接口列表已包含参数名。Terminal-Bench 采用原题、原镜像和 Harbor 验证器，另备同版本依赖对原始产物做离线复核。开放版本字段依据 https://help.openalex.org/data/works/open-access/ 和 https://help.openalex.org/data/locations/ （2026-11-18）。


## 本机自托管与下一阶段评测

CampusMate 是用户自己运行的开源 Web Agent。同一台电脑可以运行服务端并通过浏览器访问。用户在自己的实例中注册、登录和管理数据。核心任务执行、会话及工作区、权限和审批、Inbox、课表与产物存储逐步做到独立于公共 CampusMate 服务。用户可配置本地模型或远程推理服务；选用远程模型时按任务权限限制发送的上下文。当前混合部署是迁移起点。

1. 先按本轮既定门槛收口。保存原始题面、通过与失败记录、官方评分和运行配置。
2. 扩大通用验证。优先引入 GAIA 的多级通用任务、AppWorld 的跨应用任务、Terminal-Bench 的终端任务和 OfficeBench/GDPval 的实物交付。逐个固定版本、题目清单、执行环境、评分器和时限。GDPval 同时记录工件检查与官方质量评分。加入独立的多轮交互评测以及冷启动、无中心服务可用、断网和重启恢复验收。对具有攻击、武器或高风险生物内容的题目，先明确允许跑的范围，再冻结普通任务子集。
3. 同一冻结题组比较 Gemma-4-31B-IT、DeepSeek-V4-Flash、AMD 模型目录中经短请求确认可用的其它模型。密钥留在本机，模型参数按各自端点契约配置。固定样本和权限后记录首轮成功、重复通过率、评分器状态、耗时、错误分类、实际输入和输出、缓存读取、费用与人工介入次数。再用同模型比较 CampusMate 与成熟开源 harness，隔离模型和运行框架的影响。
4. 在通用能力基线稳定后，将 QQ、微信、学校网页与教务系统接入同一授权数据源契约。每个连接器验证身份与授权状态、分页完整性、增量与去重、来源踪迹、兼容格式以及 Inbox 和课表侧的真实回读。涉及用户账户的验收使用用户授权的数据接口或人工验收环境。

基准来源（2026-11-18 核对） [GAIA 数据集](https://huggingface.co/datasets/gaia-benchmark/GAIA) · [AppWorld](https://github.com/StonyBrookNLP/appworld) · [Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1) · [OfficeBench](https://github.com/zlwang-cs/OfficeBench) · [GDPval 评分说明](https://evals.openai.com/gdpval/grading) · [τ-bench 运行口径](https://github.com/sierra-research/tau2-bench/blob/main/docs/running-the-benchmark.md) · [AMD 模型目录](https://amd-aim.github.io/radeon-cloud-docs/models/overview/)。

## 横向对照

共同题 `log-summary-date-ranges` 的题面、`test.sh` 和 `test_outputs.py` 逐个与 Apache Maka 使用的 Terminal-Bench 2.1 固定版本核对，统一换行后内容相同，任务镜像标签一致。另核对了 Dockerfile 与日志生成器，内容同样一致。CampusMate 在 AMD 使用 DeepSeek-V4-Flash。Apache Maka 九组对照也使用 DeepSeek V4 Flash，并开启 max 推理。模型供应端、推理档位和 harness 执行限制影响对比。以下整套分数均为 Apache Maka 公布的同模型研究报告值。

| Agent | 日志题 | Terminal-Bench 2.1 整套 | 证据 |
| --- | --- | --- | --- |
| CampusMate | 通过，官方 1.0 | 已测 1 题 | `terminal-bench/jobs/campusmate-log-summary-regression-04/result.json` |
| Codex | 通过 | 73/89，82.0% | Apache Maka 公开实测 |
| Claude Code | 通过 | 49/89，55.1% | Apache Maka 公开实测 |
| DeepSeek Harness | 通过 | 65/89，73.0% | Apache Maka 公开实测 |
| OpenCode | 通过 | 58/89，65.2% | Apache Maka 公开实测 |
| Pi | 通过 | 66/89，74.2% | Apache Maka 公开实测 |
| Apache Maka | 通过 | 69/89，77.5% | Apache Maka 公开实测 |

[公开配置与整套结果](https://github.com/apache/maka/blob/main/docs/eval/terminal-bench-2.1-deepseek-v4-flash-nine-arm.md) · [公开逐题得分](https://raw.githubusercontent.com/apache/maka/main/docs/eval/terminal-bench-2.1-deepseek-v4-flash-nine-arm.csv) · [固定公开任务](https://github.com/harbor-framework/terminal-bench-2-1/tree/d49e28f1e4ddd13d289e85a5f312a66750951932/tasks/log-summary-date-ranges)。

| 能力 | CampusMate | 公开整套参考 | 判读 |
| --- | --- | --- | --- |
| 跨应用操作 | AppWorld 0/2 | 原论文实验 GPT-4o Agent 在 Test-Normal 为 48.8% TGC，168 题 | 我们的证据显示跨工具、多步骤任务未完成。样本和配置不足以计算百分点差距。 [AppWorld 作者报告](https://appworld.dev/acl-talk.pdf) |
| 办公自动化 | OfficeBench 1/1，Gemma 和 DeepSeek 各通过同一单应用任务 | 作者 GPT-4 Omni Agent 单应用 64.52%（93 题），整套 47.00%（300 题） | 已验证简单表格产物落点和内容。多应用办公覆盖仍不足。 [OfficeBench 作者结果](https://github.com/zlwang-cs/OfficeBench#-leaderboard) |
| 职业研究交付 | GDPval 使用公开题和本地 DOCX 交付检查 | 官方采用专家偏好、可辅以量表和模型预估 | 文件交付和研究质量分别计分，需用官方口径评估内容质量。 [GDPval 评分](https://evals.openai.com/gdpval/grading) |
| 校园长程与业务连接 | 使用内部场景和真实模型 | 无同题公开竞品成绩 | 独立报告规划、跨轮保持、恢复与业务回读。 |

本轮可判断 CampusMate 已能完成这道常规终端题和一项表格交付，较明显的短板是多步骤连续执行和研究交付。通用差距须在固定的大样本和一致的评分口径下测量。

R13。GDPval 回归已读到 6 个可读页面，两次文档创建均提交了缺少 type 的块，产品返回结构错误。将正式文档块的 type、可选值与结构字段放进工具定义，继续由原文档校验验证出处与结构。使用 Worker 的正常入口及现有评测。

## 回归记录续

| 用例 | 验收记录 |
| --- | --- |
| Terminal-Bench | WSL 恢复后以 DeepSeek V4 Flash 完成 `log-summary-date-ranges`。官方 Harbor 成绩 1.0，pytest 2/2。Agent 10 次工具调用，约 302.7 秒，输入 65,739 tokens，输出 3,996 tokens。2.0 和对照报告使用的 2.1 固定任务的题面、两份验证器文件、Dockerfile 与生成器换行归一后相同。 |
| OfficeBench | `1-11/0` 原题。Gemma 和 DeepSeek 各自生成到 `data/`，用原本带相对参考目录的目录结构、原评分器对原样产物重评分后均通过。每个模型各跑同一题。 |
| AppWorld | DeepSeek 快速目录候选的文档查询次数由 15/18 降为 3/6。原官方状态验收两题均未通过。第二题超时后对保留状态补跑官方评分也为 0/5。 |
| 课表与文档 | Gemma 课表 CSV 和 ICS 各 24/24，来源存档与预览合格。预览返回后两题均无追加模型请求。DRAFT-001 9/9，三格式完整回读。 |
| GDPval R10–R12 | 同 DeepSeek 配置下从 28 次工具调用降到 17 次，可读响应由 2 增至 6。两次文档创建提交错误块结构，没有产物。单次采样用于诊断。 |
| 长程 | Gemma 和 DeepSeek 既有试跑在 150 秒内最多完成两轮。Qwen3.8-27B 低推理试跑首轮在 150 秒内未得到完成响应。 |

证据目录在以上评测根路径下。

- Terminal-Bench `terminal-bench/jobs/campusmate-log-summary-regression-04/result.json`
- OfficeBench `officebench/runs/20261118-163137-a0b093/verified-result.json`、`officebench/runs/20261118-163837-f081d1/verified-result.json`
- AppWorld `appworld/headless-runs/20261118-172451_live_campusmate-headless-2026_1302d9/report.md`、`appworld/round-04-inline-official-replay.json`
- 课表与文档 `comprehensive-headless-runs/20261118-181003_live_gemma-calendar-document_48693c/report.md`
- GDPval R10–R12 `gdpval/headless-runs/20261118-181209_live_gdpval-v4-05_a22bf2/report.md`
- Qwen 长程 `comprehensive-headless-runs/20261118-181618_live_horizon-qwen-05_03d3d6/report.md`

R13 针对性 25 项通过，类型检查通过，全量后端 620 通过、0 失败、1 跳过（隔离 PostgreSQL 缺少 `TEST_DATABASE_URL`）。同题实跑仍在 240 秒预算内超时，得到 4 个可读页面，未发出创建调用，因而没有证明该题能够交付。记录 `gdpval/headless-runs/20261118-181905_live_gdpval-typed-doc-06_6de7f1/report.md`。

R14。多轮任务能够交付三个文件，但模型改写了用户列出的章名。正文起草阶段要求照录用户指定标题和顺序，最终导出继续使用实际正文和原评分。用无关主题的自定义标题覆盖该规则。

R15。真实课表预览已生成，聊天的普通 URL 守卫却拒绝了本机预览路由。只在本地工作区启用形状严格的课表预览链接，旧路径映射到已存在的日历页，普通网络地址、相对路径和其它 API 路径继续按现有守卫处理。

MiniCPM-V-4.7-35B-A3B 用原预算跑完 HORIZON-001 十轮，57/60 项通过，三种文件均生成。原稿一处标题改写使三项内容检查失败。R14 提示修复后两次复测先后在第十轮和第一轮触及时限，仍未通过，保留原检查。MiniCPM 的 AppWorld 仍为 0/2。后端类型检查通过，最后全量 621 通过、0 失败、1 跳过。课表链接有新增前端路由测试。

- 长程完整产物记录 `comprehensive-headless-runs/20261118-182501_live_horizon-minicpm-07_d48da3/report.md`
- 长程标题复测 `comprehensive-headless-runs/20261118-183110_live_horizon-minicpm-title-08_6b8e79/report.md`
- 长程重复采样 `comprehensive-headless-runs/20261118-183903_live_horizon-minicpm-title-re_f16724/report.md`
- AppWorld MiniCPM `appworld/headless-runs/20261118-182712_live_campusmate-headless-2026_442664/report.md`

本机产品架构和公开演示按 [本机自托管与评委展示](campusmate-self-hosted-demo.md) 继续验收。

前端全量 55 个测试文件、302 项通过。默认隔离工作区用旧 worktree 的依赖 junction，首次 Vitest 默认配置拒绝读取 PDF worker。修复验证使用一次性的测试配置，只将已知依赖目录加入 Vite 测试文件范围，配置已清理。前端类型检查和定点 10 项通过。

## 扩样基线

Terminal-Bench 2.1 使用 Apache Maka 对照采用的 `d49e28f1e4ddd13d289e85a5f312a66750951932`，官方清单 89 题。逐题状态账本区分通过、评分器判失败、环境受阻、未运行及明确排除。第一批验证前不改变工具预算和产品提示以保留可比性。包文件按 Git 内容校验，执行时只使用安全范围中的已审查任务和官方验证。不能执行的任务继续显示在固定 89 题覆盖分母。试验环境若使用替代镜像另报。
 
AppWorld 0.1.3.post1 首批取 test_normal 清单前七个不同场景，仍用官方数据库状态评分以及原预算。OfficeBench 固定作者版本 `b978b808667c32b52ce19a67ce1def1de9ae02b7`，新增五个有明确评估入口的 Excel 子题，保留按题官方动作语义和原始评分器。不同基准的样本、模型用量、难度与失败信号分别记录。

| ID | 触发 | 行为与验收 |
| --- | --- | --- |
| R16 | 完整清单中有未完成或网络安装异常的题 | 账本逐题对应唯一运行证据，评分错误不变成能力失败；续跑不会覆盖既有报告或启动排除项 |
| R17 | OfficeBench 公共配置要求用 finish_task 返回文本答案 | 复现官方的文本落点，评估仍由上游函数读取原始容器产物；产物题继续检查真实文件 |
| R18 | AppWorld/Terminal-Bench/OfficeBench 出现跨场景共性问题 | 在第一批可复现信号后，补确定性测试并进行同题候选复测 |

[Terminal-Bench 2.1 固定修订](https://github.com/harbor-framework/terminal-bench-2-1/tree/d49e28f1e4ddd13d289e85a5f312a66750951932) · [AppWorld](https://github.com/StonyBrookNLP/appworld) · [OfficeBench](https://github.com/zlwang-cs/OfficeBench)。

### AMD 请求指标

Headless 轨迹记录模型、请求完成时间、重试次数、端到端请求时长、输出结束原因，以及服务端响应携带的输入、输出、缓存和推理 token。每次请求的 KV 命中率按有配对字段的缓存读取 token 除以输入 token。跨请求按 token 加权，并列出有数据的调用数和缺失值。推理 token 已包含在有明细的输出 token 中，统计总量时只加输入和输出。非流式调用的首 token 时间保留为空。

在 AMD API Call Details 中可按同一模型、统一时区后的时间、输入和输出 token 与 Headless 请求配对。Prefill、Decoding 采用面板原始字段和实际单位，Headless 端到端耗时包含模型调用及客户端往返。匹配不唯一时保留未匹配状态。只保留调用指标，凭据和账户页面留在本机。

同题回归记录通过率、单项校验完成度、工具次数、参数错误、用量、缓存和时延。评分需要核对真实评分器执行证据。请求失败、模型完成但评分未满和本地验证器未启动分别记录。候选版保留同模型、任务提示和预算，验证工具接口与上下文预算对独立完成率的影响。

[AMD Radeon Cloud API Call Details](https://developer.amd.com.cn/radeon/profile)。

### 2026-11-18 首批扩样实跑

| 基准 | 已确认结果 | 观察 |
| --- | --- | --- |
| AppWorld | AMD DeepSeek-V4-Flash，官方达标 0/7，单项检查 13/34，3 个任务完成了官方提交 | 3 次模型请求超时，1 次因输出长度终止。3 个任务因公开完成接口参数不合规各多用了一次接口调用 |
| Terminal-Bench 2.1 | 按固定版本核对 73/89 个题包，首批已启动 | 10 题明确排除、6 题待复核。1 道先前通过的等价题已有官方验证记录，扩样候选成绩以新增记录为准 |
| 后端自动测试 | 626 通过、1 跳过，类型检查通过 | 长工具参数计入上下文预算，压缩时保留近期完整工具组。多轮评测达到共同期限后结束。模型响应错误保留分类及实际 HTTP 状态 |

AppWorld 真实请求共记录 103 条响应或异常事件，100 条返回完整缓存字段。缓存读取 488,960 tokens，对应输入 568,089 tokens，加权命中率 86.1%。输出 18,859 tokens，推理分量为 0。Headless 记录的模型请求累计约 2,034 秒，所有七题耗时之和约 2,070 秒。三个超时请求分别等待约 135、167 和 180 秒。AMD 面板可复核北京时间 19:41:36–19:43:52、19:45:10–19:48:11、19:52:19–19:55:07 三个窗口的 Prefill、Decoding 与 Status。

候选 AppWorld 工具目录补齐官方 API 已有的参数类型、默认值和约束，未改动模型收到的任务提示、模拟账户数据与官方评分器。在相同预算下重跑前三题，为候选结果单独留证。后续以超时率、额外调用数、完成率和官方分数共同判断收益。

最后一轮使用 Node 测试并行度 2。默认并行度的第一次运行在 Chromium 启动阶段达到 15 秒超时，限制测试并行度后真实文档渲染用例通过。

OfficeBench 另外准备了三个作者发布的子题 2-21/0、2-33/0、3-5/0，覆盖 XLSX 转 DOCX、数据筛选输出文本、PDF 发票转表格和 DOCX 报告。原始文档与官方评估函数来自固定上游修订，工具容器的 DOCX 与 PDF 依赖安装使用本地 wheel。后续结果继续从独立工作区评分。

### Terminal-Bench 验证与编程额度

SQLite 数据恢复试验的 Harbor 验证器超时。正则试验返回 reward 0，验证日志显示 uv 下载中断，pytest 没有运行。离线独立复核使用逐字节相同的评分测试，基于两次 Agent 停止后采集的容器文件状态，两题均未生成目标文件，单项为 0/1。正式 Harbor 原始试验和独立复核在账本中分开记录。

正则任务末轮达到了 2,048 token 的短输出额度。固定回归证明，原逻辑在工作区成功执行编程工具后仍保留短答额度。更新后，初次请求继续使用短额度，进入编程执行的工具轮可使用常规 8,000 token 保留额度，仍受任务总量、模型窗口和输出上限约束。后续用相同题面、模型与评分代码复跑，记录实际产物和成本变化。

离线依赖试验保留题面、官方任务镜像和原始测试文件。验证器使用本机配齐的 Python 3.13 与规定的 pytest 依赖，Ubuntu 镜像另外加载已验证的 Python 运行时。验证器必须实际生成 CTRF 测试报告才可计入成绩。该模式在报告中独立分列。

首个离线依赖真实试验为 Circuit。验证器实际运行官方测试，2/3 项通过，核心正确性失败，reward 为 0。五次模型请求中有一次超时 180.1 秒。OfficeBench 新增首题 1-10/0 的官方评分为通过，4 次工具调用，耗时 96.7 秒。Terminal-Bench 全量横向评分仍待足量同口径结果。

### 2026-11-18 21:30 接续批次

接手核对：分支 `feature/agent-local-workspaces`，基线 `c506d0f`，`origin/develop` 无新提交；上轮未提交改动按 `.github/CONTRIBUTING.md` 约定以 `b509c10` 记录为已验证检查点（当时证据：后端 627 项、626 通过、0 失败、1 跳过，类型检查通过）。会话中断后按“已有评分结果自动跳过”的串行队列续跑，未重复已完成的模型运行。

**可比性控制。** 运行源码冻结为 `C:/Users/Asus/CodeBuddy/campusmate-builds/eval-freeze-20261118T2130`（244 文件，`source_sha256=47a6e191…`），调优改动期间评测结果不受工作树变化影响。该批次所有运行使用 `DeepSeek-V4-Flash`、非思考模式（`reasoning="none"`）、上下文上限 262144、单请求 180 秒、重试 1、题面与评分器原件。

**OfficeBench（作者修订 `b978b808…`，官方 `evaluation.evaluate_output`）。** 本会话实际评分 9 题，通过 6 题。

| 题 | 判定 | 工具 | 输入/输出 tokens | 耗时 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1-10/0 | 通过 | 4 | 9,535 / 557 | 96.7s | 上一会话完成 |
| 1-11/0 | 通过 | 18 / 10 | — | — | 原运行产物落点修正后仅重跑官方评分器（Gemma 与 DeepSeek 各一次） |
| 1-11/1 | 通过 | 7 | 17,441 / 1,133 | 123.1s | 真实 xlsx 产物 8 个 |
| 1-12/0 | 通过 | 5 | 11,713 / 691 | 133.8s | answer.txt + roster xlsx |
| 1-14/0 | 通过 | 9 | 26,246 / 1,574 | 230.7s | 与参考文件逐单元格一致 |
| 1-14/1 | 未通过 | 7 | 18,197 / 1,006 | 132.9s | 只交换列值未交换表头，精确匹配失败（属语义与自检缺陷） |
| 2-21/0 | 未通过 | 3 | 7,030 / 537 | 82.8s | 读完 xlsx 后在聊天里作答，未创建 docx；已加交付校验恢复 |
| 2-33/0 | 通过 | 7 | 19,112 / 1,892 | 228.1s | top3.txt 内容正确 |
| 3-5/0 | 未通过 | 27 | 56,754 / 2,505 | 457.5s | 24 次脚本调用未产出 xlsx/docx，末次请求 92s 超时 |

证据：`acceptance-20261118/external-benchmarks/BATCH-20261118T2130/`（README、results.jsonl、officebench.md）与 `officebench/runs/*`。样本单列，不是作者排行榜成绩。

**AppWorld（官方状态评分，test_normal 前三同题）。** 补充公开参数类型/默认值/约束的候选桥复测 0/3。三题分别在 412/417/318 秒终止；32 个请求中 3 个超时（9.4%），P50 17.6s、P95 151.6s，加权 KV 命中 67.9%。同一时段端点明显慢于 19 点批次（P50 6.2s、2.9% 超时、86.1% 命中），因此本批复测不能单独归因于桥变更；325d6ec_1 出现 10 次公开文档读取、0 次 API 调用的空转。根因分析见 `appworld/forensics/appworld-failure-analysis.md`：answer_contract 3 例、pagination 2 例、超时终止 3 例、输出截断 1 例、工具角色混淆 1 例；公开 API 参数描述（如 `complete_task.answer` 的“仅在问答题填写、否则用默认 None”）、分页默认值与 `page_index` 语义此前未暴露给模型。已准备完整契约候选桥（参数 description、response_schemas、分页元数据、401/422 提示）并开始单变量复测。

**AMD 端点契约实测。** `GET {base}/usage?include_recent=true` 可用（`{base}=…/radeon/api/v1`；按字面再加 `/v1/usage` 得 404）；`reasoning_effort` 支持 `none/minimal/low/medium/high/xhigh/max`，`thinking` 参数被 400 拒绝，`chat_template_kwargs` 被静默忽略。客户端 103 条请求与供应商 200 行 usage 明细按“三元组相等 + 发出时延 +4.31s”全部对齐（100 高置信 + 3 条 canceled 中置信），缓存读取与输出 token 双侧一致；客户端未保存供应商响应 ID，已改为写入 telemetry。合成 1226 token 前缀缓存实测：冷 33.2s / 热 1.1s，缓存按 1024 token 块命中，中段改字节整段失效，尾部追加不失效，切换 `reasoning_effort` high/max 会因端点前置注入思考提示而整段失效。三次长等待（135/167/180 秒）经逐请求复原为服务端长尾 + 客户端期限触发，而非工具错误；两条前序请求在 96.9–97.8% 缓存命中的情况下仍耗时 107–168 秒。证据：`external-benchmarks/amd/`。

**产品验收（确定性，无实时模型）。** 8 组门禁 69/69 项通过：全新生产安装启动（PGlite 运行时依赖、12 迁移/38 表、重启保留 owner 与会话）、登录与账号隔离、工作区/文件隔离与路径穿越拒绝、审批（拒绝阻断副作用、重启不复问）、断网/重启恢复（副作用恰好一次）、编程与 Markdown/DOCX/PDF 真实导出并复读、Inbox/课表 CSV-ICS 迁移与回读、合成分页源 480 条/10 页与未授权源拒绝。已记录 4 项缺陷：本机身份仅在 HTML 注入永不过期的 owner JWT（无 Cookie/登出/双账号，D1 高）、`localhost`/`[::1]` 被 Host 守卫 403（D2）、纯重复课表重导确认 422（D3）、模型端点中断时任务记为 failed 而非 paused（D4，但 `/resume` 可恢复）。证据：`acceptance-20261118/product-acceptance/`。

**通用能力覆盖准备。** HORIZON 断点恢复取得可执行入口：`eval.ts` 增加 `--store pglite --store-dir` 与 `--resume-session last`，用现有 Worker/检查点让“阶段 A 暂停退出、阶段 B 同库续跑”可评测；3 项确定性测试通过（跨进程恢复副作用恰好一次、两会话不重复、非法参数拒绝）。GDPval 固定 `openai/gdpval` 修订 `11e7900…` 与 3 个样本及官方 rubric 哈希，自评与官方评分口径分离；GAIA 数据集为 gated（未授权 401），保留 manifest 与评分器并记录阻塞；tau2-bench 固定 v2.0.0，airline/0 在官方 Orchestrator + EnvironmentEvaluator 下以脚本化用户回合确定性跑通（reward 1.0、DB 校验通过、0 次 LLM 调用），实时 5 题 × 3 次 pass^k 待用户模拟器模型配置。证据：`external-benchmarks/general-coverage/` 与 `docs/specs/general-capability-coverage.md`。

**架构改动（已提交）。** `002fccf`：请求分段前缀指纹（系统/工具/历史/压缩摘要/动态尾部）与 1024 块可缓存估算进入 `llm.response` telemetry；候选 `CM_PREFIX_POLICY=1`（默认关闭）在任务阶段前缀不变时锁定思考档位、把运行期系统观测留在尾部；供应商响应 ID 与 USD 金额写入 telemetry；新增三类有界恢复（纯文本截断续跑、点名交付文件但无写动作提醒、单次请求超时重发），文档阶段 JSON 载荷仍走原有检查点暂停路径。`07cb709`：评测入口的持久存储与两阶段续跑。验证：后端 648 项、647 通过、0 失败、1 跳过（隔离 PostgreSQL 缺 `TEST_DATABASE_URL`），类型检查通过；前缀指纹 13 项、恢复守卫 5 项、持久存储 3 项定向测试通过。

**本轮实验与突破（AppWorld）。** 用相邻时段单变量实验定位限制因素：R0 补充参数类型/默认值/约束（schema-v1 桥）0/3；
R1 暴露完整公开 API 契约（参数 description、response_schemas、分页元数据与提示、401/422 提示）0/3 但真实 API 调用与分页行为明显改善；
R2 同契约 + 墙钟 780s/单请求 240s 后 0 超时，终止原因变为 token 预算（2 题）与 20 轮上限（1 题）；
**R3 仅把预算调为 600k token / 80 次工具 / 40 轮（快照与桥同 R2）：2/3 通过**——`3d9a636_1` 官方 5/5（461s、33 次工具、209,964 输入 token）、
`fd1f8fa_1` 官方 5/5（706s、33 次工具、379,946 输入 token），`325d6ec_1` 因最终请求 `fetch failed`（网络错误，attempts=2）未完成。
结论：在补齐公开 API 契约后，**预算而非模型能力是 AppWorld 同题的主要限制**；官方参考解需要 35–60 次 API 调用。
未参与调优的新场景泛化在暂停前完成一题：`2d9f728_1`（venmo 分摊付款）通过，`0d01c76_1` 未通过，`042a9fc_1` 因关机暂停未运行。
证据：`external-benchmarks/experiments/README.md`、`BATCH-20261118T2130/appworld.md`、`appworld/headless-runs/20261118-230804_*`、`20261118-234331_*`。

**本批暂停与续跑。** 用户关机前已停止全部模型负载并清除 Terminal 自动启动标记；冻结快照、运行产物与续跑命令见
`acceptance-20261118/PAUSE-HANDOFF.md`。续跑顺序：R4 剩余两题 → GDPval → HORIZON → Terminal-Bench 逐题队列（52/73 镜像就绪，逐题可续跑）。
交付校验已强化为“只跑过只读脚本也算未交付、先核验文件存在再创建”，定向测试 12/12 与类型检查通过，全量后端测试与 OfficeBench 2-21/0 复测留待续跑。

### 2026-11-19 上午：泛化与复测的新根因

- **AppWorld 泛化 1/3**：2d9f728_1 通过； d01c76_1（1/6）与  42a9fc_1（0/5）失败根因是桥同时暴露了
  ppworld_docs 工具与模拟器自带 pi_docs 元应用两条文档路径，模型在 ppworld_call(api_docs, list_*)
  上空转（41 次调用中 38 次、55 次调用 0 次写）。已在 ppworld_bridge_full_docs.py 移除 pi_docs 元应用，
  保留唯一规范文档路径，待同两题复测验证。证据 cceptance-20261118/external-benchmarks/general-coverage/RESULTS-20261119.md。
- **OfficeBench 2-21/0 复测仍未通过，但根因已精确定位**：模型真实创建了 classes_taken.docx（内容正确），
  却写在**工作区根目录**而非官方要求的 data/；触发链是脚本写在 data/、却以 cwd=工作区根执行，
  脚本内相对路径产物落到根目录。产品修复：workspace_run 未显式给 cwd 且运行工作区内脚本文件时，
  默认在该脚本所在目录执行（ackend/src/runtime/workspace-tools.ts defaultRunCwd，含单元测试）；
  OfficeBench 适配器环境说明同时明确"输入与要求的产物都在 data/ 下并回读该路径"。
- **GDPval 0/3（3 个 420s 超时）**、**HORIZON-001 十轮导出全部成功但第 1 轮"仅预览"语义被判失败**，
  记录于 general-coverage/RESULTS-20261119.md；下一步为 GDPval 600s 预算归一复测与预览/写入语义强化。
- **Terminal-Bench 2.1**：试点两题官方评分 constraints-scheduling reward 1.0、largest-eigenval 0.0；
  随后全量可执行子集以并发 2 逐题 Harbor 作业运行（52/73 镜像就绪，21 题镜像缺失单列），账本逐题记录。

- **OfficeBench 2-21/0 在修复后通过（Gemma-4-31B-IT，官方评分器 171.6s、7 次工具）**：产物正确落在
  `data/classes_taken.docx`，证明 `workspace_run` 默认脚本目录执行的修复有效。同一修复下
  DeepSeek-V4-Flash 两次复测暴露另一个通用缺陷：模型把工具调用包成 `</think> <{"tool":...}>` 标记，
  第一次被当成最终答复、第二次触发协议错误。已在 `tool-protocol.ts` 增加“标签包裹 JSON 调用”的有界恢复
  （仅在标签/尖括号前缀且工具名已注册、参数安全时执行；散文中的 JSON 示例仍拒绝），全量后端 654 项 653 通过、
  1 跳过，类型检查通过。DeepSeek 同题复测将在模型端点空闲时补跑。

- **Terminal-Bench 2.1 reviewed cohort（2026-11-19）**：逐题 Harbor 作业、并发 2、可断点续跑，被测快照
  `eval-freeze-20261118T2350`（ed899076…）、非思考模式。89 题账本：**passed 7 / failed 21（官方验证器出 CTRF 的真实失败）
  / infrastructure-error 14（验证器依赖安装在网络与并发下失败，不计能力分）/ image-unavailable 21 / excluded 10 /
  unreviewed 6 / not-run 10**。新跑 reviewed 任务官方出证据的通过率 6/27（含上批等价 log-summary 题 7/28）。
  与 Apache Maka 九臂（同模型 max 推理、完整 89 题）不可直接比较；逐题证据见
  `acceptance-20261118/external-benchmarks/BATCH-20261118T2130/terminal.md` 与 `terminal-bench-2.1-reviewed-cohort.json`。
- **AppWorld 泛化 R6（修复后）**：同两题、同预算、同评分器，只加“未知 API 可操作错误 + 连续 5 次工具失败升级提醒”后，
  `042a9fc_1` **通过 5/5（470s）**、`0d01c76_1` 2/6（776s 撞 780s 墙钟），泛化从 1/3 提升到 **2/3**。
  `0d01c76_1` 的剩余限制是墙钟/预算与逐文件往返，R7 以 1200s/1M token/60 轮做预算归一复测。

- **AppWorld R7 预算归一**：`0d01c76_1` 在 1200s/1M token/120 工具/60 轮下通过官方 6/6（1,072s、41 请求、659,477 输入 token、KV 93.8%）；未参与调优的新场景三轮迭代后 **3/3 全部通过**，确认此前的失败是预算/墙钟受限而非能力不足（证据 `20261119-145658_live_r7-0d01c76-big-budget_00f8cd`）。

### 2026-11-19 下午：评测标准 v2（standard-max 臂）与失败集复测

- **评测标准 v2**：产品现已支持 easoning_effort 全档位（minimal..max），任务级偏好 easoning: "max" 可端到端生效
  （探针实测 ffective="max"、reasoning tokens>0、供应商请求 ID 与 USD 成本入 telemetry）。标准配置：max 档按任务锁定、
  maxOutputTokens=32768、单请求 240s；文档见 `docs/specs/evaluation-standard.md`，提交 `4539c47`。
- **第一轮调优**（提交 `5519895`）：按任务类型的预算自适应（重任务 1M token/120 工具/30min）、完成证据要求
  （列出并回读全部产物）、连续只读/连续脚本无产物的停滞提醒、重复观测压缩、网络中断有界重试。全量后端 661 项 660 通过。
- **失败集标准臂结果**（只重跑失败/未评分项，不重跑已通过项）：GDPval **1/3 通过（首次）**，HORIZON-001
  探索性 **1/1 通过**；OfficeBench 1-14/1、3-5/0 仍失败；AppWorld 325d6ec_1 仍失败 3/5（末请求 240s 超时）。
  Terminal-Bench 失败集 35 题（21 真实失败 + 14 验证器受阻）标准臂复测中。证据
  `acceptance-20261118/external-benchmarks/STANDARD-ARM-RESULTS.md`。
- **两处评测基础设施 bug 修复**：Terminal 监督脚本空数组导致容量等待死循环（重写为 per-arm 可续跑脚本）；
  eval CLI/类型拒绝 max 档（提交 `86dff74`）。
- **范围**：GAIA、τ-bench 实时、WebArena 三项未跑基准按用户决定搁置；已通过集合不重跑。
