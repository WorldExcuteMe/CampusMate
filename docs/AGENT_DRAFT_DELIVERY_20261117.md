# CampusMate 真实评测收尾：长任务与文档交付

2026-11-17。主代理独立执行；能力结论来自Headless CLI的真实Gemma-4-31B-IT/API/工具，业务数据使用内存库。**固定集与现有Gate通过，两项完整十步任务有真实文件；整体质量目标仍有缺口，不能宣布达到通用Agent或全部验收完成。** 保留所有失败、原断言、exploratory标志和Gate阈值，没有读取或针对holdout内容调优。

## 1. 本轮改动

| 问题 | 实现与业务行为 | 对应证据 |
| --- | --- | --- |
| CONV-006截止更正产生重复通知 | list_inbox/update_inbox按owner和实际itemId定位、只更新待确认项，保持原id/原文；旧save仅在明确更新且唯一匹配时兼容更新，同名不同场次仍可新建 | 修复前2条，单例与最终live均1条；跨日期回放通过 |
| LIVE-005搜索后无URL或来源错配 | 修正年份/泛类目，限定真实搜索与读取，摘要绑定已取得来源；搜索-only工具环境明确标为未读原文线索 | 固定集evidence 1/2→2/2；引用硬门槛不放宽 |
| 暂停后继续新对话破坏顺序 | 暂停/待输入任务占据会话屏障，错误新轮次返回409；取消/恢复正确释放，旧failed有后续对话时保留记录并用新消息继续 | 原有状态机与UI回归；未把旧failed恢复策略改为重排历史 |
| 流式超时、正文提前断流 | 有效SSE进展更新空闲计时但不取消任务总预算；EOF/取消/长度/协议分别处理；普通正文仅一次无工具续写，检查点保存前缀，不重放工具片段 | v21相关回归；真实第9步正文恢复成功，旧失败仍保留 |
| 私有系统指令索取 | 窄范围Runtime规则直接拒绝自己的内部提示词/schema，正常功能说明及分析攻击样本仍可走模型 | LIVE-007可0模型调用完成；这不是Gemma拒绝能力证明，也不是通用注入检测器 |
| 已有长文导出又重写整篇，180秒无首字 | 用户明确创建/导出已有已完成正文时，按请求提供document_create短引用；服务端从当前授权原稿编译有限结构，模型仍选用创建/检查/导出工具 | 两项原10步任务第10步46.4/49.8秒、各5工具；来源SHA256与上一轮正文逐字匹配 |
| 实际PDF原始TeX、孤立小节标题 | 有限常用行内TeX转换为可读文字/符号；加粗独立编号小节转换为标题，沿用既有分页保留规则 | 先红后绿回归，最终2份PDF共4页逐页检查，无本次发现的标题悬空或裁切 |

短引用在参数校验、toolMeta/幂等和执行前统一展开；不提供任意owner/messageId，不接受系统/工具/失败输出。代码、图片等超出有限文本子集走原路径，不宣称支持完整TeX或任意富文稿。预览、等待确认、无原稿时不开启。没有以新建评测框架代替既有系统。

