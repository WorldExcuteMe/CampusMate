export type ReasoningPreference = "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type GenerationStage = "plan" | "verify" | "write" | "simple" | "summary" | "extract";
// 推理档位：与 AMD Radeon Cloud（reasoning_effort）实测枚举一致；none/关闭档通过能力声明的 reasoning="none"
// 表达（即不发送思考参数），不在此列表里伪造一个会被服务端拒绝的档位。
const EXPLICIT_REASONING_TIERS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const HIGH_TIERS = new Set(["high", "xhigh", "max"]);
export function stageForIntent(intent: string): GenerationStage {
  const action = intent.replace(/“[^”]*”|《[^》]*》|【[^】]*】/g, "");
  const writing = /正文|格式|排版|导出|分工表|进度表/.test(action);
  const preview = /只.{0,8}(?:预览|提纲|大纲)|(?:等我|待我)确认|(?:下一轮|下一条).{0,10}(?:写|生成|保存)|(?:不要|不|勿)(?:写入|保存)(?:到任何|任何|[，。；！？\s]|$)/.test(action);
  if (preview) return writing ? "write" : "simple";
  if (/(?:列|说明|解释|介绍).{0,16}(?:风险|核验(?:规则|方法|流程))/.test(action)) return "simple";
  if (/(?:核验|核对|验证|审查|检查)(?:一下|下|这个|这条|这张|该|以下|提供的|材料|来源|活动|代码|事实)/.test(action)) return "verify";
  if (writing) return "write";
  if (/核验|矛盾|检查|验证|审查/.test(action)) return "verify";
  if (/策划|规划|方案|计划书|研究报告|复杂|推导|代码/.test(action)) return "plan";
  return "simple";
}
export function stepResponseInstruction(intent: string): string | undefined {
  if (/正文|长文|导出|生成.{0,8}(?:文档|文件)|Word|PDF|详细|全面|至少.{0,8}字|不少于.{0,8}字|\d+\s*[-–至到]\s*\d+\s*字/i.test(intent)) return;
  if (!/(?:第[一二三四五六七八九十\d]+步)|先列.{0,8}(?:需求|提纲|步骤)|(?:列|说明|解释|介绍).{0,16}核验(?:规则|方法|流程)/.test(intent)) return;
  return "【本轮步骤范围】只完成用户这轮提出的小步骤，总计不超过300字；提纲用简短条目，表格只填关键字段，不重述此前全文，不抢跑后续阶段。方案标建议，预算标估算。没有权威材料且不联网时只能提取声明、列出核实路径和未知，名称/命名模式、域名外观、水印及时间自洽不能确认真实性；拟建白名单或工具不得说成已存在。";
}
export function generationPolicy(caps: Record<string, unknown>, preference: string | undefined, stage: GenerationStage, outputTokens: number) {
  const explicit = (EXPLICIT_REASONING_TIERS as readonly string[]).includes(preference ?? "");
  const requested = preference === "auto" || explicit ? preference! : "auto";
  let tier = stage === "summary" || stage === "extract" ? "low" : requested === "auto" ? (stage === "plan" || stage === "verify" ? "high" : "low") : requested;
  const constrained = outputTokens < 1024 && HIGH_TIERS.has(tier);
  if (constrained) tier = "medium";
  const family = String(caps.reasoning ?? "unknown");
  const deepseekTier = tier === "low" || tier === "minimal" ? "low" : tier === "medium" ? "high" : "max";
  const off = tier === "low" || tier === "minimal";
  const toggle = family === "enable_thinking" || family === "chat_template_kwargs";
  const params: Record<string, unknown> = family === "deepseek_thinking" ? { thinking: { type: "enabled" }, reasoning_effort: deepseekTier } : family === "reasoning_effort" ? { reasoning_effort: tier } : family === "chat_template_kwargs" ? { chat_template_kwargs: { enable_thinking: !off } } : family === "enable_thinking" ? { enable_thinking: !off } : {};
  const effective = family === "deepseek_thinking" ? deepseekTier : family === "reasoning_effort" ? tier : toggle ? (off ? "off" : "on") : null;
  const reason = effective === null ? "端点未确认可调参数，未发送思考控制" : family === "deepseek_thinking" ? "DeepSeek低/中/高档位映射为low/high/max；minimal与low等效，阶段与输出预算约束保持" : family === "reasoning_effort" ? "按端点 reasoning_effort 枚举发送所选档位（含 xhigh/max），阶段与输出预算约束保持" : stage === "extract" ? "图片声明提取采用轻量输出，后续核验保留用户思考偏好" : stage === "summary" ? "材料摘要阶段使用轻量输出；研究、规划和复杂写作保留用户思考偏好" : constrained ? "输出预算不足，限制思考档位" : toggle ? "接口仅支持思考开关" : requested === "auto" ? `按${stage}阶段选择` : "采用用户偏好";
  return { requested, effective, family, stage, reason, params };
}

export function researchDeliveryInstruction(intent: string): string | undefined {
  const research = /检索|文献|研究|查找.{0,12}(?:来源|资料)|\b(?:research|literature|academic articles|scholarly)\b/i.test(intent);
  const file = /\.(?:docx|pdf|md)\b|\b(?:word document|pdf file|markdown file)\b|(?:生成|导出|交付|保存).{0,12}(?:文档|报告|Word|PDF)/i.test(intent);
  const readOnly = /(?:不要|不必|无需|勿)(?:联网|搜索|写入|保存|导出)|仅.{0,5}(?:预览|提纲|大纲)|\b(?:do not|don't) (?:browse|search|write|save|export)\b/i.test(intent);
  if (!research || !file || readOnly) return;
  return "【研究文档交付】按用户的证据和格式要求做小规模检索。查学术正文入口时可用 web_search 的 scholarly 范围和 openAccessOnly。每批检索有合适候选时，下一步查阅来源，避免在未读候选堆积时继续搜索。独立来源可同轮发起多个读取。落地页不可读时可尝试同一作品的 alternativeUrl，每个失败地址用一次。随后按证据缺项补查，为编写、核对和导出预留时间。只引用真实读到的证据，注明证据缺口。文档通过可用文档工具保存并导出。";
}
