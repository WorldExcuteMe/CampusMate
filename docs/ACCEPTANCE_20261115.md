# CampusMate 本地交付与验收记录

日期：2026-11-15。分支：`codex/campusmate-reliability-experience`。范围为已批准Spec v2的T1–T10；用户召回子代理后，由主代理独立完成后续实现、集成、检查与本地提交。没有push、发布、生产数据库迁移或付费模型调用。

## 本轮可使用的能力

- 会话在服务端按用户/会话/轮次存储，保留直接身份陈述、最新纠正和配对工具消息；窗口输入量与累计用量分开。旧本地历史保留，新提交映射到UUID，不自动上传旧聊天。
- 默认模型来自实际服务端配置；BYOK可配置OpenAI Chat Completions兼容端点。密钥经认证后端AES-GCM加密保存，空值编辑保留原密钥。配置模型与上游返回模型分别展示，能力未知时不猜测。
- 工作台显示真实阶段、工具调用、耗时、来源、正文流和检查结果，刷新后续订，断流后补拉。取消、审批、预算与材料不足有对应状态。失败任务已有后续对话时，恢复返回409并提示用新消息继续，原记录保留。
- 日历使用学期时区和具体日期投影，支持单双周、停课/调课源目标及学校校区作息。CSV/ICS/XLSX先预览再确认，追加幂等。Today消费同一批课程。未知/错误数据不推断全天空闲。
- 竞赛策划书按资料→提纲→逐章正文→检查→最多一次修订→交付执行，检查点可恢复；只有短答、缺章、无效引用、未解决工具失败或预算暂停时不标完整成功。通用受限文档工具可保存正文、列表、表格、图片、图表与引用。
- 同一版本可授权预览并下载真实MD/DOCX/PDF，服务端重开文件核对内容，下载字节与源AST分别有哈希。缺少打印环境会明确限制格式。运行依赖见[DOCUMENT_RUNTIME.md](DOCUMENT_RUNTIME.md)。
- Inbox采用暖白、紫蓝、青绿与珊瑚的列表/预览设计；手机用详情弹层，日历采用周网格及移动日视图。已有暗色偏好保留；未保存偏好默认明亮主题。

集成阶段另修复：登录页面开始查询前同步切换数据源；身份变化清空查询缓存，同一身份刷新token保留缓存；日历查看其他周不会清空今天的下一项安排；移动通知预览关闭后焦点返回原通知。

## 最新验证结果

所有闸门串行执行，退出码均为0。实际命令使用`C:\Users\Asus\.codex\workbuddy\bin\node.exe`，PowerShell使用`C:\Users\Asus\AppData\Local\Programs\PowerShell\7\pwsh.exe`。下表中的`node`代表上述实际二进制。

| 检查 | 最新结果 | 仓库外日志 |
| --- | --- | --- |
| 后端TypeScript | 无诊断 | 本轮命令输出 |
| 后端全部本地测试，排除需显式隔离DB的入口 | 256 pass / 0 fail / 0 skip | t8-backend-full.log |
| 完整显式迁移清单 | 七份全部应用；16 pass / 0 fail；MIGRATION_VALIDATED | t8-migrations.log |
| 前端TypeScript | 无诊断 | 本轮命令输出 |
| 前端Vitest | 34文件，131 pass / 0 fail | t8-web-full.log |
| Vite生产构建 | 通过；仍有既有大chunk/mock动态导入提示 | t8-build.log |
| Demo浏览器回归 | 5 pass | t8-demo-e2e.log |
| API/Worker/文档浏览器集成 | 5 pass | t8-runtime-e2e.log |
| 外部PostgreSQL默认入口 | 1 skip / 0 fail，未连接数据库 | t8-external-db-skip.log |

日志根目录：`C:\Users\Asus\CodeBuddy\campusmate-evidence`。最终浏览器截图/下载文件备份在`t8-browser-accepted/`，便于查看的副本为`t8-inbox-light-1440.png`、`t8-inbox-dark-390.png`、`t8-calendar-light-1440.png`和`t8-calendar-dark-390.png`。这些均为明确离线夹具，不是真实学校通知。

