// 无自动重连、无 Agent 循环；供服务端探针或已鉴权的事件消费层复用。
export interface CloudStreamEvent extends Record<string, unknown> { type: string; id?: string }

// 浏览器视图使用字段白名单；不转发工具参数/输出、错误正文、思考原文或未知事件的载荷。
export function publicCloudEvent(event: CloudStreamEvent): CloudStreamEvent {
  const view: CloudStreamEvent = { type: event.type, ...(event.id ? { id: event.id } : {}) };
  const short = (value: unknown, max = 200) => typeof value === "string" ? value.slice(0, max) : undefined;
  if (["user.message", "agent.message"].includes(event.type)) {
    let truncated = Array.isArray(event.content) && event.content.length > 32;
    view.content = Array.isArray(event.content) ? event.content.slice(0, 32).flatMap(block => {
      if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return [];
      if (block.text.length > 16_000) truncated = true;
      return [{ type: "text", text: block.text.slice(0, 16_000) }];
    }) : [];
    if (truncated) view.contentTruncated = true;
  } else if (event.type === "agent.tool_use") {
    view.name = short(event.name, 80);
  } else if (event.type === "agent.tool_result") {
    view.tool_use_id = short(event.tool_use_id);
    if (typeof event.is_error === "boolean") view.is_error = event.is_error;
  } else if (event.type === "agent.artifact_delivered") {
    if (typeof event.file_id === "string" && /^file_[A-Za-z0-9_-]{1,160}$/.test(event.file_id)) view.file_id = event.file_id;
    view.original_filename = short(event.original_filename);
    view.content_type = short(event.content_type, 100);
    if (Number.isSafeInteger(event.size) && Number(event.size) >= 0) view.size = event.size;
  } else if (event.type === "session.status_idle") {
    const reason = event.stop_reason;
    if (reason && typeof reason === "object" && "type" in reason &&
        ["end_turn", "requires_action", "max_iterations", "interrupted", "error"].includes(String(reason.type))) {
      view.stop_reason = { type: reason.type };
    }
  }
  return view;
}

export class CloudStreamError extends Error {
  constructor(code: "cloud_stream_invalid" | "cloud_stream_too_large" | "cloud_stream_interrupted") {
    super(code);
    this.name = "CloudStreamError";
  }
}

export async function* readCloudEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<CloudStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let data: string[] = [];
  let type = "";
  let eventId = "";
  let skipLf = false;
  let frameSize = 0;

  function consumeLine(): CloudStreamEvent | undefined {
    if (line !== "") {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      if (field === "event") type = value;
      if (field === "id" && !value.includes("\0")) eventId = value;
      line = "";
      return;
    }
    const frame = { data, type, eventId };
    data = []; type = ""; eventId = ""; frameSize = 0;
    if (frame.data.length === 0) return;
    let parsed: unknown;
    try { parsed = JSON.parse(frame.data.join("\n")); } catch { throw new CloudStreamError("cloud_stream_invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CloudStreamError("cloud_stream_invalid");
    const payload = parsed as Record<string, unknown>;
    const eventType = frame.type || payload.type;
    if (typeof eventType !== "string" || !eventType || (payload.type !== undefined && payload.type !== eventType)) {
      throw new CloudStreamError("cloud_stream_invalid");
    }
    if (eventType === "heartbeat") return { type: "heartbeat" };
    const resolvedId = frame.eventId || payload.id;
    if (typeof resolvedId !== "string" || !/^evt_[A-Za-z0-9_-]{1,160}$/.test(resolvedId) ||
        (payload.id !== undefined && payload.id !== resolvedId)) throw new CloudStreamError("cloud_stream_invalid");
    return { ...payload, type: eventType, id: resolvedId };
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const char of chunk) {
        if (skipLf) { skipLf = false; if (char === "\n") continue; }
        frameSize += char.length;
        if (frameSize > 256 * 1024) throw new CloudStreamError("cloud_stream_too_large");
        if (char === "\r" || char === "\n") {
          skipLf = char === "\r";
          const event = consumeLine();
          if (event) yield event;
        } else {
          line += char;
        }
      }
      // 未以空行终结的帧不提交游标；重连后由服务端重放，避免丢半条事件。
      if (done) break;
    }
  } catch (error) {
    if (error instanceof CloudStreamError) throw error;
    throw new CloudStreamError("cloud_stream_interrupted");
  } finally {
    try { await reader.cancel(); } catch { /* 关闭连接不等于取消云端任务。 */ }
    reader.releaseLock();
  }
}
