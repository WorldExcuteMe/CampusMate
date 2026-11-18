import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalWorkspaceApi, WorkspacePermission } from "../api/server.ts";
import { PGlitePool } from "./pglite-pool.ts";
import { includesPath, WorkspaceFiles } from "./workspace-files.ts";

interface Identity { owner: string; full_since: number | null; vault_key: string; }

export async function openLocalWorkspace(directory: string, dataHome = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "CampusMate", "workspaces")) {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("工作区必须是已存在的文件夹");
  const canonical = process.platform === "win32" ? root.toLowerCase() : root;
  await fs.mkdir(dataHome, { recursive: true, mode: 0o700 });
  const storage = path.join(await fs.realpath(dataHome), createHash("sha256").update(canonical).digest("hex"));
  if (includesPath(root, storage) || includesPath(storage, root)) throw new Error("请选择与应用数据目录分开的工作区");
  await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const pool = await PGlitePool.create(path.join(storage, "db"));
  try {
    await pool.migrateLocalWorkspace();
    const identity = await pool.transaction(async (tx) => {
      const { rows } = await tx.query<Identity>("select owner, full_since, vault_key from campusmate_local_identity");
      if (rows[0]) return rows[0];
      const owner = randomUUID(), vault_key = randomBytes(32).toString("hex");
      await tx.query("insert into auth.users(id) values ($1)", [owner]);
      await tx.query("insert into campusmate_local_identity(owner,vault_key) values ($1,$2)", [owner, vault_key]);
      return { owner, vault_key, full_since: null };
    });
    const owner = identity.owner;
    let fullSince = identity.full_since === null ? null : Number(identity.full_since);
    const workspace: LocalWorkspaceApi = {
      info: () => ({ owner, name: path.basename(root), permission: fullSince === null ? "ask" : "full" }),
      async setPermission(permission: WorkspacePermission) {
        const changed = permission === "full" ? Date.now() : null;
        const { rows } = await pool.query<{ full_since: number | null }>(
          "update campusmate_local_identity set full_since=case when $1::bigint is null then null else coalesce(full_since,$1) end returning full_since",
          [changed],
        );
        fullSince = rows[0].full_since === null ? null : Number(rows[0].full_since);
      },
    };
    return { pool, storage, workspace, files: new WorkspaceFiles(root), vaultKey: identity.vault_key,
      allowsFull: (createdAt: number) => fullSince !== null && createdAt > fullSince,
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