浏览器集成经过真实产品API、JWT验证、ProviderService、OpenAI兼容序列化/解析、Worker、事件、检查点及文档渲染。认证/PostgREST、模型回复和网页正文是脚本夹具，服务仅监听127.0.0.1；不读取用户.env或外部凭证。测试中间曾因夹具遗漏PostgREST的accept-profile CORS头而失败，已补齐后重新通过，未降低生产鉴权或网络检查。

五项运行时浏览器用例覆盖：

1. 第一轮身份→第二轮推荐读取已有身份→high思考参数真实传递→资料工具事件→刷新未完成任务→七章各执行一次→完整文档预览→三格式真实下载与字节哈希；私密reasoning字段不出现在页面；另一owner下载被拒绝。
2. CSV预览时存储仍为空，确认后仅一条课程；Calendar和Today一致，刷新保留。
3. 取消得到真实cancelled记录；故障任务失败后可发新消息；旧任务恢复409且记录不被改写，刷新可查看取消记录。
4. UI新增BYOK→连接测试→设为默认→任务使用自定义modelId；真实返回模型单独显示，列表不含明文或密文凭证。
5. Inbox/Calendar在390/768/1440、light/dark组合均无页面横向溢出；周表内部可滚动；窄屏弹层Escape关闭并回焦。保存12张对应尺寸/主题截图。

## 验收条件映射

这里的“通过”均指本地代码/夹具范围。每个任务子规格保留红→绿过程及更细的边界证据。

| 条件 | 本地证据 | 外部边界 |
| --- | --- | --- |
| AC01 身份连续使用 | worker-session、sessions-api及浏览器身份→推荐 | 真实模型理解质量未验证 |
| AC02 压缩/纠正/重建 | session-context、agent-loop-context、worker-session/PGlite | 生产多进程崩溃恢复未验证 |
| AC03 UUID及旧会话 | sessions/sessions-context/API测试 | 未自动上传旧浏览器历史 |
| AC04 共享存储 | 独立context/PGlite重建、storage/shared-state | 真实Postgres/Supabase RLS未验证 |
| AC05 模型路由与显示 | provider-routing及BYOK浏览器 | 原生Anthropic/Gemini协议未实现 |
| AC06 密钥与owner | credentials、provider-routing、storage及浏览器跨owner拒绝 | 生产主密钥运维/轮换未执行 |
| AC07 真实工具事件/断流 | worker-events、stream、api-client、工作台浏览器 | 公网弱网络仍需实测 |
| AC08 刷新/取消/恢复 | task-state、worker恢复/审批及浏览器 | 已发生的外部副作用不能撤销 |
| AC09 日期与未知数据 | calendar-grid、calendar-storage、CalendarPage | 学校原始数据正确性未验证 |
| AC10 三格式导入与同步 | schedule-import、calendar-api；CSV浏览器闭环 | 不支持的ICS复杂规则会报错 |
| AC11 不把短答当完成 | proposal-delivery、worker-evaluator及UI状态 | 结构检查不代表语义/事实全正确 |
| AC12 版本/引用/MD | proposal-delivery、artifacts及三格式浏览器 | 网页取得不等于独立事实核验 |
| AC13 分章恢复/有限修订 | proposal-delivery的中断/重建/修订上限 | 外部未知副作用不盲重试 |
| AC14 视觉和键盘 | T7实际浏览器预览；T8三宽两主题/回焦截图 | 仍可持续收集真人使用反馈 |
| AC15 分层报告 | 本文与完整日志 | 不用脚本通过冒充真实模型成绩 |
| AC16 稳定前缀/大输出 | llm-policy、worker-llm-policy、context相关测试 | 真实KV命中和成本收益未知 |
| AC17 usage/retry/流式 | llm-policy、llm、provider-http等fixture | 未确认价格时USD未知 |
| AC18 思考控制 | generation-policy、Worker/UI测试；浏览器high透传 | thinking_budget尚未专门适配 |
| AC19 作息与time table | calendar-grid/导入/存储；T7丰富课表预览、T8尺寸检查 | 不猜测本校节次或跨校通勤时间 |
| AC20 实际DOCX/PDF | document-export/文件复读；Word和产品PDF逐页QA；浏览器下载 | LibreOffice未安装，未声称兼容性通过 |