按用户新指示，已通过官方插件CLI安装并以标准TUI信任TokenEconomizer的5个hook，固定上游fb853981ef439db813bf96ec42eaa82822962e1e、版本0.1.0；Windows启动命令仅适配为py -3。项目为[Microsoft Research/UC Berkeley](https://github.com/microsoft/TokenEconomizer)，非Google。后续新Codex会话生效；当前长会话无法热挂载。宿主配置冒烟不产生真实学习/节省证据，不计入CampusMate模型降本结果。私有安装备份留在Codex目录，无凭证入仓。

## 2. 修复前后与真实交付

| 范围 | before | after |
| --- | --- | --- |
| 固定live | `20261116-193835_live_live-full-1_f28b92`：8/9，均耗63.688秒，均工具0.667，29015 tokens | `20261117-132944_live_quality-v22-fixed-b-2026_28cfbe`：9/9，25.627秒，均工具1.0，29074 tokens |
| 固定live再次确认 | 同上 | `20261117-133852_live_quality-v22-final-confir_99f0a2`：固定9/9、conversation 3/3；仅同9项均耗29.111秒、均工具1.0、29038 tokens；完整12项58602 tokens |
| 真实多轮 | `20261116-200506_live_conv-live-1_62b715`：2/3；CONV-006最终2条 | 最终确认3/3、CONV-006最终1条；独立P0单例`20261116-204910_live_quality-p0-manifest-rete_44b743`18/18检查 |
| 15轮会话 | 原探索批次LONG-002失败 | `20261117-123512_live_quality-v21-long-convers_de2a2c`：LONG-002原15轮通过；LONG-001此前15轮已通过，非两例同一新批次 |
| 两项完整十步 | v20断于第9步、v21第10步180秒无有效首字，均0交付 | `20261117-131905_live_quality-v22-full-long-20_4cd9e8`：HORIZON-001/002原10轮均通过，各有MD/DOCX/PDF，耗时971.165/809.226秒，总176843 tokens |
| 最终格式定向复测 | 先发现TeX和标题跨页问题 | `20261117-140400_live_quality-v22-final-layout_c73931`：DRAFT-001/002均通过，6真实文件，31180 tokens；是原稿导出重放，不冒充完整10步 |

两项完整长任务的原稿来源hash分别为`5e7e45ab930e401bb09438c0da4fcab5bf7954fcd1be9f13b329955c8cdb2dd7`、`9168b7c51b6276a3c83faf1733bd1703882bd9ebd23350639b71891c42c772eb`。真实下载、非空、hash及复读均核验。最终重放的DOCX通过ZIP/XML与文字检查；PDF经独立Poppler渲染后人工看4页。**没有本机Word渲染的视觉结论。** 最终PDF非空白字符含标题1253/1299、汉字含标题957/990；字符口径不同，不能据此偷换“700–1100字”上界已满足。

样件：[Word一](../.local/eval/20261117-140400_live_quality-v22-final-layout_c73931/artifacts/DRAFT-001/turn-1-9d3b212f-6a16-4f81-a1e8-1b6323b4dfae.docx)、[PDF一](../.local/eval/20261117-140400_live_quality-v22-final-layout_c73931/artifacts/DRAFT-001/turn-1-afe73c44-7cf4-4878-ad79-995e978182eb.pdf)、[Word二](../.local/eval/20261117-140400_live_quality-v22-final-layout_c73931/artifacts/DRAFT-002/turn-1-536be0d0-5cfe-4826-82b2-7fa50305d577.docx)、[PDF二](../.local/eval/20261117-140400_live_quality-v22-final-layout_c73931/artifacts/DRAFT-002/turn-1-25181c3b-7b6d-4d55-addf-c1e84fe7deac.pdf)。这些是测试样件，仍含下面列出的内容质量风险。

源码边界：完整十步运行早于最终数学/小节格式修正；固定B与最终确认在数学修正后、小节标题修正前。最后一处生产改动仅document-draft小节结构，原固定/live/conversation提示词静态适用性检查为0（`.local/eval-v22-final-evidence-summary.json`）；不能声称所有run使用完全相同字节。最终源码指纹另存`.local/eval-v22-closed-source.json`，保留先前指纹和全部运行。固定B/C证明两次9/9，最新格式分支由真实定向复测覆盖，不假称最新精确源码再完整跑两次。

最终后端全套560项：**559 pass / 0 fail / 1外部DB skip**，89448.7ms；tsc通过。fast `20261117-140541_scripted_quality-v22-layout-fast_bfffc8`：baseline12/12+security正样本4/4；两条负样本仍按设计被抓出。api-memory `20261117-140542_api-memory_quality-v22-layout-contr_c3ef4f`：business7/7、conversation3/3、旧工具跨日期回放1/1（另3条通道不适用）。这些验证契约，不计作真实Gemma成功率。前端本轮后续无改动，沿用v20的227/227、类型/构建通过记录，不说成最新重跑。

## 3. Gate、holdout及compare

v22原阈值Gate：**PASS**，候选固定B对照原live基线，留出live为`20261117-133337_live_quality-v22-holdout-live_863973`。五项逐字判定见`.local/eval-v22-gate.log`：

| 项 | 实际/阈值 | 结果 |
| --- | --- | --- |
| minPassRate | 1.000 ≥ 0.800（9计分例） | PASS |
| maxPassRateDrop | 相对+0.111；允许下降≤0.030 | PASS |
| holdout | 0.750 ≥ 0.700（4计分例） | PASS |
| hardCategory:security | 非探索失败0 | PASS |
| hardCategory:evidence | 非探索失败0 | PASS |

留出live **3/4**、另2项通道不适用；留出api-memory `20261117-133336_api-memory_quality-v22-holdout-api_39ee6c` **2/2**、另4项不适用。原始留出基线4/4，当前3/4是实际下降；虽满足原Gate仍有普通业务失败，未读其prompt或针对它修改实现。CLI仅在Gate阶段运行留出，没有降低阈值。比较`.local/eval-v22-compare.log`：固定集evidence50%→100%，其余目标类别100%保持，无固定集目标类别回归。样本9项置信度有限；Gate默认未配置货币成本/时延硬门槛，PASS不代表那些目标通过。

历史v20 Gate REJECT及旧失败日志保留；v21 Gate也已PASS，但彼时长任务仍无文件，见[v21记录](AGENT_STREAM_RECOVERY_20261117.md)。

## 4. Parity：有通过，也有明确未过线

`20261117-133440_live_quality-v22-parity-20261_bb5451`，对照既有真实UI事件，不是本次新采集UI，不覆盖最新平台部署：

- 单轮3b84：状态一致，工具顺序100%、参数hash50%、来源重叠83%、LLM请求差0，默认Parity **PASS**。原单轮来源100%，83%低于用户“不低于基线”的目标，不能只报PASS。
- 六轮8b8e：状态一致，工具序列60%低于原80%阈值，**FAIL**；工具集合25%，LLM请求少2、工具错误少1。人类旧记录为save_opportunity→4次save_to_inbox，新路径为save_to_inbox→list_inbox→2次save_to_inbox→update_inbox。已查明更正/定位路径及旧错误写入导致结构漂移，业务最终正确；保留失败，不放宽门槛、不重新刷人类基线。

## 5. 新增数据集及覆盖

全部先validate，均source=generated、exploratory=true，无自动晋升：

| 数据集 | 例/轮 | 覆盖 |
| --- | --- | --- |
| human-habits | 10/13 | 口语、短句、省略、错字、中英混写、多意图、催促、预览、纠错和重复 |
| conversation-long | 2/30 | 两段15轮、身份/约束累积、切换返回、最新更正 |
| long-horizon | 2/20 | 10个依赖步骤、计划/约束/重排、正文与三格式实物；使用用户材料，不是联网研究长报告 |
| stress-context | 4/4 | 长材料、冲突、预算、工具持续失败；STRESS-004工具故障注入不作真实网络证据 |
| memory-isolation | 4/8 | 同owner跨session隔离、身份/纠正与既有约束 |
| human-habits-time | 7/7 | 相对时间、时区、单双周等边界 |
| draft-delivery | 2/2 | 原失败长文末步实际原稿重放，有限结构/真实导出；非独立全长任务 |

共31例84轮，其中两例为交付阶段重放。原29例完整live批次`20261116-220854_live_quality-final-explorator_5775f2` **26/29=89.7%观察通过率**，三项原失败后来分别定向通过，但**没有把不同候选、不同批次拼接成新的29/29全批结果**。未人工晋升，新的“计分≥90%”目标尚不能判定通过。未新增可选multimodal，本轮不补说跨轮图片记忆已验证。

## 6. 未达标、风险与建议

1. **效率目标未达**：同9项均工具0.667→1.0，增长50%，超过≤20%。没有通过删必要来源读取来压工具数；应在人类核验来源/更正正确性的前提下分析调用预算。已核查固定B、最终交付重放和完整长任务逐task，同工具同规范参数最多1次，没有>3重复；这是这些实际trace的范围，不是全历史保证。
2. **性能/成本不能泛化**：两次固定均耗25.6/29.1秒低于63.7秒，但上游/网络/采样不同，不能说因果提速百分比；完整长任务仍13.5/16.2分钟。固定总tokens29015→29074/29038基本未降。costUsd=0是计价缺失，不是免费；KV命中/插件净节省未测。旧超时/断流记录保留，不能保证没有未来超时。
3. **内容质量仍不足**：文稿建议的离线域名后缀/时间自洽只能提供线索，不能确认活动真实；其表述仍过强。预算含X元占位或无真实价格依据的估值。文件能打开不代表可直接参赛提交。下一步应以人工选定的语义样本检验“事实、估值、未知”区分及来源诚实，不调整现有断言掩盖问题。
4. **覆盖仍有限**：真实Provider仅AMD Gemma；没有其他API Key兼容实测、云PG/RLS/连接恢复、本轮新UI、Word原生视觉、跨轮图片、人工审批后真实模型resume等结论。15轮两例与三个旧探索失败是定向证据，未取得最终统一大批≥90%计分证明；Parity来源下降/多轮FAIL、留出3/4仍需跟进。
5. **安全结论有范围**：窄Runtime请求拒绝不是通用安全审计；普通正文续写有一次/预算边界，不能证明任意长任务自动恢复。短引用只覆盖已有正文的创建，非跨轮任意文档版本编辑。

本轮证明了P0/P1、固定集稳定性及两项真实文稿交付能力；没有证明“普适多数模型”“接近通用Agent”或整体质量水位全部实现。建议后续先人工选取语义质量与Parity新基线，再做多Provider对照和效率优化；当前不扩大功能或发布。

## 7. 分支、未提交与运行状态

- 分支`codex/agent-evaluation-quality-20261116`；HEAD `94b475a4f60b5436578facf3bae0d9799185fdcf`。工作区原有大量未提交的视觉/评测/同事改动，本轮保持未提交，未整树stage、reset、清理或提交混合所有权内容。闭环记录后75条状态项，含新报告；以最终`.local/eval-v22-close-verification.json`为准。
- 本地main `060c09b028ed0750269a8e2e9905d35663346b05`、缓存origin/main `d22efc9905f72651e12f2920d8722fb2b54d477c`保持；没有fetch验证当前GitHub远端，因此不声称远端现状已刷新。本轮不push、不合并main、不改认证密钥、不写云端业务库，不启动WSL。
- 影子快照v20保留REJECT；v21保存自己的源代码after及失败长任务事实；v22保存最终源代码/文档及验证。没有把v22生产代码覆盖进v21历史快照。旧浏览器验收任务仍按原状态保留。
- 未重启日常5176/8788前后端、未从main构建部署；不能把Headless内存环境结果说成日常网页已运行最新后端。`.local/eval/<runId>`是本机实际产物路径（非附件早期示例的runs嵌套），被忽略的产物需本机查看，不保证出现在GitHub。
