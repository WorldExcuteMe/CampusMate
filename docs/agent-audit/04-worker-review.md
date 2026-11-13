# 04 · Worker 审查

## 重点检查 2：Worker 是否具有可靠任务认领和 Lease

**结论：Complete（逻辑层，InMemory + PGlite 验证）；多进程并发 Not Verified。**

### 认领机制
- `runtime/store.ts InMemoryStore.claimNext`：单线程 JS 内原子，选 queued 或 lease 过期的 running，按 priority↑createdAt↑。
- `runtime/postgres-store.ts PostgresStore.claimNext`：事务 + `WITH picked AS (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE ... RETURNING`，重认领 `attempt+1`。
- PGlite 真实引擎验证：claimNext→running、无其他任务→null（validate-migration.ts）。

### Lease / Heartbeat
- `renewLease(id, workerId, ttl, now)`：限定 `lease_owner=$workerId AND status='running'`，错 owner→false（store.test.ts、PGlite 验证）。
- Worker.executeTask：`setInterval(renewLease, heartbeatMs)`，finally clearInterval。
- lease 过期重认领：worker.test.ts"崩溃重认领"验证 attempt+1、另一 Worker 接管。

### 证据
- worker.test.ts(5)：执行/传输失败/取消/幂等/崩溃重认领。
- postgres-store.test.ts(9)：SKIP LOCKED/lease/ON CONFLICT SQL 与映射。
- validate-migration.ts：真实引擎认领/lease。

## 缺口
- **多进程并发认领**：SKIP LOCKED 语义经 PGlite 单连接验证；多个独立 Worker 进程并发竞争未实测 → **Not Verified**。
- **真实进程崩溃**：lease 过期重认领为时间模拟（now 参数），未真实 kill 进程 → 见 07。
- Worker 当前与 API 同进程（main.ts）；独立进程部署未验证。