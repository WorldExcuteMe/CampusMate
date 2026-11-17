# 模型接入与密钥运行配置

CampusMate的认证后端管理默认模型和用户自定义OpenAI兼容端点。API和Worker使用同一数据库、JWT验证配置及主密钥版本；仅静态前端不能持有用户API密钥。

## 默认模型

### DeepSeek 原生工具模式

官方 Chat Completions 使用请求 `tools` 和响应 `message.tool_calls`，不是把工具 schema 塞进聊天正文后执行 DSML 文本。参考 [官方 Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。确认实际端点后，可设置服务端 `LLM_CAPABILITIES={"tools":"native","reasoning":"deepseek_thinking","outputParameter":"max_tokens"}` 并重启 Runtime/Worker；不要仅凭模型名字推断兼容性。自定义连接可在设置中选择 `DeepSeek thinking + effort`。

Runtime 已按[官方文档](https://api-docs.deepseek.com/guides/thinking_mode/)接入 `thinking.type=enabled`、`reasoning_effort` 和 `reasoning_content` 回传。UI低/中/高对应官方 low/high/max；自动按任务阶段选择，输出预算不足时会在用量说明中明确报告降档。普通JSON和SSE响应均捕获不透明的思考上下文，原样保存到服务端checkpoint与会话消息的JSON envelope，完整恢复后继续工具轮次；无需SQL迁移。

这些字段仅用于同一端点/模型的协议续接：不混入聊天正文、进度delta、摘要或公开消息API，不向其他模型转发。旧非思考回复使用空字段标明无历史思考，不伪造内容。服务端按思考上下文实际长度计入窗口预算；压缩按完整消息/工具组进行，不截断仍保留的思考字段。不要手动设置 `thinking:false` 来代替协议修复。

如响应泄漏 DSML 内部标记，Runtime 会明确判为未完成，不从任意文本解析或执行工具；历史错误记录的 API/界面会显示协议异常，原始审计记录保留，绝不自动重放。

设置服务端`LLM_API_KEY`、`LLM_BASE_URL`和`LLM_MODEL`。API地址是Chat Completions路径的前缀，例如`https://gateway.example/v1`；运行时追加`/chat/completions`。显示名称默认取实际配置的模型ID，可用`LLM_DISPLAY_NAME`自定义。旧`builtin-deepseek`是兼容别名，不能表示模型厂商。

例如实际请求Gemma时应填写服务商给出的Gemma模型ID；不能仅修改显示名。聊天中的“最近返回”取上游响应`model`字段；缺失则未知，并不假定服务商实际运行了配置模型。

普通用户不需要填写接口能力。内置与自定义连接共用能力解析，Radeon官方`https://developer.amd.com.cn/radeon/api/v1`的`Gemma-4-31B-IT`自动采用原生工具、图片、SSE、`max_tokens`及`chat_template_kwargs.enable_thinking`契约，窗口262144；8192是本应用工作输出上限，非服务商硬上限声明。其他端点不因模型名称相同而套用这份规则。

`LLM_CONTEXT_LIMIT`和`LLM_CAPABILITIES`保留为运维覆盖配置，仅设置端点实际确认的值；未知字段由已知端点规则补齐。思考控制支持`reasoning_effort`、`enable_thinking`和上述Radeon嵌套开关；预算型参数需专用adapter。规则声明不代表当次服务在线或质量已验证，连接测试仍只验证文字连通。

聊天可选auto/low/medium/high；auto在规划/核验阶段允许high，常规阶段low，低输出预算会限制档位。端点未知则不发送思考控制，并说明原因。未知工具协议使用受限JSON回退，已知none不提供工具；未知图片能力允许向所选端点实际尝试，明确配置为不支持才本地拒绝，不静默丢图片或换模型。未知能力尚未实现完整的持久探测矩阵。

单次模型调用最多3个attempt，共用覆盖响应体与退避的deadline；浏览器不再叠加重试或偷偷切备用端点。输出截断/断流会保留草稿并暂停；预算暂停需要明确调整后恢复。观测保留requestId、attempt、TTFT、总时长、停止原因、前缀/schema指纹及nullable用量。缺失cache/reasoning不当作0，reasoning已包含在output时不重复加总；未知价格时USD费用未知。原图pts无法直接换算成美元。

## 自定义密钥

先为服务端配置`PROVIDER_MASTER_KEY`：32随机字节的base64或64字符hex。使用密码管理器或受控密钥生成器生成，API和Worker保持一致，不能放入任何`VITE_`变量、前端配置、提交、日志或用户聊天。

后端从`backend/.env`或部署环境读取配置，参考`backend/.env.example`；数据库环境见`docs/CLOUD_RUNTIME_SETUP.md`。登录后只需填写公开HTTPS地址、模型ID和API密钥，连接ID自动生成，显示名可留空；页面展示能力状态及规则来源，不要求手选底层参数。编辑密钥留空保留原值，移除凭证是独立按钮；测试连接会向相应模型发一个小文本请求。

AES-256-GCM密文包含版本、随机nonce、认证tag和密文。AAD绑定用户/供应商/版本；密文不能复制给其他用户或配置使用。缺主密钥时保存新密钥返回明确错误，没有明文回退。列表、Task快照和事件只含hasKey或非敏感配置。遗留开发代理不再接受新明文密钥写入；已有本地开发配置不会自动上传。

轮换时设置新`PROVIDER_KEY_VERSION`和新`PROVIDER_MASTER_KEY`，在`PROVIDER_DECRYPTION_KEYS`中暂存仍需读取的旧版本键。移除旧键前必须完成受控重加密/重新录入并验证，不因修改环境变量就宣称全部旧数据已完成轮换。丢失主密钥无法恢复密文。

## 任务与网络行为

任务接受时保存不含凭证的配置快照及版本指纹，Worker只解析任务owner的凭证。编辑模型、地址、能力或密钥后，旧排队任务会提示配置变更并要求新消息提交，不悄悄切换上游；网络重试仍返回原已接受轮次。

用户提供的端点仅允许公开HTTPS地址，不接受URL内凭证、查询参数或片段。连接阶段校验DNS地址并使用该结果建立TLS，不跟随携带Authorization的重定向。服务端默认端点由运维配置，允许本机开发网关；公开列表仍不允许URL内密钥。

纯开发模式可以读取原代理默认模型，但自定义密钥的新增/编辑需认证后端。原生Anthropic/Gemini协议当前不可选，不能把其API Key当作OpenAI兼容接入保证。

## 当前验证边界

自动回归使用固定响应验证owner、路由、异常和预算边界；真实云Supabase的持久化/重启/RLS另有实测记录。用户已授权使用现有Gemma API调优，2026-11-15真实图片读取、搜索调用及高校通知抓取均已完成实测，完整任务结论与当前验收见`docs/MODEL_TOOL_RECOVERY.md`。尚未验证其他Key/网关、原生其他协议、独立多进程生产部署或真实KV收益，不能据单个端点通过外推。
