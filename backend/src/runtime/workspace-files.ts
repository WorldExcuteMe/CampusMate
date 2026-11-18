import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_READ = 256 * 1024;
const IGNORED = new Set([".git", ".env", "node_modules", "dist", "coverage"]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(path|pathext|systemroot|windir|temp|tmp|tmpdir|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(name),
));

export function includesPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export class WorkspaceFiles {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async resolve(relative: string): Promise<string> {
    const target = this.lexical(relative);
    const actual = await fs.realpath(target);
    if (!includesPath(this.root, actual)) throw new Error("文件链接指向工作区之外");
    return actual;
  }

  private lexical(relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.includes(":") || relative.includes("\0")) {
      throw new Error("请使用工作区相对路径");
    }
    if (process.platform === "win32" && relative.split(/[\\/]/).some((part) =>
      /[. ]$/.test(part) && part !== "." && part !== ".." || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )) throw new Error("不支持保留设备名和歧义路径");
    const target = path.resolve(this.root, relative);
    if (!includesPath(this.root, target)) throw new Error("路径超出工作区");
    return target;
  }

  async list(relative: string) {
    const dir = await fs.opendir(await this.resolve(relative));
    const entries: { name: string; kind: string }[] = [];
    for await (const entry of dir) {
      if (entries.length >= 100) return { entries, truncated: true };
      entries.push({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "link" });
    }
    return { entries, truncated: false };
  }

  async readText(relative: string): Promise<string> {
    const file = await this.resolve(relative);
    if (!(await fs.stat(file)).isFile()) throw new Error("请选择普通文本文件");
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_READ) throw new Error("仅支持不超过 256 KiB 的普通文本文件");
      const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_READ + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_READ || buffer.subarray(0, bytesRead).includes(0)) throw new Error("文件过大或包含二进制数据");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async read(relative: string, start: number, count: number) {
    const lines = (await this.readText(relative)).split(/\r?\n/);
    const page = lines.slice(start - 1, start + count - 1).join("\n");
    const content = page.slice(0, 12000);
    return { path: relative, start, total: lines.length, content, truncated: page.length !== content.length };
  }

  async write(relative: string, content: string) {
    if (Buffer.byteLength(content) > MAX_READ) throw new Error("单次写入上限为 256 KiB");
    const target = this.lexical(relative);
    if (target === this.root) throw new Error("请选择工作区内的文件");
    const parent = await this.resolve(path.relative(this.root, path.dirname(target)) || ".");
    const destination = path.join(parent, path.basename(target));
    const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing && !existing.isFile()) throw new Error("只能写入普通文件");
    const temporary = path.join(parent, ".campusmate-" + randomUUID() + ".tmp");
    await fs.writeFile(temporary, content, { flag: "wx", mode: existing?.mode ?? 0o600 });
    try {
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { path: relative, bytes: Buffer.byteLength(content) };
  }

  async search(relative: string, query: string) {
    const base = await this.resolve(relative);
    const pending = [base];
    const matches: { path: string; line: number; text: string }[] = [];
    let visited = 0;
    const pattern = query.toLocaleLowerCase();
    while (pending.length) {
      const dir = await fs.opendir(pending.pop()!);
      for await (const entry of dir) {
        if (++visited > 750 || matches.length >= 25) return { matches, truncated: true };
        if (IGNORED.has(entry.name) || entry.name.startsWith(".env.")) continue;
        const child = path.join(dir.path, entry.name);
        if (entry.isDirectory()) pending.push(child);
        if (!entry.isFile()) continue;
        const stat = await fs.stat(child);
        if (stat.size > 48 * 1024) continue;
        const buffer = await fs.readFile(child);
        if (buffer.includes(0) || buffer.length > 48 * 1024) continue;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          const offset = line.toLocaleLowerCase().indexOf(pattern);
          if (offset < 0) continue;
          matches.push({ path: path.relative(this.root, child), line: index + 1, text: line.slice(Math.max(0, offset - 60), offset + 260) });
          if (matches.length >= 25) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }

  async run(program: string, args: string[], relative: string, timeoutMs: number) {
    const cwd = await this.resolve(relative);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("执行目录必须是文件夹");
    const executable = program === "node" ? process.execPath :
      /[\\/]/.test(program) ? await this.resolve(program) : program;
    try {
      const result = await run(executable, args, { cwd, env: environment, timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true, shell: false });
      return { exitCode: 0, stdout: result.stdout.slice(-8000), stderr: result.stderr.slice(-4000) };
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      return { error: failed.killed ? "命令超时或超过输出上限，请先核对工作区变化" : "命令未成功完成", exitCode: failed.code ?? null, stdout: failed.stdout?.slice(-8000), stderr: failed.stderr?.slice(-4000) };
    }
  }
}
