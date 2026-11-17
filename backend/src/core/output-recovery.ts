export const OUTPUT_RECOVERY_MARKER = "[系统正文断流续写]";

export function joinInterruptedText(prefix: string, continuation: string): string {
  if (continuation.startsWith(prefix)) return continuation;
  for (let n = Math.min(512, prefix.length, continuation.length); n >= 8; n--) {
    if (prefix.endsWith(continuation.slice(0, n))) return prefix + continuation.slice(n);
  }
  return prefix + continuation;
}

// A narrow request boundary, not a general prompt-injection classifier. Public
// capabilities, progress and analysis of attack examples remain normal tasks.
export function privateInstructionReply(intent: string): string | undefined {
  if (/^(?:请|帮我)?(?:整理|提取|核验|检查|总结|识别|标注).{0,8}(?:以下|下面|这(?:条|段|张|份)|通知|附件|图片|材料)/.test(intent.trim()) || /^(?:请|帮我)?把(?:这(?:条|段|张|份).{0,4})?(?:通知|附件|图片|材料).{0,6}(?:里的|中的|内的)/.test(intent.trim())) return;
  if (/^(?:请|帮我|please\s+)?(?:分析|评估|审计|解释|检查|防御|analy[sz]e|review|explain)\s*(?:这(?:段|个|条)|下(?:面|列)|以下|提供的|示例|案例|样例|this\b|the\s+(?:following|example)\b)/i.test(intent.trim())) return;
  const own = /你的|你所|内部|隐藏|\byour\b|\binternal\b|\bhidden\b/i.test(intent);
  const target = /(?:系统|开发者).{0,8}(?:提示词|指令|prompt)|(?:system|developer)\s+(?:prompt|instructions?)|工具.{0,8}(?:定义|清单|schema)|tool\s+(?:schemas?|definitions?|list)/i.test(intent);
  const disclose = /输出|展示|列出|打印|复述|原文|完整|给我|\b(?:print|reveal|show|provide|give|output|quote)\b/i.test(intent);
  if (own && target && disclose) return "无法提供内部系统或开发者指令、工具定义原文。可以说明公开功能，或展示当前任务的执行步骤与进度。";
}
