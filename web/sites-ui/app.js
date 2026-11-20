(() => {
  "use strict";

  const API_BASE = "/functions/v1/app";
  const LOGIN_PATH = "/__qoder_auth/start";
  const MAX_NOTICE_BYTES = 64 * 1024;
  const MAX_HISTORY_PAGES = 20;
  const MAX_PREVIEW_CHARS = 500_000;
  const RUN_ID = /^[A-Za-z0-9_-]{8,100}$/;
  const FILE_ID = /^file_[A-Za-z0-9_-]{1,160}$/;
  const STORAGE_RUN = "campusmate.p0.runId";
  const STORAGE_THEME = "campusmate.p0.theme";
  const ENCODER = new TextEncoder();
  const INLINE_MARKDOWN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

  const $ = (id) => document.getElementById(id);

  const dom = {
    authSlot: $("auth-slot"),
    authTitle: $("auth-title"),
    authText: $("auth-text"),
    authActions: $("auth-actions"),
    userChip: $("user-chip"),
    connectionChip: $("connection-chip"),
    connectionLabel: $("connection-label"),
    themeButton: $("theme-button"),
    themeLabel: $("theme-label"),
    form: $("notice-form"),
    notice: $("notice"),
    byteCount: $("byte-count"),
    noticeHint: $("notice-hint"),
    composerAlert: $("composer-alert"),
    initStatus: $("init-status"),
    initLabel: $("init-label"),
    initRetry: $("init-retry"),
    submit: $("submit-button"),
    cancel: $("cancel-button"),
    runPanel: $("run-panel"),
    runTitle: $("run-title"),
    runMeta: $("run-meta"),
    runStatus: $("run-status"),
    runStatusLabel: $("run-status-label"),
    refresh: $("refresh-button"),
    runAlert: $("run-alert"),
    toolTimeline: $("tool-timeline"),
    toolCount: $("tool-count"),
    toolEmpty: $("tool-empty"),
    messageList: $("message-list"),
    messageEmpty: $("message-empty"),
    eventCount: $("event-count"),
    artifactList: $("artifact-list"),
    artifactEmpty: $("artifact-empty"),
    artifactCount: $("artifact-count"),
    previewPanel: $("preview-panel"),
    previewTitle: $("preview-title"),
    previewMeta: $("preview-meta"),
    previewStatus: $("preview-status"),
    previewBody: $("preview-body"),
    previewDownload: $("preview-download"),
    previewClose: $("preview-close")
  };

  const state = {
    authed: false,
    user: null,
    init: "idle",
    initPromise: null,
    booting: false,
    busy: false,
    busyLabel: "",
    run: null,
    session: null,
    terminal: false,
    turnEnded: false,
    stopReason: null,
    eventIds: new Set(),
    eventCount: 0,
    messageSeen: false,
    lastEventId: null,
    tools: new Map(),
    toolCount: 0,
    artifacts: [],
    artifactIds: new Set(),
    artifactPages: new Map(),
    notes: new Set(),
    stream: null,
    connection: "idle",
    pending: { id: null, notice: null },
    cancelArmed: false,
    cancelTimer: null,
    refreshPromise: null,
    historyLoading: false,
    preview: { artifact: null, link: null },
    anonTool: 0
  };

  const TOOL_LABELS = {
    Read: "读取文件",
    Write: "写入文件",
    Edit: "编辑文件",
    Glob: "查找文件",
    Grep: "搜索内容",
    Bash: "运行命令",
    DeliverArtifacts: "交付产物",
    WebFetch: "抓取网页",
    WebSearch: "搜索网络",
    ImageSearch: "搜索图片",
    ImageGen: "生成图片",
    VideoGen: "生成视频",
    Memory: "写入记忆",
    Task: "执行子任务"
  };

  class ApiError extends Error {
    constructor(status, code, message, retryAfter) {
      super(message || code);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.retryAfter = retryAfter;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clearNode(node) {
    if (node) node.replaceChildren();
  }

  function byteLength(value) {
    return ENCODER.encode(value).byteLength;
  }

  function formatNumber(value) {
    return Number(value).toLocaleString("zh-CN");
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function shortId(value) {
    if (typeof value !== "string") return "";
    if (value.length <= 18) return value;
    return `${value.slice(0, 9)}…${value.slice(-4)}`;
  }

  function maskUser(value) {
    if (typeof value !== "string" || !value) return "已登录";
    if (value.length <= 10) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 隐私模式或存储禁用时仍可使用当前页面。 */
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* 无可恢复操作。 */
    }
  }

  function updateUrlRunId(runId) {
    try {
      const url = new URL(window.location.href);
      if (runId) url.searchParams.set("run", runId);
      else url.searchParams.delete("run");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* URL 不可写时不阻断运行。 */
    }
  }

  function runStorageKey() {
    if (!state.authed || !state.user || typeof state.user.id !== "string" || !state.user.id) return null;
    return `${STORAGE_RUN}:${encodeURIComponent(state.user.id)}`;
  }

  function saveRunId(runId) {
    const key = runStorageKey();
    if (key) writeStorage(key, runId);
    updateUrlRunId(runId);
  }

  function clearSavedRunId() {
    const key = runStorageKey();
    if (key) removeStorage(key);
    updateUrlRunId(null);
  }

  function readSavedRunId() {
    try {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get("run");
      if (fromUrl && RUN_ID.test(fromUrl)) return fromUrl;
    } catch {
      /* 忽略非法 URL。 */
    }
    const key = runStorageKey();
    const stored = key ? readStorage(key) : null;
    return stored && RUN_ID.test(stored) ? stored : null;
  }

  function newRequestId() {
    const cryptoApi = window.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return `req_${cryptoApi.randomUUID().replace(/-/g, "")}`;
    }
    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return `req_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function contentText(event) {
    if (!Array.isArray(event.content)) return "";
    return event.content
      .filter((block) => isObject(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }

  function toolLabel(name) {
    if (typeof name === "string" && TOOL_LABELS[name]) return TOOL_LABELS[name];
    return "调用工具";
  }

  function extensionBadge(filename, contentType) {
    const name = typeof filename === "string" ? filename : "";
    const match = /\.([A-Za-z0-9]{1,6})$/.exec(name);
    if (match) return match[1].toUpperCase();
    if (typeof contentType === "string" && /markdown/i.test(contentType)) return "MD";
    if (typeof contentType === "string" && /text/i.test(contentType)) return "TXT";
    return "FILE";
  }

  function setConnection(next, label) {
    state.connection = next;
    dom.connectionChip.dataset.state = next;
    const labels = {
      idle: "未连接",
      connecting: "连接中",
      live: "实时连接",
      reconnecting: "重连中",
      closed: "连接已断开",
      done: "已结束"
    };
    dom.connectionLabel.textContent = label || labels[next] || "未连接";
  }

  function setInit(next, label) {
    state.init = next;
    dom.initStatus.dataset.state = next;
    dom.initLabel.textContent = label;
  }

  function setRunStatus(label, tone) {
    dom.runStatus.dataset.tone = tone || "neutral";
    dom.runStatusLabel.textContent = label;
  }

  /* Theme */

  function applyTheme() {
    const stored = readStorage(STORAGE_THEME);
    const mode = stored === "light" || stored === "dark" ? stored : "system";
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = mode;
    const labels = { system: "跟随系统", light: "浅色", dark: "深色" };
    dom.themeLabel.textContent = `主题：${labels[mode]}`;
    dom.themeButton.setAttribute("aria-label", `切换主题，当前${labels[mode]}`);
  }

  function cycleTheme() {
    const current = readStorage(STORAGE_THEME);
    const order = ["system", "light", "dark"];
    const index = order.includes(current) ? order.indexOf(current) : 0;
    const next = order[(index + 1) % order.length];
    if (next === "system") removeStorage(STORAGE_THEME);
    else writeStorage(STORAGE_THEME, next);
    applyTheme();
  }

  /* Safe Markdown rendering */

  function renderInline(text, parent) {
    const source = String(text);
    INLINE_MARKDOWN.lastIndex = 0;
    let cursor = 0;
    let match;
    while ((match = INLINE_MARKDOWN.exec(source))) {
      if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
      const token = match[0];
      const tokenEnd = INLINE_MARKDOWN.lastIndex;
      if (token.startsWith("`")) {
        parent.append(el("code", null, token.slice(1, -1)));
      } else if (token.startsWith("**") || token.startsWith("__")) {
        const strong = document.createElement("strong");
        renderInline(token.slice(2, -2), strong);
        parent.append(strong);
      } else if (token.startsWith("*") || token.startsWith("_")) {
        const emphasis = document.createElement("em");
        renderInline(token.slice(1, -1), emphasis);
        parent.append(emphasis);
      } else {
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
        if (link) {
          const anchor = document.createElement("a");
          anchor.href = link[2];
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.textContent = link[1];
          parent.append(anchor);
        } else {
          parent.append(document.createTextNode(token));
        }
      }
      cursor = tokenEnd;
      INLINE_MARKDOWN.lastIndex = tokenEnd;
    }
    if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
  }

  function splitTableRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function isTableSeparator(line) {
    if (!line || !line.includes("|")) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function renderMarkdown(source, container) {
    container.replaceChildren();
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;
    let index = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const node = document.createElement("p");
      paragraph.forEach((line, lineIndex) => {
        if (lineIndex) node.append(document.createElement("br"));
        renderInline(line, node);
      });
      container.append(node);
      paragraph = [];
    };

    const closeList = () => {
      list = null;
    };

    while (index < lines.length) {
      const line = lines[index];
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        flushParagraph();
        closeList();
        const language = fence[1].trim().slice(0, 24);
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (/^[\w.+-]{1,24}$/.test(language)) code.className = `language-${language}`;
        code.textContent = codeLines.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        index += 1;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        const node = document.createElement(`h${heading[1].length}`);
        renderInline(heading[2], node);
        container.append(node);
        index += 1;
        continue;
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        closeList();
        container.append(document.createElement("hr"));
        index += 1;
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        flushParagraph();
        closeList();
        const quote = document.createElement("blockquote");
        let first = true;
        while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
          if (!first) quote.append(document.createElement("br"));
          renderInline(lines[index].replace(/^\s{0,3}>\s?/, ""), quote);
          first = false;
          index += 1;
        }
        container.append(quote);
        continue;
      }

      const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        const type = unordered ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== type) {
          list = document.createElement(type);
          container.append(list);
        }
        const item = document.createElement("li");
        const content = unordered ? unordered[1] : ordered[2];
        const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
        if (task) {
          const wrapper = el("span", "task");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.disabled = true;
          checkbox.checked = task[1].toLowerCase() === "x";
          checkbox.tabIndex = -1;
          const label = document.createElement("span");
          renderInline(task[2], label);
          wrapper.append(checkbox, label);
          item.append(wrapper);
        } else {
          renderInline(content, item);
        }
        list.append(item);
        index += 1;
        continue;
      }

      if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        flushParagraph();
        closeList();
        const headers = splitTableRow(line);
        index += 2;
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        headers.forEach((cell) => {
          const th = document.createElement("th");
          renderInline(cell, th);
          headRow.append(th);
        });
        thead.append(headRow);
        table.append(thead);
        const tbody = document.createElement("tbody");
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const cells = splitTableRow(lines[index]);
          const row = document.createElement("tr");
          for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
            const td = document.createElement("td");
            renderInline(cells[cellIndex] || "", td);
            row.append(td);
          }
          tbody.append(row);
          index += 1;
        }
        table.append(tbody);
        container.append(table);
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
  }

  /* Alerts */

  function renderAlert(container, options) {
    clearNode(container);
    const tone = options.tone || "danger";
    container.dataset.tone = tone;
    container.hidden = false;

    const mark = el("span", "alert-mark");
    mark.setAttribute("aria-hidden", "true");
    const copy = el("div", "alert-copy");
    if (options.title) copy.append(el("p", "alert-title", options.title));
    if (options.message) copy.append(el("p", "alert-text", options.message));
    if (options.code) copy.append(el("span", "alert-code", options.code));
    container.append(mark, copy);

    const actions = Array.isArray(options.actions) ? options.actions : [];
    if (actions.length) {
      const actionBar = el("div", "alert-actions");
      actions.forEach((action) => {
        const variant = action.variant || "secondary";
        if (action.href) {
          const anchor = document.createElement("a");
          anchor.className = `button ${variant} small`;
          anchor.href = action.href;
          anchor.textContent = action.label;
          if (action.newTab) {
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
          }
          actionBar.append(anchor);
        } else {
          const button = el("button", `button ${variant} small`, action.label);
          button.type = "button";
          button.addEventListener("click", () => action.onClick?.());
          actionBar.append(button);
        }
      });
      container.append(actionBar);
    }

    if (options.dismiss !== false) {
      const close = el("button", "alert-close", "关闭");
      close.type = "button";
      close.addEventListener("click", () => {
        container.hidden = true;
        clearNode(container);
      });
      container.append(close);
    }
  }

  function clearAlert(container) {
    if (!container) return;
    container.hidden = true;
    clearNode(container);
  }

  function showComposerAlert(options) {
    renderAlert(dom.composerAlert, options);
  }

  function showRunAlert(options) {
    renderAlert(dom.runAlert, options);
  }

  function clearComposerAlert() {
    clearAlert(dom.composerAlert);
  }

  function clearRunAlert() {
    clearAlert(dom.runAlert);
  }

  function loginUrl() {
    const local = `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
    return `${LOGIN_PATH}?return_path=${encodeURIComponent(local)}`;
  }

  function showAuthBanner(message) {
    dom.authSlot.hidden = false;
    dom.authTitle.textContent = "需要 Qoder 账号";
    dom.authText.textContent = message || "登录后才会创建云端沙箱，并使用当前账号的独立额度。";
    clearNode(dom.authActions);

    const login = document.createElement("a");
    login.className = "button primary small";
    login.href = loginUrl();
    login.textContent = "使用 Qoder 登录";
    const retry = el("button", "button secondary small", "重新检查");
    retry.type = "button";
    retry.addEventListener("click", () => bootSession());
    dom.authActions.append(login, retry);
  }

  function hideAuthBanner() {
    dom.authSlot.hidden = true;
    clearNode(dom.authActions);
  }

  /* API and errors */

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = { Accept: "application/json" };
    const init = {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      signal: options.signal
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, init);
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", "无法连接同源 API。");
    }

    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const code = isObject(data) && typeof data.error === "string" ? data.error : `http_${response.status}`;
      const retryHeader = response.headers.get("Retry-After");
      const retryAfter = retryHeader && /^\d{1,6}$/.test(retryHeader) ? Number(retryHeader) : undefined;
      // 平台适配器把无效登录上下文映射为 403；对前端应按重新登录处理，而非站点域名错误。
      const status = response.status === 403 && code === "invalid_user_context" ? 401 : response.status;
      throw new ApiError(status, code, undefined, retryAfter);
    }

    if (contentType.includes("application/json") && data === null) {
      throw new ApiError(502, "invalid_response", "服务返回了无效 JSON。");
    }
    return data;
  }

  function describeError(error, context) {
    const status = error instanceof ApiError ? error.status : 0;
    const code = error instanceof ApiError ? error.code : "unknown_error";
    const wait = error instanceof ApiError && error.retryAfter ? ` 服务端建议 ${error.retryAfter} 秒后重试。` : "";

    if (status === 0 || code === "network_error") {
      return { title: "网络连接中断", message: "无法连接同源 API。请检查网络后重试；已提交的任务不会因此自动重发。" };
    }
    if (status === 401 || code === "login_required") {
      return { title: "需要重新登录", message: "登录状态已失效。请使用 Qoder 账号登录后继续。" };
    }
    if (status === 403 || code === "origin_not_allowed") {
      return { title: "站点域名未被允许", message: "同源检查未通过。请确认当前页面由已配置的 Sites 域名打开。" };
    }
    if (context === "initialize" && (status === 404 || status === 405 || code === "http_404" || code === "http_405")) {
      return {
        title: "初始化接口未就绪",
        message: "服务端需要提供 POST /initialize，并在成功时返回 {ready:true}。在通过该检查前，页面不会创建运行或发送通知。"
      };
    }
    if (context === "initialize" && code === "sites_initialization_unavailable") {
      return {
        title: "初始化入口未提供",
        message: "服务端已收到 POST /initialize，但尚未配置初始化处理。请联系管理员完成 Sites 初始化配置。"
      };
    }
    if (context === "initialize" && code === "sites_initialization_failed") {
      return {
        title: "初始化失败",
        message: "服务端未能完成 Agent/Environment 绑定。请稍后重试；若持续失败，请联系管理员检查云端配置。"
      };
    }
    if (code === "initialize_not_ready") {
      return { title: "初始化未通过", message: "服务端没有返回 ready:true。请联系管理员完成初始化后再创建运行。" };
    }
    if (code === "ai_initialization_pending") {
      return { title: "初始化正在进行", message: "服务端正在建立云端 Agent/Environment 绑定，请稍后重新检查。" };
    }
    if (["ai_not_configured", "ai_configuration_invalid", "ai_access_denied", "ai_model_not_enabled",
      "ai_initialization_rejected", "ai_initialization_conflict", "ai_resource_repair_required"].includes(code)) {
      return { title: "云端初始化配置不可用", message: "请联系管理员检查 Qoder 云端密钥、模型与服务端资源绑定。" };
    }
    if (code === "run_limit_exceeded") {
      return { title: "P0 运行额度已用完", message: "全站最多 20 次运行，每位用户最多 4 次。额度由服务端原子检查，页面不会绕过限制。" };
    }
    if (code === "rate_limit_exceeded") {
      return { title: "请求过于频繁", message: `全站默认 120 次/分、每位用户 30 次/分。${wait}` };
    }
    if (code === "cloud_rate_limited") {
      return { title: "云端限流", message: `Qoder Cloud Agents 暂时限流，请稍后重试。${wait}` };
    }
    if (code === "run_reconciliation_required") {
      return { title: "运行状态需要核对", message: "服务端拒绝自动重放创建或发送。请刷新运行状态，页面不会自动重发通知。" };
    }
    if (code === "request_conflict") {
      return { title: "请求编号冲突", message: "同一请求编号已绑定其他通知。请换用新的请求编号重试。" };
    }
    if (code === "run_not_found") {
      return { title: "运行不存在", message: "运行可能已过期，或不属于当前登录账号。" };
    }
    if (code === "sites_not_configured") {
      return { title: "站点服务尚未配置", message: "身份、存储、额度或云端凭据仍缺一项。请联系管理员完成 Sites 配置。" };
    }
    if (code === "sites_not_initialized") {
      return { title: "服务尚未完成初始化", message: "服务端没有可用的 Agent/Environment 绑定。请先通过初始化接口完成绑定后再创建运行。" };
    }
    if (code === "sites_dependency_unavailable" || code === "store_unavailable" || code === "sites_database_unavailable") {
      return { title: "服务依赖暂不可用", message: "存储或云端依赖暂时不可用。请稍后重试，不会重复创建任务。" };
    }
    if (code === "cloud_busy") {
      return { title: "云端繁忙", message: "请稍后重试；已提交的发送请求不会被页面自动重发。" };
    }
    if (code === "cloud_timeout" || status === 504) {
      return { title: "云端响应超时", message: "运行状态可能未确定。请刷新状态核对，页面不会自动重发通知。" };
    }
    if (code === "cloud_unavailable" || status === 502) {
      return { title: "云端暂不可用", message: "Qoder Cloud Agents 暂不可用。请稍后重试或刷新运行状态。" };
    }
    if (code === "notice_too_large" || code === "body_too_large" || code === "artifact_too_large") {
      return { title: "内容超过大小限制", message: "通知上限 64 KiB。请缩短正文后重试。" };
    }
    if (code === "notice_required") {
      return { title: "通知不能为空", message: "请粘贴通知原文后重试。" };
    }
    if (code === "json_required" || code === "invalid_body" || code === "invalid_request_id") {
      return { title: "请求格式无效", message: "请刷新页面后重试。" };
    }
    if (code === "artifact_not_found") {
      return { title: "找不到产物记录", message: "该文件未出现在当前运行的事件页中。请刷新状态后重试。" };
    }
    if (code === "invalid_cursor") {
      return { title: "事件游标无效", message: "请刷新运行状态，重新读取事件。" };
    }
    if (code === "http_429" || status === 429) {
      return { title: "请求被限流", message: `请稍后重试。${wait}` };
    }
    if (status >= 500) {
      return { title: "服务暂时不可用", message: "请稍后重试。页面不会自动创建新运行或重发通知。" };
    }
    return {
      title: context === "create" ? "创建运行失败" : context === "send" ? "发送通知失败" : "操作未完成",
      message: "请检查网络后重试；若持续失败，可刷新运行状态核对。"
    };
  }

  function handleUnauthorized(message) {
    state.authed = false;
    state.user = null;
    state.init = "idle";
    state.initPromise = null;
    setInit("idle", "登录后检查服务");
    renderUser();
    showAuthBanner(message || "登录状态已失效，请重新使用 Qoder 账号登录。");
    clearComposerAlert();
    clearRunAlert();
    if (state.stream) {
      closeStream(false);
      setConnection("closed");
    }
    updateComposer();
  }

  function renderUser() {
    if (state.authed && state.user && typeof state.user.id === "string") {
      dom.userChip.textContent = maskUser(state.user.id);
      dom.userChip.title = "当前登录身份";
    } else {
      dom.userChip.textContent = "未登录";
      dom.userChip.title = "当前未登录";
    }
  }

  async function checkAuth() {
    try {
      const data = await api("/me");
      if (!isObject(data) || !isObject(data.user) || typeof data.user.id !== "string" || !data.user.id.trim()) {
        throw new ApiError(502, "invalid_response", "身份响应无效。");
      }
      state.authed = true;
      state.user = { id: data.user.id };
      renderUser();
      hideAuthBanner();
      return true;
    } catch (error) {
      state.authed = false;
      state.user = null;
      renderUser();
      if (error instanceof ApiError && error.status === 401) {
        setInit("idle", "登录后检查服务");
        showAuthBanner("登录后才会创建云端沙箱，并使用当前账号的独立额度。");
        return false;
      }
      throw error;
    }
  }

  function initializeService(force = false) {
    if (state.init === "ready" && !force) return Promise.resolve(true);
    if (state.initPromise) return state.initPromise;

    setInit("checking", "正在检查服务…");
    updateComposer();

    state.initPromise = (async () => {
      try {
        const data = await api("/initialize", { method: "POST", body: {} });
        if (!isObject(data) || data.ready !== true) {
          const code = isObject(data) && typeof data.error === "string" ? data.error : "initialize_not_ready";
          throw new ApiError(503, code, "初始化未返回 ready:true。");
        }
        setInit("ready", "服务已就绪 · 同源 API");
        clearComposerAlert();
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized("登录状态已失效，请重新登录后再检查服务。");
          return false;
        }
        const info = describeError(error, "initialize");
        setInit("error", "服务检查未通过");
        showComposerAlert({
          ...info,
          code: error instanceof ApiError ? error.code : undefined,
          actions: [{
            label: "重新检查",
            onClick: () => initializeService(true)
          }]
        });
        return false;
      } finally {
        state.initPromise = null;
        updateComposer();
      }
    })();

    return state.initPromise;
  }

  /* Composer state */

  function noticeIsOverLimit() {
    return byteLength(dom.notice.value) > MAX_NOTICE_BYTES;
  }

  function updateByteCount() {
    const bytes = byteLength(dom.notice.value);
    const over = bytes > MAX_NOTICE_BYTES;
    dom.byteCount.textContent = `${formatNumber(bytes)} 字节 / 64 KiB`;
    dom.byteCount.dataset.state = over ? "danger" : "normal";
    dom.noticeHint.dataset.state = over ? "danger" : "normal";
    dom.noticeHint.textContent = over
      ? "通知超过 64 KiB，请缩短后重试。"
      : "仅用于本次运行；SSE 断线只重连，不会重发通知。刷新页面只恢复读取。";
    updateComposer();
  }

  function updateComposer() {
    let label = "开始整理";
    let disabled = false;

    if (!state.authed) {
      label = "登录后可开始";
      disabled = true;
    } else if (state.init === "checking") {
      label = "检查服务…";
      disabled = true;
    } else if (state.init === "error") {
      label = "服务未就绪";
      disabled = true;
    } else if (state.busy) {
      label = state.busyLabel || "处理中…";
      disabled = true;
    } else if (state.run) {
      switch (state.run.state) {
        case "ready":
          label = "继续发送";
          break;
        case "creating":
        case "sending":
        case "uncertain":
          label = "核对状态";
          break;
        case "submitted":
          label = state.terminal ? "开始新一轮整理" : "整理中…";
          disabled = !state.terminal;
          break;
        case "cancelled":
          label = "开始新一轮整理";
          break;
        default:
          label = "开始新一轮整理";
      }
    }

    const actionNeedsNotice = !state.run || state.run.state === "ready" || state.run.state === "cancelled" ||
      (state.run.state === "submitted" && state.terminal) ||
      !["creating", "sending", "uncertain", "submitted"].includes(state.run.state);
    if (noticeIsOverLimit() && actionNeedsNotice) disabled = true;
    dom.submit.textContent = label;
    dom.submit.disabled = disabled;
    dom.submit.setAttribute("aria-busy", state.busy ? "true" : "false");
    dom.notice.readOnly = state.busy;
    dom.initRetry.hidden = !(state.authed && state.init === "error" && !state.busy);
    dom.cancel.hidden = !canCancel();
    dom.cancel.disabled = state.busy;
    dom.refresh.hidden = !state.run;
    dom.refresh.disabled = state.busy || Boolean(state.refreshPromise);
    if (!canCancel() && state.cancelArmed) disarmCancel();
  }

  function canCancel() {
    if (!state.run || state.terminal) return false;
    return ["ready", "sending", "submitted", "uncertain"].includes(state.run.state);
  }

  function setBusy(label) {
    state.busy = Boolean(label);
    state.busyLabel = label || "";
    updateComposer();
  }

  function stateLabel(value) {
    const labels = {
      creating: "创建中",
      ready: "已就绪",
      sending: "发送中",
      submitted: "已提交",
      uncertain: "需核对",
      cancelled: "已取消"
    };
    return labels[value] || value || "未知";
  }

  function sessionLabel(value) {
    const labels = {
      idle: "空闲",
      running: "运行中",
      rescheduling: "重新调度",
      terminated: "已终止"
    };
    return labels[value] || value || "未知";
  }

  function stopReasonLabel(value) {
    const labels = {
      end_turn: "完成本轮",
      requires_action: "等待操作",
      max_iterations: "达到步数上限",
      interrupted: "已中断",
      error: "执行出错"
    };
    return labels[value] || "";
  }

  function displayRunStatus() {
    if (!state.run) return { label: "未开始", tone: "neutral" };
    if (state.run.state === "cancelled") return { label: "已取消", tone: "warning" };
    if (state.run.state === "uncertain") return { label: "需核对", tone: "danger" };
    if (state.run.state === "sending" && state.terminal) return { label: "需核对", tone: "danger" };
    if (state.terminal) {
      if (state.stopReason === "error") return { label: "执行出错", tone: "danger" };
      if (state.stopReason === "requires_action") return { label: "等待操作", tone: "warning" };
      if (state.stopReason === "max_iterations") return { label: "达到步数上限", tone: "warning" };
      if (state.stopReason === "interrupted") return { label: "已中断", tone: "warning" };
      return { label: state.stopReason === "end_turn" ? "已完成" : "已结束", tone: "success" };
    }
    if (state.run.state === "ready") return { label: "已就绪", tone: "accent" };
    if (state.run.state === "sending") return { label: "发送中", tone: "accent" };
    if (state.run.state === "submitted") return { label: "整理中", tone: "accent" };
    if (state.run.state === "creating") return { label: "创建中", tone: "accent" };
    return { label: stateLabel(state.run.state), tone: "neutral" };
  }

  function updateRunHeader() {
    if (!state.run) {
      dom.runTitle.textContent = "整理过程";
      dom.runMeta.textContent = "在左侧粘贴通知后开始。工具步骤、回复和产物会显示在这里。";
      setRunStatus("未开始", "neutral");
      dom.refresh.hidden = true;
      return;
    }

    const parts = [`运行 ${shortId(state.run.id)}`];
    if (state.session && state.session.status) parts.push(`会话 ${sessionLabel(state.session.status)}`);
    parts.push(`应用状态 ${stateLabel(state.run.state)}`);
    parts.push(`${formatNumber(state.eventCount)} 条事件`);
    const reason = stopReasonLabel(state.stopReason);
    if (reason) parts.push(reason);
    if (state.session && state.session.archived) parts.push("已归档");
    dom.runMeta.textContent = parts.join(" · ");

    const status = displayRunStatus();
    setRunStatus(status.label, status.tone);
    dom.refresh.hidden = false;
  }

  function updateCounts() {
    dom.toolCount.textContent = `${formatNumber(state.toolCount)} 步`;
    dom.eventCount.textContent = `${formatNumber(state.eventCount)} 条事件`;
    dom.artifactCount.textContent = `${formatNumber(state.artifacts.length)} 个`;
    dom.toolEmpty.hidden = dom.toolTimeline.children.length > 0;
    dom.messageEmpty.hidden = dom.messageList.children.length > 0;
    dom.artifactEmpty.hidden = state.artifacts.length > 0;
  }

  function renderRunSections(hasRun) {
    dom.runPanel.dataset.hasRun = hasRun ? "true" : "false";
  }

  function computeTerminal() {
    if (!state.run) return false;
    if (state.run.state === "cancelled") return true;
    if (state.run.state !== "submitted") return false;
    if (state.turnEnded) return true;
    return Boolean(state.session && state.session.status === "terminated");
  }

  function applySnapshot(snapshot) {
    if (!isObject(snapshot) || !isObject(snapshot.run) || !RUN_ID.test(snapshot.run.id) || typeof snapshot.run.state !== "string") {
      throw new ApiError(502, "invalid_response", "运行状态响应无效。");
    }
    state.run = { id: snapshot.run.id, state: snapshot.run.state };
    if (isObject(snapshot.session) && ["idle", "running", "rescheduling", "terminated"].includes(snapshot.session.status)) {
      state.session = {
        status: snapshot.session.status,
        archived: snapshot.session.archived === true
      };
    } else {
      state.session = null;
    }
    if (state.session && ["running", "rescheduling"].includes(state.session.status)) state.stopReason = null;
    state.terminal = computeTerminal();
  }

  function shouldStream() {
    if (!state.run || state.terminal) return false;
    if (state.run.state === "cancelled" || state.run.state === "ready" || state.run.state === "creating") return false;
    if (state.session && state.session.status === "terminated") return false;
    if (state.run.state === "uncertain" && !state.session) return false;
    return ["submitted", "sending", "uncertain"].includes(state.run.state);
  }

  function showIdleRun() {
    closeStream(false);
    disarmCancel();
    state.run = null;
    state.session = null;
    state.terminal = false;
    state.turnEnded = false;
    state.stopReason = null;
    resetRunView();
    renderRunSections(false);
    updateRunHeader();
    clearRunAlert();
    setConnection("idle");
    updateComposer();
  }

  function resetRunView() {
    closeStream(false);
    state.eventIds.clear();
    state.eventCount = 0;
    state.messageSeen = false;
    state.lastEventId = null;
    state.tools.clear();
    state.toolCount = 0;
    state.artifacts = [];
    state.artifactIds.clear();
    state.artifactPages.clear();
    state.notes.clear();
    state.turnEnded = false;
    state.stopReason = null;
    closePreview();
    state.preview.link = null;
    dom.toolTimeline.replaceChildren();
    dom.messageList.replaceChildren();
    dom.artifactList.replaceChildren();
    clearRunAlert();
    updateCounts();
  }

  /* Timeline, messages and artifacts */

  function addNoticeBlock(text, truncated) {
    const details = document.createElement("details");
    details.className = "notice-block";
    const summary = document.createElement("summary");
    summary.textContent = `你提交的通知 · ${formatNumber(text.length)} 字`;
    const pre = document.createElement("pre");
    pre.textContent = text;
    details.append(summary, pre);
    if (truncated) details.append(el("p", "message-truncated", "服务端为预览截断了通知正文。"));
    dom.messageList.append(details);
    updateCounts();
  }

  function addAgentMessage(text, truncated) {
    const article = document.createElement("article");
    article.className = "agent-message";
    article.append(el("p", "agent-role", "整理助手"));
    const body = el("div", "markdown");
    renderMarkdown(text, body);
    article.append(body);
    if (truncated) article.append(el("p", "message-truncated", "回复内容已截断，完整结果请查看 Markdown 产物。"));
    dom.messageList.append(article);
    updateCounts();
  }

  function addToolUse(toolUseId, name) {
    const key = typeof toolUseId === "string" && toolUseId
      ? toolUseId
      : `tool-local-${++state.anonTool}`;
    if (state.tools.has(key)) return key;

    const item = el("li", "tool-item");
    item.dataset.status = "running";
    const glyph = el("span", "tool-glyph");
    glyph.setAttribute("aria-hidden", "true");
    const body = el("div", "tool-body");
    const hasKnownName = typeof name === "string" && Boolean(TOOL_LABELS[name]);
    body.append(el("p", "tool-title", hasKnownName ? TOOL_LABELS[name] : (name ? "调用工具" : "工具调用")));
    if (typeof name === "string" && name) body.append(el("p", "tool-detail", name));
    const status = el("span", "tool-status");
    status.append(el("span", "dot"), el("span", null, "进行中"));
    item.append(glyph, body, status);
    dom.toolTimeline.append(item);

    state.tools.set(key, {
      item,
      statusText: status.lastChild
    });
    state.toolCount += 1;
    updateCounts();
    return key;
  }

  function setToolResult(toolUseId, isError) {
    const key = typeof toolUseId === "string" && toolUseId ? toolUseId : `tool-local-${++state.anonTool}`;
    if (!state.tools.has(key)) addToolUse(key, "");
    const entry = state.tools.get(key);
    if (!entry) return;
    entry.item.dataset.status = isError ? "error" : "success";
    entry.statusText.textContent = isError ? "失败" : "已完成";
  }

  function addTimelineNote(text, tone, key) {
    if (key && state.notes.has(key)) return;
    if (key) state.notes.add(key);
    const status = tone || "neutral";
    const item = el("li", "tool-item");
    item.dataset.kind = "note";
    item.dataset.status = status === "danger" ? "error" : status === "success" ? "success" : "note";
    const glyph = el("span", "tool-glyph");
    glyph.setAttribute("aria-hidden", "true");
    const body = el("div", "tool-body");
    body.append(el("p", "tool-title", text));
    const statusNode = el("span", "tool-status");
    statusNode.append(el("span", "dot"));
    const labels = { success: "完成", warning: "提示", danger: "异常", info: "信息", neutral: "系统" };
    statusNode.append(el("span", null, labels[status] || "系统"));
    item.append(glyph, body, statusNode);
    dom.toolTimeline.append(item);
    updateCounts();
  }

  function addArtifact(event) {
    if (!FILE_ID.test(event.file_id)) {
      addTimelineNote("收到产物事件，但文件标识无效，已忽略。", "warning", "artifact-invalid");
      return;
    }
    if (state.artifactIds.has(event.file_id)) return;
    const artifact = {
      file_id: event.file_id,
      original_filename: typeof event.original_filename === "string" ? event.original_filename : "",
      content_type: typeof event.content_type === "string" ? event.content_type : "",
      size: Number.isSafeInteger(event.size) && event.size >= 0 ? event.size : null
    };
    state.artifacts.push(artifact);
    state.artifactIds.add(artifact.file_id);
    renderArtifacts();
    addTimelineNote(
      `交付产物 · ${artifact.original_filename || "未命名文档"}`,
      "success",
      `artifact:${artifact.file_id}`
    );
  }

  function renderArtifacts() {
    dom.artifactList.replaceChildren();
    state.artifacts.forEach((artifact) => {
      const item = el("div", "artifact-item");
      const badge = el("span", "file-badge", extensionBadge(artifact.original_filename, artifact.content_type));
      const copy = el("div", "artifact-copy");
      copy.append(el("p", "artifact-name", artifact.original_filename || "未命名产物"));
      const metaParts = [artifact.content_type || "未知类型"];
      const size = formatBytes(artifact.size);
      if (size) metaParts.push(size);
      copy.append(el("p", "artifact-meta", metaParts.join(" · ")));
      const actions = el("div", "artifact-actions");
      const preview = el("button", "button secondary small", "预览");
      preview.type = "button";
      preview.setAttribute("aria-label", `预览 ${artifact.original_filename || "产物"}`);
      preview.addEventListener("click", () => previewArtifact(artifact));
      const download = el("button", "button ghost small", "下载");
      download.type = "button";
      download.setAttribute("aria-label", `下载 ${artifact.original_filename || "产物"}`);
      download.addEventListener("click", () => downloadArtifact(artifact));
      actions.append(preview, download);
      item.append(badge, copy, actions);
      dom.artifactList.append(item);
    });
    updateCounts();
  }

  function applyEvent(event, context = {}) {
    if (!isObject(event) || typeof event.type !== "string") return;
    if (event.type === "heartbeat") return;

    if (context.page !== undefined && event.type === "agent.artifact_delivered" && FILE_ID.test(event.file_id)) {
      state.artifactPages.set(event.file_id, context.page);
    }

    if (typeof event.id === "string" && event.id) {
      if (state.eventIds.has(event.id)) return;
      state.eventIds.add(event.id);
      state.lastEventId = event.id;
    }

    state.eventCount += 1;

    switch (event.type) {
      case "user.message": {
        state.messageSeen = true;
        const text = contentText(event);
        if (text) addNoticeBlock(text, event.contentTruncated === true);
        break;
      }
      case "agent.message": {
        state.messageSeen = true;
        const text = contentText(event);
        if (text) addAgentMessage(text, event.contentTruncated === true);
        break;
      }
      case "agent.tool_use": {
        state.messageSeen = true;
        addToolUse(event.id, typeof event.name === "string" ? event.name : "");
        break;
      }
      case "agent.tool_result": {
        setToolResult(typeof event.tool_use_id === "string" ? event.tool_use_id : "", event.is_error === true);
        break;
      }
      case "agent.artifact_delivered": {
        addArtifact(event);
        break;
      }
      case "session.status_idle": {
        // 会话刚创建时也可能为空闲状态；本轮消息出现后才把空闲视为运行结束。
        if (!state.messageSeen) break;
        const reason = isObject(event.stop_reason) && typeof event.stop_reason.type === "string"
          ? event.stop_reason.type
          : null;
        state.stopReason = reason;
        state.turnEnded = true;
        state.terminal = true;
        state.session = {
          status: "idle",
          archived: Boolean(state.session && state.session.archived)
        };
        const text = reason ? `运行结束 · ${stopReasonLabel(reason) || reason}` : "运行结束";
        addTimelineNote(text, reason === "error" ? "danger" : reason && reason !== "end_turn" ? "warning" : "success", `terminal:${reason || "idle"}`);
        closeStream(true);
        if (reason === "error") {
          showRunAlert({
            tone: "danger",
            title: "云端会话报告执行出错",
            message: "页面不会自动重发通知。可刷新状态、查看已交付产物，或开始新一轮整理。",
            actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }]
          });
        } else if (reason && reason !== "end_turn") {
          showRunAlert({
            tone: "warning",
            title: "运行已停止",
            message: `${stopReasonLabel(reason) || reason}。页面不会自动继续或重发，请核对事件与产物。`,
            actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }]
          });
        }
        updateRunHeader();
        updateComposer();
        break;
      }
      case "session.status_terminated": {
        state.turnEnded = true;
        state.terminal = true;
        state.session = {
          status: "terminated",
          archived: Boolean(state.session && state.session.archived)
        };
        addTimelineNote("云端会话已终止。", "warning", "terminal:terminated");
        closeStream(true);
        showRunAlert({
          tone: "warning",
          title: "云端会话已终止",
          message: "页面不会自动重发或重建会话。请核对已交付产物，或开始新一轮整理。",
          actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }]
        });
        updateRunHeader();
        updateComposer();
        break;
      }
      case "session.error": {
        addTimelineNote("云端会话报告错误，未收到错误正文。", "danger", "session-error");
        showRunAlert({
          tone: "danger",
          title: "云端会话出错",
          message: "页面不会自动重发。请刷新状态核对；如仍失败，可取消运行。",
          actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }]
        });
        break;
      }
      default:
        break;
    }

    updateCounts();
  }

  /* Artifact preview and download */

  function setPreviewStatus(text, tone) {
    dom.previewStatus.dataset.tone = tone || "";
    dom.previewStatus.textContent = text || "";
  }

  function closePreview() {
    dom.previewPanel.hidden = true;
    dom.previewTitle.textContent = "产物";
    dom.previewMeta.textContent = "";
    dom.previewBody.replaceChildren();
    setPreviewStatus("", "");
    dom.previewDownload.disabled = true;
    state.preview.artifact = null;
  }

  async function findArtifactPage(runId, fileId) {
    if (state.artifactPages.has(fileId)) {
      return { found: true, page: state.artifactPages.get(fileId) };
    }
    let page;
    const seenPages = new Set();
    let pageCount = 0;
    while (pageCount < MAX_HISTORY_PAGES) {
      if (!state.run || state.run.id !== runId) return { found: false, page: null };
      const query = page ? `?page=${encodeURIComponent(page)}` : "";
      const data = await api(`/runs/${encodeURIComponent(runId)}/events${query}`);
      if (!state.run || state.run.id !== runId) return { found: false, page: null };
      const events = Array.isArray(data && data.events) ? data.events : [];
      if (events.some((item) => isObject(item) && item.type === "agent.artifact_delivered" && item.file_id === fileId)) {
        return { found: true, page: page === undefined ? null : page };
      }
      const nextPage = data && typeof data.nextPage === "string" && data.nextPage ? data.nextPage : null;
      if (!nextPage || seenPages.has(nextPage)) break;
      seenPages.add(nextPage);
      page = nextPage;
      pageCount += 1;
    }
    return { found: false, page: null };
  }

  async function getArtifactLink(artifact, force = false) {
    if (!state.run) throw new ApiError(409, "run_not_found", "当前没有可读取的运行。");
    const runId = state.run.id;
    const cached = state.preview.link;
    if (!force && cached && cached.fileId === artifact.file_id && cached.url) {
      const expires = Date.parse(cached.expires_at);
      if (Number.isFinite(expires) && expires - Date.now() > 30_000) return cached;
    }

    const known = state.artifactPages.get(artifact.file_id);
    let page = known;
    if (page === undefined) {
      const found = await findArtifactPage(runId, artifact.file_id);
      if (!state.run || state.run.id !== runId) throw new ApiError(409, "run_not_found", "运行已切换。");
      if (!found.found) throw new ApiError(404, "artifact_not_found", "产物未出现在事件页中。");
      page = found.page;
      state.artifactPages.set(artifact.file_id, page);
    }

    const query = page ? `?page=${encodeURIComponent(page)}` : "";
    const link = await api(`/runs/${encodeURIComponent(runId)}/artifacts/${artifact.file_id}${query}`);
    if (!state.run || state.run.id !== runId) throw new ApiError(409, "run_not_found", "运行已切换。");
    if (!isObject(link) || typeof link.url !== "string" || !/^https:\/\//i.test(link.url) ||
        typeof link.expires_at !== "string" || !Number.isFinite(Date.parse(link.expires_at))) {
      throw new ApiError(502, "invalid_response", "产物下载链接无效。");
    }
    const result = {
      fileId: artifact.file_id,
      url: link.url,
      expires_at: link.expires_at
    };
    state.preview.link = result;
    return result;
  }

  function appendOpenLink(container, link) {
    const open = document.createElement("a");
    open.className = "button secondary small";
    open.href = link.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "在新标签页打开";
    container.append(open);
  }

  function renderPreviewError(error, artifact, link) {
    const info = describeError(error, "artifact");
    const code = error instanceof ApiError ? error.code : "";
    const message = code === "artifact_fetch_failed"
      ? "无法直接读取产物内容（可能是存储跨域限制）。可下载文件，或在新标签页打开由服务端签发的限时链接。"
      : code === "artifact_too_large"
        ? "产物较大，无法内嵌预览。请下载文件，或在新标签页打开限时链接。"
        : info.message;
    dom.previewStatus.dataset.tone = "danger";
    dom.previewStatus.replaceChildren();
    dom.previewStatus.append(el("p", "alert-text", message));
    const actions = el("div", "alert-actions");
    const retry = el("button", "button secondary small", "重试预览");
    retry.type = "button";
    retry.addEventListener("click", () => previewArtifact(artifact));
    actions.append(retry);
    if (link && link.url) appendOpenLink(actions, link);
    dom.previewStatus.append(actions);
    if (link && link.url) dom.previewDownload.disabled = false;
  }

  async function previewArtifact(artifact) {
    if (!artifact || !state.run) return;
    const runId = state.run.id;
    const isCurrent = () => Boolean(state.run && state.run.id === runId && state.preview.artifact === artifact);
    state.preview.artifact = artifact;
    dom.previewPanel.hidden = false;
    dom.previewTitle.textContent = artifact.original_filename || "产物";
    const metaParts = [artifact.content_type || "未知类型"];
    const size = formatBytes(artifact.size);
    if (size) metaParts.push(size);
    dom.previewMeta.textContent = metaParts.join(" · ");
    dom.previewBody.replaceChildren();
    dom.previewDownload.disabled = true;
    setPreviewStatus("正在获取限时下载链接…", "info");

    let link = null;
    try {
      link = await getArtifactLink(artifact, false);
      if (!isCurrent()) return;
      setPreviewStatus("正在读取产物…", "info");
      let response;
      try {
        response = await fetch(link.url, {
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer"
        });
      } catch {
        throw new ApiError(0, "artifact_fetch_failed", "产物内容读取失败。");
      }
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new ApiError(response.status, "artifact_fetch_failed", `产物读取失败（HTTP ${response.status}）。`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > 4 * 1024 * 1024) {
        throw new ApiError(413, "artifact_too_large", "产物较大，请下载后查看。");
      }

      const contentType = (response.headers.get("content-type") || artifact.content_type || "").toLowerCase();
      const filename = artifact.original_filename || "";
      const isMarkdown = /markdown/i.test(contentType) || /\.mdx?$/i.test(filename);
      const isText = isMarkdown || contentType.startsWith("text/") || /(json|xml|yaml|csv|javascript)/.test(contentType);

      if (!isText) {
        dom.previewStatus.dataset.tone = "info";
        dom.previewStatus.replaceChildren();
        dom.previewStatus.append(el("p", "alert-text", "此类型不支持内嵌预览。请下载文件，或在新标签页打开限时链接。"));
        const actions = el("div", "alert-actions");
        appendOpenLink(actions, link);
        dom.previewStatus.append(actions);
        dom.previewDownload.disabled = false;
        return;
      }

      const text = await response.text();
      if (!isCurrent()) return;
      const truncated = text.length > MAX_PREVIEW_CHARS;
      const content = truncated ? text.slice(0, MAX_PREVIEW_CHARS) : text;
      if (isMarkdown) {
        renderMarkdown(content, dom.previewBody);
      } else {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = content;
        pre.append(code);
        dom.previewBody.append(pre);
      }
      dom.previewDownload.disabled = false;
      const notes = [`已加载 · ${formatNumber(text.length)} 字符`];
      if (truncated) notes.push(`仅预览前 ${formatNumber(MAX_PREVIEW_CHARS)} 字符，请下载完整文件。`);
      setPreviewStatus(notes.join(" · "), truncated ? "info" : "");
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后预览产物。");
        return;
      }
      renderPreviewError(error, artifact, link);
    }
  }

  async function downloadArtifact(artifact) {
    if (!artifact || !state.run) return;
    const runId = state.run.id;
    try {
      const link = await getArtifactLink(artifact, true);
      if (!state.run || state.run.id !== runId) return;
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.download = artifact.original_filename || "campusmate-notice.md";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后下载产物。");
        return;
      }
      const info = describeError(error, "artifact");
      showRunAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions: [
          { label: "重试下载", onClick: () => downloadArtifact(artifact) },
          { label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }
        ]
      });
    }
  }

  /* History */

  async function loadHistory(runId) {
    if (state.historyLoading) return;
    if (!state.run || state.run.id !== runId) return;
    state.historyLoading = true;
    try {
      let page;
      const seenPages = new Set();
      let pageCount = 0;
      while (pageCount < MAX_HISTORY_PAGES && state.run && state.run.id === runId) {
        const query = page ? `?page=${encodeURIComponent(page)}` : "";
        const data = await api(`/runs/${encodeURIComponent(runId)}/events${query}`);
        const events = Array.isArray(data && data.events) ? data.events : [];
        for (const event of events) {
          applyEvent(event, { page: page === undefined ? null : page });
        }
        const nextPage = data && typeof data.nextPage === "string" && data.nextPage ? data.nextPage : null;
        if (!nextPage || seenPages.has(nextPage)) break;
        seenPages.add(nextPage);
        page = nextPage;
        pageCount += 1;
      }
    } finally {
      state.historyLoading = false;
      updateCounts();
    }
  }

  /* SSE */

  function closeStream(markDone) {
    const source = state.stream;
    state.stream = null;
    if (source) {
      try {
        source.close();
      } catch {
        /* 已关闭。 */
      }
    }
    if (markDone) setConnection("done");
  }

  function showStreamClosedError() {
    if (!state.run || state.terminal) return;
    showRunAlert({
      tone: "warning",
      title: "实时连接已断开",
      message: "任务不会被重发。请刷新状态，并通过新的连接继续读取事件。",
      actions: [{ label: "刷新并重连", onClick: () => reconnectStream() }]
    });
  }

  function connectStream() {
    if (!state.run || state.stream || !shouldStream()) return;
    if (typeof window.EventSource !== "function") {
      setConnection("closed");
      showStreamClosedError();
      return;
    }

    const runId = state.run.id;
    setConnection("connecting");
    let source;
    try {
      // 浏览器 EventSource 自动携带 Last-Event-ID 重连；这里只读事件，绝不重发消息。
      source = new EventSource(`${API_BASE}/runs/${encodeURIComponent(runId)}/stream`, {
        withCredentials: true
      });
    } catch {
      setConnection("closed");
      showStreamClosedError();
      return;
    }
    state.stream = source;

    source.addEventListener("open", () => {
      if (state.stream !== source) return;
      setConnection("live");
      updateRunHeader();
    });

    source.addEventListener("cloud_event", (event) => {
      if (state.stream !== source) return;
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        showRunAlert({
          tone: "warning",
          title: "收到无法解析的事件",
          message: "该条事件已忽略，连接继续；不会重发通知。",
          dismiss: true
        });
        return;
      }
      applyEvent(payload, {});
      updateRunHeader();
      updateComposer();
    });

    source.addEventListener("stream_interrupted", () => {
      if (state.stream !== source) return;
      setConnection("reconnecting");
      addTimelineNote("实时连接中断，正在自动重连；不会重发通知。", "warning", "stream-interrupted");
      updateRunHeader();
    });

    source.addEventListener("error", () => {
      if (state.stream !== source) return;
      if (source.readyState === EventSource.CLOSED) {
        state.stream = null;
        try {
          source.close();
        } catch {
          /* 已关闭。 */
        }
        setConnection("closed");
        showStreamClosedError();
      } else {
        setConnection("reconnecting");
      }
      updateRunHeader();
    });
  }

  async function reconnectStream() {
    if (!state.run) return;
    clearRunAlert();
    closeStream(false);
    setConnection("connecting");
    try {
      await loadHistory(state.run.id);
      updateRunHeader();
      updateComposer();
      if (!state.run || state.terminal) {
        setConnection(state.terminal ? "done" : "idle");
        return;
      }
      if (shouldStream()) connectStream();
      else setConnection("idle");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后继续接收事件。");
        return;
      }
      const info = describeError(error, "refresh");
      setConnection("closed");
      showRunAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions: [
          { label: "再试一次", onClick: () => reconnectStream() },
          { label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }
        ]
      });
    }
  }

  /* Snapshot refresh (read-only) */

  function refreshSnapshot(options = {}) {
    if (!state.run) return Promise.resolve(null);
    if (state.refreshPromise) return state.refreshPromise;
    const quiet = options.quiet === true;
    const reloadEvents = options.reloadEvents !== false;
    const runId = state.run.id;
    dom.refresh.disabled = true;

    state.refreshPromise = (async () => {
      try {
        const snapshot = await api(`/runs/${encodeURIComponent(runId)}`);
        if (!state.run || state.run.id !== runId) return null;
        applySnapshot(snapshot);
        if (reloadEvents && state.session) {
          try {
            await loadHistory(runId);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 409)) throw error;
          }
        }
        updateRunHeader();
        updateComposer();
        if (state.terminal) closeStream(true);
        else if (shouldStream() && !state.stream) connectStream();
        else if (!state.stream) setConnection("idle");
        return snapshot;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized("登录状态已失效，请重新登录后刷新状态。");
          return null;
        }
        if (error instanceof ApiError && error.status === 404) {
          // 保留原编号与核查提示，不自动清除或改用新请求编号。
          showIdleRun();
          if (!quiet) {
            showComposerAlert({
              tone: "warning",
              title: "运行不存在，需核对",
              message: `已保留运行编号 ${shortId(runId)}，不会自动换号或重发。可能尚未创建成功、已过期或不属于当前账号。`,
              actions: [
                { label: "重新核对", onClick: () => restoreRun(runId) },
                {
                  label: "清除恢复记录",
                  variant: "ghost",
                  onClick: () => {
                    clearSavedRunId();
                    clearComposerAlert();
                  }
                }
              ],
              dismiss: true
            });
          }
          return null;
        }
        if (!quiet) {
          const info = describeError(error, "refresh");
          showRunAlert({
            ...info,
            code: error instanceof ApiError ? error.code : undefined,
            actions: [{ label: "重试刷新", onClick: () => refreshSnapshot({ fromUser: true }) }]
          });
        }
        return null;
      } finally {
        state.refreshPromise = null;
        dom.refresh.disabled = false;
        updateComposer();
      }
    })();

    return state.refreshPromise;
  }

  async function recoverRunReadOnly(runId) {
    if (!state.run || state.run.id !== runId) return;
    await refreshSnapshot({ quiet: true, reloadEvents: true });
    if (state.run && state.run.id === runId && shouldStream() && !state.stream) connectStream();
  }

  /* Create, send, cancel */

  async function sendMessage(runId, notice) {
    if (!state.run || state.run.id !== runId) return;
    clearRunAlert();
    try {
      const data = await api(`/runs/${encodeURIComponent(runId)}/message`, {
        method: "POST",
        body: { notice }
      });
      if (!isObject(data) || !isObject(data.run) || typeof data.run.state !== "string") {
        throw new ApiError(502, "invalid_response", "发送响应无效。");
      }
      state.run = { id: runId, state: data.run.state };
      if (data.run.state === "submitted") {
        state.terminal = false;
        state.turnEnded = false;
        state.stopReason = null;
        state.session = null;
        if (Array.isArray(data.events)) data.events.forEach((event) => applyEvent(event, {}));
        updateRunHeader();
        updateComposer();
        connectStream();
      } else if (data.run.state === "uncertain" || data.run.state === "sending") {
        state.run = { id: runId, state: "uncertain" };
        updateRunHeader();
        updateComposer();
        showRunAlert({
          tone: "warning",
          title: "发送状态需核对",
          message: "服务端未确认消息已提交，页面不会自动重发。请刷新状态或取消运行。",
          actions: [
            { label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) },
            ...(canCancel() ? [{ label: "取消运行", onClick: () => cancelRun({ confirm: true }), variant: "danger-ghost" }] : [])
          ]
        });
      } else {
        updateRunHeader();
        updateComposer();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后继续发送。");
        return;
      }
      if (error instanceof ApiError && error.code === "request_conflict") {
        showRunAlert({
          tone: "warning",
          title: "通知与已创建运行不一致",
          message: "发送接口只接受创建时绑定的通知。请恢复原文，或取消此运行后开始新一轮。",
          actions: canCancel()
            ? [{ label: "取消该运行", onClick: () => cancelRun({ confirm: true }), variant: "danger-ghost" }]
            : []
        });
        return;
      }

      const info = describeError(error, "send");
      const reconciled = await refreshSnapshot({ quiet: true, reloadEvents: false });
      const current = state.run ? state.run.state : "";

      if (reconciled && current === "submitted") {
        showRunAlert({
          tone: "info",
          title: "发送状态已确认",
          message: "服务端已记录提交，正在继续读取事件；页面不会重复发送。",
          actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }],
          dismiss: true
        });
        return;
      }

      const actions = [];
      if (reconciled && current === "ready") {
        actions.push({ label: "重试发送", onClick: () => retrySend(notice) });
      }
      actions.push({ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) });
      if (canCancel()) {
        actions.push({ label: "取消运行", onClick: () => cancelRun({ confirm: true }), variant: "danger-ghost" });
      }
      showRunAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions
      });
    } finally {
      updateRunHeader();
      updateComposer();
    }
  }

  async function sendCurrentRun(notice) {
    if (state.busy || !state.run || state.run.state !== "ready") return;
    setBusy("正在发送通知…");
    try {
      await sendMessage(state.run.id, notice);
    } finally {
      setBusy("");
      updateRunHeader();
      updateComposer();
    }
  }

  async function retrySend(notice) {
    if (state.busy || !state.run || state.run.state !== "ready") return;
    setBusy("正在重试发送…");
    clearRunAlert();
    try {
      await sendMessage(state.run.id, notice);
    } finally {
      setBusy("");
      updateRunHeader();
      updateComposer();
    }
  }

  async function createAndSend(notice) {
    if (state.busy) return;

    setBusy("正在创建云端沙箱…");
    clearComposerAlert();
    clearRunAlert();

    try {
      let pending = state.pending;
      if (!pending || !pending.id || pending.notice !== notice) {
        pending = { id: newRequestId(), notice };
        state.pending = pending;
      }

      // 先持久化 requestId；响应丢失后刷新只能按原编号只读恢复，不能换号重发。
      saveRunId(pending.id);

      const data = await api("/runs", {
        method: "POST",
        body: { requestId: pending.id, notice }
      });
      if (!isObject(data) || !isObject(data.run) || !RUN_ID.test(data.run.id) || typeof data.run.state !== "string") {
        throw new ApiError(502, "invalid_response", "创建运行响应无效。");
      }

      state.pending = { id: null, notice: null };
      closeStream(false);
      disarmCancel();
      resetRunView();
      state.run = { id: data.run.id, state: data.run.state };
      state.session = null;
      state.terminal = false;
      state.stopReason = null;
      saveRunId(data.run.id);
      renderRunSections(true);
      updateRunHeader();
      setConnection("idle");
      updateComposer();

      if (data.run.state === "ready") {
        setBusy("正在发送通知…");
        await sendMessage(data.run.id, notice);
        return;
      }

      if (data.run.state === "submitted") {
        state.terminal = false;
        await recoverRunReadOnly(data.run.id);
        return;
      }

      if (["creating", "sending", "uncertain"].includes(data.run.state)) {
        showRunAlert({
          tone: "warning",
          title: "运行状态需核对",
          message: "服务端没有确认可发送状态，页面不会自动重发通知。",
          actions: [
            { label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) },
            { label: "取消运行", onClick: () => cancelRun({ confirm: true }), variant: "danger-ghost" }
          ]
        });
        return;
      }

      if (data.run.state === "cancelled") {
        state.terminal = true;
        updateRunHeader();
        updateComposer();
        return;
      }

      await recoverRunReadOnly(data.run.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后创建运行。");
        return;
      }
      const info = describeError(error, "create");
      const actions = [];
      if (error instanceof ApiError && error.code === "request_conflict") {
        actions.push({
          label: "使用新请求编号重试",
          onClick: () => {
            state.pending = { id: null, notice: null };
            clearComposerAlert();
            createAndSend(notice);
          }
        });
      } else if (error instanceof ApiError && error.code !== "run_limit_exceeded" &&
          [0, 408, 409, 429, 502, 503, 504].includes(error.status)) {
        actions.push({
          label: "重试创建",
          onClick: () => {
            clearComposerAlert();
            createAndSend(notice);
          }
        });
      }
      actions.push({ label: "关闭", variant: "ghost", onClick: () => clearComposerAlert() });
      showComposerAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions,
        dismiss: true
      });
    } finally {
      setBusy("");
      updateRunHeader();
      updateComposer();
    }
  }

  function armCancel() {
    if (!canCancel() || state.busy) return;
    state.cancelArmed = true;
    dom.cancel.textContent = "再次点击确认取消";
    state.cancelTimer = window.setTimeout(() => disarmCancel(), 4000);
  }

  function disarmCancel() {
    state.cancelArmed = false;
    if (state.cancelTimer) {
      window.clearTimeout(state.cancelTimer);
      state.cancelTimer = null;
    }
    dom.cancel.textContent = "取消运行";
  }

  async function cancelRun(options = {}) {
    if (!canCancel() || state.busy || !state.run) return;
    if (!options.confirm && !state.cancelArmed) {
      armCancel();
      return;
    }
    disarmCancel();
    const runId = state.run.id;
    setBusy("正在请求取消…");
    clearRunAlert();
    try {
      const data = await api(`/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: {}
      });
      const nextState = isObject(data) && isObject(data.run) && typeof data.run.state === "string"
        ? data.run.state
        : "cancelled";
      if (!state.run || state.run.id !== runId) return;
      state.run = { id: runId, state: nextState };
      state.terminal = true;
      closeStream(true);
      addTimelineNote("已请求取消；实际停止状态以云端会话为准。", "warning", "cancel-requested");
      showRunAlert({
        tone: "info",
        title: "已请求取消",
        message: "发送入口已封住，不会重发通知。可刷新状态核对云端会话。",
        actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }],
        dismiss: true
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后取消运行。");
        return;
      }
      const info = describeError(error, "cancel");
      showRunAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions: [
          { label: "重试取消", onClick: () => cancelRun({ confirm: true }) },
          { label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }
        ]
      });
    } finally {
      setBusy("");
      updateRunHeader();
      updateComposer();
    }
  }

  /* Restore and boot */

  async function restoreRun(runId) {
    if (!RUN_ID.test(runId)) {
      clearSavedRunId();
      showIdleRun();
      return;
    }

    setBusy("正在恢复运行…");
    clearRunAlert();
    clearComposerAlert();
    setConnection("idle");
    try {
      const snapshot = await api(`/runs/${encodeURIComponent(runId)}`);
      closeStream(false);
      disarmCancel();
      resetRunView();
      applySnapshot(snapshot);
      saveRunId(runId);
      renderRunSections(true);
      if (state.session) {
        try {
          await loadHistory(runId);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 409)) throw error;
        }
      }
      updateRunHeader();
      updateComposer();
      if (state.terminal) setConnection("done");
      else if (shouldStream()) connectStream();
      else setConnection("idle");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized("登录状态已失效，请重新登录后恢复运行。");
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        // 404 不默默丢编号：保留原 ID 供核查，避免创建响应丢失后被静默换号。
        showIdleRun();
        showComposerAlert({
          tone: "warning",
          title: "找不到该运行，需核对",
          message: `已保留运行编号 ${shortId(runId)}，不会自动换号或重发。创建响应可能已丢失，请核对后重试。`,
          actions: [
            { label: "重新核对", onClick: () => restoreRun(runId) },
            {
              label: "清除恢复记录",
              variant: "ghost",
              onClick: () => {
                clearSavedRunId();
                clearComposerAlert();
                showIdleRun();
              }
            }
          ],
          dismiss: true
        });
        return;
      }
      const info = describeError(error, "restore");
      if (!state.run) {
        resetRunView();
        renderRunSections(false);
        updateRunHeader();
        setConnection("idle");
      }
      showComposerAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions: [
          { label: "重试恢复", onClick: () => restoreRun(runId) },
          {
            label: "开始新整理",
            variant: "ghost",
            onClick: () => {
              clearSavedRunId();
              showIdleRun();
            }
          }
        ],
        dismiss: true
      });
    } finally {
      setBusy("");
      updateRunHeader();
      updateComposer();
    }
  }

  async function bootSession() {
    if (state.booting) return;
    state.booting = true;
    clearComposerAlert();
    clearRunAlert();
    setInit("checking", "正在检查登录…");
    updateComposer();

    try {
      const authed = await checkAuth();
      if (!authed) {
        setInit("idle", "登录后检查服务");
        if (!state.run) showIdleRun();
        updateComposer();
        return;
      }

      // 页面加载/刷新只做 GET：身份校验 + 按已持久化编号只读恢复。初始化留给提交时执行。
      setInit("idle", "提交时检查服务");

      const savedRunId = readSavedRunId();
      if (savedRunId) {
        await restoreRun(savedRunId);
      } else if (!state.run) {
        showIdleRun();
      }
      updateComposer();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized();
        return;
      }
      const info = describeError(error, "boot");
      setInit("error", "服务不可用");
      if (!state.run) {
        resetRunView();
        renderRunSections(false);
        updateRunHeader();
        setConnection("idle");
      }
      showComposerAlert({
        ...info,
        code: error instanceof ApiError ? error.code : undefined,
        actions: [{ label: "重试", onClick: () => bootSession() }],
        dismiss: true
      });
    } finally {
      state.booting = false;
      updateComposer();
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.busy || state.booting) return;
    clearComposerAlert();

    if (!state.authed) {
      showAuthBanner("请先使用 Qoder 账号登录，再创建运行。");
      return;
    }

    if (state.run) {
      if (["creating", "sending", "uncertain"].includes(state.run.state)) {
        await refreshSnapshot({ fromUser: true });
        return;
      }
      if (state.run.state === "submitted" && !state.terminal) {
        showComposerAlert({
          tone: "info",
          title: "当前运行尚未结束",
          message: "SSE 断线只会重连，不会重发通知。可以刷新状态，或取消运行后开始新一轮。",
          actions: [{ label: "刷新状态", onClick: () => refreshSnapshot({ fromUser: true }) }],
          dismiss: true
        });
        return;
      }
    }

    const notice = dom.notice.value;
    const bytes = byteLength(notice);
    if (!notice.trim()) {
      showComposerAlert({
        tone: "danger",
        title: "请粘贴通知原文",
        message: "至少需要一段非空白文本。",
        dismiss: true
      });
      dom.notice.focus();
      return;
    }
    if (bytes > MAX_NOTICE_BYTES) {
      showComposerAlert({
        tone: "danger",
        title: "通知超过大小限制",
        message: "通知上限 64 KiB，请缩短正文后重试。",
        dismiss: true
      });
      return;
    }

    const ready = await initializeService(true);
    if (!ready || state.busy) return;

    if (state.run && state.run.state === "ready") {
      await sendCurrentRun(notice);
      return;
    }
    await createAndSend(notice);
  }

  function bindEvents() {
    dom.themeButton.addEventListener("click", cycleTheme);
    dom.form.addEventListener("submit", onSubmit);
    dom.notice.addEventListener("input", updateByteCount);
    dom.notice.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        dom.form.requestSubmit();
      }
    });
    dom.cancel.addEventListener("click", () => cancelRun());
    dom.refresh.addEventListener("click", () => refreshSnapshot({ fromUser: true }));
    dom.initRetry.addEventListener("click", () => initializeService(true));
    dom.previewClose.addEventListener("click", closePreview);
    dom.previewDownload.addEventListener("click", () => {
      if (state.preview.artifact) downloadArtifact(state.preview.artifact);
    });
    window.addEventListener("online", () => {
      if (state.run && state.connection === "closed" && shouldStream()) reconnectStream();
    });
  }

  function init() {
    applyTheme();
    bindEvents();
    renderUser();
    setInit("checking", "正在检查服务…");
    setConnection("idle");
    setRunStatus("未开始", "neutral");
    renderRunSections(false);
    updateRunHeader();
    updateCounts();
    updateByteCount();
    closePreview();
    bootSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
