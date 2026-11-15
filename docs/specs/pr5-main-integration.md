# PR #5 整合与main构建

Status: local verified; remote CI/review/main build pending，2026-11-15。用户已授权PR审查、解冲突、重叠功能择优、提交最终PR并基于main构建；沿用明确的主代理独立执行，不派子代理。

基线：本地6697163，远端main=060c09b028ed0750269a8e2e9905d35663346b05，develop=b51deced3a5f4ff075cdae176d0f4be3922a9e5e，PR5=aa89e3d057b3c7e8fa167e00220236a8e59988cc。PR作者coco38622，来自fork，目标develop；相对现有main有136个文件/7043新增/785删除，与本地存在30处内容冲突。已抓取实际refs，工作区初始干净；备份v13。

未发现仓库或祖先AGENTS/agent文件。PR新增.github/CONTRIBUTING.md要求feature→develop→main；沿用该发布链，不直接push受保护分支。develop和main均要求build-test及1名审批，main还要求分支最新。PR5未开放maintainer修改，因此不改写同事fork分支。新建整合分支codex/integrate-pr5-main-20261115；最终发布PR来自develop，审批不足时不绕过保护。GitHub连接器403，已验证本机gh/Git通道可用。

## 取舍与边界

保留已验收T1–T10的用户级存储、原子turn/顺序屏障、原始transcript、provider快照/密钥加密、能力驱动调用/预算、真实任务事件、课表、分章与文件导出。PR的旧Task结果历史投影不替代完整turn机制；进度卡仅作为兼容路径呈现，不伪装后台恢复。吸收首次建档、账号级Repository上下文、Markdown安全排版、任务撤销/过期管理、群同步作用域、核验与依据原子RPC、本地开发基础设施及执行层缺口修复。每项以实际源码和回归结果裁定，不用整文件ours/theirs掩盖功能丢失。

本次是针对PR变更的功能及安全边界审查，security-audit使用定向guidance，不声称全仓六阶段渗透审计。审查阶段只做源码检查；整合后的可信产品代码按工程流程本地验证。保留源引用，不执行PR中安装/数据库/付费模型脚本，不读取真实凭证；不自动启动Docker或应用远程迁移。基于main“构建”指构建包和本地可运行交付；main push会触发现有GitHub Release流水线，不手工发布Sites。

## GWT与测试

| ID | Given / When | Then | 不变条件 / 验证 |
| --- | --- | --- | --- |
| P1 | 同会话身份、复杂任务、刷新/恢复 | 保留T2–T10全部契约与真实文件 | 原有256后端/131前端/10浏览器基线，新增同事回归适配当前接口 |
| P2 | 工具返回error/ok:false/success:false、预算/取消/检查点失败 | 不假成功、不重复未知副作用 | 为发现的真实缺口先复现再修，保留审批/lease fencing |
| P3 | 账号登录/退出/切换/刷新token | Repository与查询缓存按owner隔离，首次档案可读 | 两组Auth回归及真实HTTP夹具 |
| P4 | 核验父报告/证据一项失败或重试 | 原子回滚、同ID同内容幂等、越权拒绝 | 完整组合迁移/PGlite；外部PostgREST另标未验证 |
| P5 | 新界面/Markdown/过期/群同步路径 | 安全排版及来源真伪标识，按钮作用域准确 | 对应单元、浏览器与构建 |
| P6 | 审查通过的整合分支提交PR | CI全绿及必需审批后进入develop/main | 不降低分支保护；有外部等待时给出具体PR和检查状态 |
| P7 | main实际包含整合提交 | 从该main SHA构建并记录产物/hash | 不用feature构建冒充main构建；旧构建保留 |

## 影响面与实施顺序

backend/src/core/{agent-loop,tool-result,companion-client}、runtime/{worker,store,postgres-store}及api/server；web Auth/Repository调用点、AgentChat/Markdown/兼容工具、通知/过期/列表；Supabase两份增量迁移、显式迁移清单与SQL测试；依赖锁、E2E夹具/启动、CI/release脚本、工程文档。基准定位以三方Git diff为准，修后报告给出具体路径和发现证据。

先按域审查新增及重叠实现→建立可回退merge→逐个解决冲突并补缺口红绿→串行类型/全测/组合迁移/构建/浏览器→审核暂存及秘密/无关文件→推整合PR到develop→等所需审批并合并→发布PRdevelop→main→等所需审批并合并→抓取main精确SHA构建并留产物。若保护审批等外部条件阻塞，保留已完成工作，明确未合入/未构建，不能声称全任务完成。

回滚使用整合分支/merge提交回退，不reset或force push原有main/develop/同事分支；不删除数据或改全局Git配置。依赖仅在锁文件整合且审查后按产品构建需要安装，不运行未知生命周期脚本。