T10额外排版样本包含中文长文、42行跨页表格、图像、图表、特殊字符和引用。本机Word16.0导出5页、产品Chromium PDF5页，10页逐页检查无截断/重叠/缺字。对应样本和逐页图在`t10-document-qa-v3/`。产品PDF字体已校验并子集嵌入；DOCX阅读器可能按自身字体环境改变分页。

浏览器下载的策划书是脚本验收样例，非正式参赛文稿：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| t8-proposal.md | 6750 | 408881064a599d24af1284c3a7b81528046f42b806dbb42d2accaba60dbd7fcd |
| t8-proposal.docx | 11288 | 8d2866bd7b14f4981608ef63bdace1c02c4e01b673f21e3045733d55847684d0 |
| t8-proposal.pdf | 255496 | f3011c82d885b05166cfeea608b31281146c993aca73499b8408257046cad86b |

## 对补充问题的评估与下一步

用户截图的68次调用、45.13% KV命中只描述那组上游观测，不能单独判断Agent效率。当前已稳定规则/工具前缀，把时间、状态和当前问题放在动态后段，控制历史、摘要与工具正文长度，同时统一输出预算、超时、重试与流式反馈。未用前缀哈希一致声称缓存命中提升。下一次真实基准应固定同一组多轮任务、模型配置与输入规模，对比缓存读/总输入、总token、首字/总耗时、重试、完成率及文件合格率；上游缺数据就记未知。

高校周网格适合看课程密度、冲突和节次，因此桌面保留这种熟悉结构；小屏默认日视图，周视图在表内滚动。用低饱和稳定课程色、留白和清楚的时间/教室层级，避免参考图中长文字挤满卡片和“非本周”灰块干扰忙闲判断。作息来自用户学校/校区模板，不硬编码全国统一节次。

思考强度已开放auto/low/medium/high，auto在规划/核验阶段可选high；不足的输出预算会限制档位。只向已确认的端点发送适用参数，开关型接口显示实际on/off，未知保持受限。高思考不能替代工具结果核对或保证长文质量。

Word/PDF无需先给任意宿主终端，当前可信文档工具已能交付这两种格式。数据分析、实验、绘图和批处理才更需要隔离计算后端。评估及拟接入契约见[COMPUTE_ASSESSMENT.md](COMPUTE_ASSESSMENT.md)，本轮没有部署沙箱或给模型开放任意宿主执行。

后续优先做真实模型同题对照和隔离Postgres/Supabase环境验收，再用学生实际任务校准写作、信息判断和等待体验；是否接入云计算后端由真实分析任务与部署环境决定。以上外部验收均未自动执行。

## 复现入口

依赖使用两侧锁文件安装，文档测试需安装匹配Playwright的Chromium，详见运行清单。Windows命令应使用上文真实Node路径。

```powershell
# cwd backend，测试不读取.env；外部PG入口另行显式授权
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
$testPaths = @(rg --files src tests -g '*.test.ts' | Where-Object { $_ -notlike '*postgres-integration.test.ts' })
node --test --test-force-exit --test-concurrency=1 @testPaths
node scripts/validate-migration.ts
# cwd web，按序执行
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run
node scripts/build.mjs
node node_modules/@playwright/test/cli.js test -c playwright.config.ts
node node_modules/@playwright/test/cli.js test -c playwright.integration.config.ts
```

两个E2E配置自行启动无.env的本地服务，不复用开发服务。测试输出默认系统临时目录，可通过`CAMPUSMATE_E2E_OUTPUT`指定独立的仓库外证据目录。CI已接线并按顺序运行，保留浏览器证据；本轮没有触发远端CI。
