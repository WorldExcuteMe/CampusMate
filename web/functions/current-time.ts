// 统一的权威时间上下文：所有模型通道在每轮注入，避免模型用训练记忆猜日期。
export function beijingTimeContext(at: number = Date.now()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "long",
  }).formatToParts(new Date(at));
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const time = `${pick("hour")}:${pick("minute")}:${pick("second")}`;
  return [
    `【权威当前时间】北京时间 ${date} ${time}（${pick("weekday")}，Asia/Shanghai）。`,
    "这是系统时钟提供的唯一权威时间：不要依据训练记忆推断“今天/现在/最近/即将”；涉及竞赛报名截止、未来活动等时效信息时，必须以此时间为基准，并优先调用检索/抓取工具核验来源；无法核验就明确标注“未核实”，不得编造日期。",
  ].join("\n");
}