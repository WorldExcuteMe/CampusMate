# 模型接入与密钥运行配置

CampusMate的认证后端管理默认模型和用户自定义OpenAI兼容端点。API和Worker使用同一数据库、JWT验证配置及主密钥版本；仅静态前端不能持有用户API密钥。

## 默认模型

设置服务端`LLM_API_KEY`、`LLM_BASE_URL`和`LLM_MODEL`。API地址是Chat Completions路径的前缀，例如`https://gateway.example/v1`；运行时追加`/chat/completions`。显示名称默认取实际配置的模型ID，可用`LLM_DISPLAY_NAME`自定义。旧`builtin-deepseek`是兼容别名，不能表示模型厂商。

例如实际请求Gemma时应填写服务商给出的Gemma模型ID；不能仅修改显示名。聊天中的“实际返回”取上游响应`model`字段；缺失则未知，并不假定服务商实际运行了配置模型。

`LLM_CONTEXT_LIMIT`和`LLM_CAPABILITIES`仅填写该服务端点文档确认的能力。例如工具`native/json/none/unknown`、图片`true/false/unknown`、思考参数族`reasoning_effort/enable_thinking/thinking_budget/none/unknown`。连接测试只验证文本请求，不自动推断工具、视觉、思考和窗口。T9继续实现这些能力的完整调用策略。

## 自定义密钥

先为服务端配置`PROVIDER_MASTER_KEY`：32随机字节的base64或64字符hex。使用密码管理器或受控密钥生成器生成，API和Worker保持一致，不能放入任何`VITE_`变量、前端配置、提交、日志或用户聊天。

后端当前从`backend/.env`或部署环境读取配置，参考`backend/.env.example`；生产数据库迁移和部署须单独执行，本轮未运行远程操作。登录后在设置页填连接ID、显示名、公开HTTPS地址、模型ID和API密钥。编辑密钥留空表示保留，移除凭证是独立按钮；测试连接由用户主动触发并会向相应模型发一个小文本请求。

AES-256-GCM密文包含版本、随机nonce、认证tag和密文。AAD绑定用户/供应商/版本；密文不能复制给其他用户或配置使用。缺主密钥时保存新密钥返回明确错误，没有明文回退。列表、Task快照和事件只含hasKey或非敏感配置。遗留开发代理不再接受新明文密钥写入；已有本地开发配置不会自动上传。

轮换时设置新`PROVIDER_KEY_VERSION`和新`PROVIDER_MASTER_KEY`，在`PROVIDER_DECRYPTION_KEYS`中暂存仍需读取的旧版本键。移除旧键前必须完成受控重加密/重新录入并验证，不因修改环境变量就宣称全部旧数据已完成轮换。丢失主密钥无法恢复密文。

## 任务与网络行为

任务接受时保存不含凭证的配置快照及版本指纹，Worker只解析任务owner的凭证。编辑模型、地址、能力或密钥后，旧排队任务会提示配置变更并要求新消息提交，不悄悄切换上游；网络重试仍返回原已接受轮次。

用户提供的端点仅允许公开HTTPS地址，不接受URL内凭证、查询参数或片段。连接阶段校验DNS地址并使用该结果建立TLS，不跟随携带Authorization的重定向。服务端默认端点由运维配置，允许本机开发网关；公开列表仍不允许URL内密钥。

纯开发模式可以读取原代理默认模型，但自定义密钥的新增/编辑需认证后端。原生Anthropic/Gemini协议当前不可选，不能把其API Key当作OpenAI兼容接入保证。

## 当前验证边界

API→存储→真实Worker使用本地假上游验证owner、路由和密钥边界；PGlite验证SQL读写。未调用真实付费模型，未验证生产Supabase RLS、多进程PG、服务网关真实能力或缓存收益；这些不能由本地通过结果代替。
