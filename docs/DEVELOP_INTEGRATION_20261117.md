# develop集成记录 · 2026-11-17

状态：本地整合及原质量Gate验证完成，准备交由GitHub最终CI/合并；远端后续状态以最终整合PR及本机闭环证据为准。授权与验收见[规格](specs/develop-integration-20261117.md)。

- 当前本地质量分支从94b475a开始，含此前持久化/模型工具/云连接/真实来源修复；现有未提交评测与质量改动一并按路径审查上传。
- 远端develop8be87af，main d22efc9；历史codex/integrate-pr5-main-20261115和codex/fix-release-permissions-20261115已在develop。
- 同事fork PR9新增附件/会话分页/草稿/业务持久化等，与本地部分实现重叠；在独立worktree解决并验证，不直接影响用户正在使用的5176/8788。
- main、云数据库/认证与本地运行配置不在本轮发布范围。TokenEconomizer本机配置和真实API密钥不上传。

## 已完成的上传与冲突选择

当前质量工作已提交并推送为`6f7c377d0e182a1b617241ea6bf7260c3cc494df`，共123个相关路径。私有配置精确值与常见凭据格式扫描无命中；holdout只按路径/hash纳入，不读取其prompt。原工作区的一字节异常文件`backend/{console.log('base`排除并保留；未上传.local、env、依赖、截图或本机插件配置。安全扫描仅是发布前有限检查，不是完整安全审计。

集成分支`codex/integrate-pr9-develop-20261117`在独立worktree合并同事`dad04a143a6bc8a2f215982ae3efd18816190812`，共25个冲突文件；保留两方提交祖先，不批量选ours/theirs：

| 重叠 | 选择与整合 |
| --- | --- |
| 通知保存 | 保留CampusRecords的原文、原id更正、list/update及用户预览保护；接纳PR9旧summary-only/null日期契约，并要求非空原文或摘要。业务工具定义不重复 |
| 日常待办/目标/合并通知 | 吸收PR9 Postgres事务、owner/任务所属检查；实际入口均传businessStore；错误不能靠模型口头成功覆盖 |
| 检索 | 共用PR9的链接解包、属性/实体解析与site边界；保留本地具名/泛类目相关性和一次有界精确主题回退。修复最简h2位于响应开头被split漏掉的兼容缺陷 |
| LLM流式/思考 | 保留Gemma能力自适应、单system、进度/空闲时限、工具index/ID与一次只读断流恢复；接纳DeepSeek同provider/model绑定的私有思考续传，API/UI不展示内部续传内容 |
| 工具失败恢复 | 保留缺失旧错误计数、必读来源及公开来源替代限制；接纳同参数真实成功重试恢复，避免两条恢复路径重复减错，未知/不确定写入仍失败 |
| 会话/图片 | 吸收分页、版本/墓碑、草稿CAS与附件限制；保留Worker按当前session取文本和显式按owner载图，避免重载全账号历史图片 |
| UI与设置 | 保留无需填写接口能力、自动ID、链接中文边界及旧任务恢复约束；吸收消息编辑/复制、DeepSeek状态、分页版本去重 |
| 测试 | 两份同名新增检索/工具协议测试分别保留，未删旧断言；新增3项集成回归。PR9原CI失败记录保留，不假称其旧检查已通过 |

PR9旧CI run `43821984637`失败于空增量缓存写入断言；本机原单例9/9，未复现该次时序，但源码中游标变化确会触发整段缓存写入。现加持久内容指纹，游标仅变不重写缓存，内存水位照常推进；重载后允许从较旧水位幂等重取，非丢弃新消息或降低测试标准。

浏览器整合回归首次Demo26/26、Runtime5/6。唯一失败是旧E2E等待已按用户选择隐藏的“恢复任务”按钮；当前单测明确要求失败任务已有后续轮次时隐藏按钮并提示新消息，二者不能同时成立。对齐E2E的触发方式：新增隐藏恢复/显示新消息入口和提前说明的断言，改以直接HTTP调用保留原409、错误原因及旧任务仍failed的检查；取消记录刷新断言保持。没有改Agent数据集、负样本、required或Gate，不能把这个明确契约更新写成“所有测试从未调整”。

