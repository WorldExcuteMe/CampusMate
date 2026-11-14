// 加载 backend/.env 到 process.env（不覆盖已存在的环境变量）。密钥仅服务端本地文件，gitignored。
// 副作用导入：置于入口首行，保证在其他模块读取 env 前加载。
import fs from "node:fs";

function loadEnvFile(): void {
  try {
    const txt = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* 无 .env 文件则忽略 */ }
}

loadEnvFile();