export function cleanGroupMessage(raw: string): string {
  let text = raw;
  // 去掉 QQ/微信导出常见行首时间戳与发送者
  text = text.replace(/^\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(:\d{2})?\s*/gm, "");
  text = text.replace(/^\s*[\u4e00-\u9fa5A-Za-z0-9_（）()]{1,20}[:：]\s*/gm, (m) =>
    /通知|公告|提醒|老师|辅导员|班长/.test(m) ? m : "",
  );
  // 去掉 @提及、引用块、表情占位
  text = text.replace(/@[\u4e00-\u9fa5A-Za-z0-9_]+\s*/g, "");
  text = text.replace(/\[(表情|图片|动画表情|文件|语音)\]/g, "");
  text = text.replace(/^.*引用.*$/gm, "");
  // 归一空白
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

export function dedupKey(text: string): string {
  const norm = cleanGroupMessage(text).replace(/\s+/g, "").slice(0, 200);
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return `dq-${h}`;
}