DeepSeek协议核对：[官方thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)，2026-11-17：工具多轮须回传reasoning_content，effort支持low/high/max；合并保留已有显式能力选择，不据模型昵称给未知第三方端点添加能力保证。此文档查证不是新Key真实兼容测试。

## 验证状态

第一轮后端596项：589 pass、6 fail、1外部DB skip，保留`.local/backend-integrated-first.log`。上述兼容修复后定向41/41；新增Inbox契约回归先RED（rawText必填错误）再GREEN。原消息分类回归24/24。全量验证、远端CI及最终合并状态待实际收集后补齐。

当前本地验证：后端599项=598 pass/0 fail/1外部DB skip（86.2秒）；其后仅增加预览失败提示前缀，api-memory完整回归11/11，类型再次通过。最终精确源码还须远端后端CI重跑。前端301/301、类型/生产构建与Deno Function检查通过；Demo浏览器26/26、Runtime浏览器6/6，含80轮分页及真实下载路由/文件字节（模型为脚本，不代表Gemma能力）。全部12份显式迁移在临时PGlite应用，16/16检查；DOCX/PDF沙箱真实导出/复读自检通过。

- fast：`20261117-195258_scripted_develop-integrated-fast_06a06f`，baseline12/12+security正样本4/4；2负样本仍按原设计被捕获。
- business/conversation/replay：`20261117-195359_api-memory_develop-integrated-previ_d702d6`，11/11；此前BUS-005因PR9通用业务失败信息覆盖了预览说明而10/11，失败保留，修复只补充准确预览上下文，不改状态或断言。
- 原30任务benchmark通过。源代码/私密精确值和常见凭据格式扫描107个整合路径无命中；holdout提示词未查看，以下仅通过CLI在Gate阶段运行。
- 新整合真实Gemma：`20261117-195958_live_develop-integrated-real_21a27a`，固定live9/9+真实conversation3/3，另3项通道不适用；均耗47.1秒、均工具1.0、总67539 tokens。CONV-006三轮200.4秒、最终Inbox1条；这是新整合一次完整实跑，不冒充该字节版本已连续两次通过。LIVE-007为Runtime规则0模型请求，LIVE-009预期失败仍按原检查通过；12/12表示符合预期，不表示所有任务均为succeeded。费用仍缺真实计价，costUsd=0不表示免费。
- 新留出：api-memory `20261117-200651_api-memory_develop-integrated-holdo_5af23b`2/2；live `20261117-200652_live_develop-integrated-holdo_581c7d`3/4（普通Inbox副作用检查仍失败），未读取或针对其内容修改实现。原阈值Gate五项PASS：minPassRate1.0≥0.8、相对+0.111/允许下降0.03、holdout0.75≥0.7、security与evidence非探索失败0。留出非全过，整体质量缺口仍保留。
- compare中原固定目标类别无回归；本次候选额外包含3条conversation，原基线没有这些条目，不能把它们的0%→100%或合并均耗当同样本性能提升。既有Parity/工具次数增长及文稿语义风险未被本次合并自动消除。

## 升级边界

需按顺序应用3个加性迁移再更新运行服务：`20261115090000_campusmate_business_tools.sql`、`20261115110000_campusmate_session_management.sql`、`20261116090000_campusmate_history_paging.sql`。本轮只在临时PGlite验证，不自动迁移云端，不替用户部署。现有真实模型报告对应合并前候选；新整合必须单列测试结果。

fork `coco38622/CampusMate`当前仅pull权限、无push/admin；本轮可合并其提交，不能替其拥有者删除fork分支。主仓库与本地可清理分支须在合并后逐一证明是develop祖先，main/develop保留。最终清单将在实际操作后补齐。
