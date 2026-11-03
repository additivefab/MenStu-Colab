# 能力映射：现有代码 → 设计包目标对象与能力

基准：`46de41a`。证据强度分四级：

- **代码**：读过实现；
- **测试**：有自动化测试覆盖，且本轮 `npm test` 336/336 通过；
- **运行**：本轮在本地实际运行验证过；
- **声明**：只出现在 README 或文档里，未核实。

README 中的说法一律不作为“已验证”。

## 1. 审计清单逐项（设计包 03）

| 检查项 | 现有实现与证据 | 证据强度 |
|---|---|---|
| 技术栈与构建 | vinext 1.0.0-beta.2（Next App Router on Vite）+ Cloudflare Workers；入口 `worker/index.ts:29`；本地绑定在 `vite.config.ts:15-38` 构造（D1 `DB` → `site-creator-d1` / 占位 ID，R2 `FILES`）；托管配置 `.openai/hosting.json`（OpenAI Sites 托管，项目 ID 不是密钥）。README 的“首次请求会创建匿名演示数据”与代码不符：代码中没有生成演示数据的逻辑，空库在迁移前会被 `lib/database.ts:161-167` 拒绝（返回 503） | 代码 + 运行 |
| 许可证与复用 | 根目录没有 LICENSE 文件，`package.json` 标记为 `"private": true`；`THIRD_PARTY_NOTICES.md` 声明参考了 TUM Thesis Management（MIT）等项目的产品模式，并声明未复制源码 | 代码（复用声明本身未核实） |
| 身份认证 | 飞书 OAuth 交换（`lib/feishu-auth.ts:113`）；本地账号 scrypt（N=16384, r=8, p=5，`lib/local-password.ts:3-4,15-19`），常量时间比较并对未知账号做同样的计算（`lib/local-password.ts:34-40`）；会话令牌随机生成，只存 SHA-256（`lib/feishu-auth.ts:190,351`），Cookie 为 `HttpOnly; Secure; SameSite=Lax`，有效期 14 天（`lib/feishu-auth.ts:9,374-377`）；授权角色在签发时固定（`lib/local-auth-service.ts:9-13`、`localSessionGuardSql` 第 193 行）；按用户名每 15 分钟 10 次、按 IP 100 次限流（`lib/local-auth-service.ts:17`、`lib/local-auth-http.ts:34`） | 代码 + 测试（`tests/local-auth*.test.mjs`、`tests/administrator-login*.test.mjs`）+ 运行（本地登录） |
| 项目级权限 | 服务端角色 superadmin / admin / student / pending（`lib/feishu-auth.ts:423-436`）；学生范围 `canViewStudent` / `canReviewStudent`（`lib/authorization.ts:19-41`），导师按 `mentor_student_assignments.active`，审核还要求 `can_review=1`；不能审核自己的记录（`lib/authorization.ts:33`，以及 `app/api/reviews/route.ts:170`“不能审核由自己提交或代录的进展”）。全部写接口都校验 `assertSameOrigin`（34 个路由逐一核对；只有两个飞书入站接口例外，它们使用签名或 Token） | 代码 + 测试（`tests/access-policy.test.mjs`、`tests/student-scoped-reads-worker.test.mjs`、`tests/role-policy.test.mjs`） |
| 讨论与消息 | 导师意见 `student_guidance_notes`（`db/schema.ts:165`），字段包括下一行动、期限、验收标准、核验方式（自报 / 导师核验）、状态；事件表 `student_guidance_events`（`db/schema.ts:215`）；会议预约与议程（`db/schema.ts:293,348`）；飞书会议纪要导入（`db/schema.ts:820`）。软删除：AI 记录使用 `progress_deletions` 标记（`db/schema.ts:895`） | 代码 + 测试 |
| 数据模型 | 现有对象：学生、进展（含修订 `progress_revisions`，`db/schema.ts:512`）、证据来源（`db/schema.ts:869`）、审计（`db/schema.ts:447`）、论文、方案、里程碑、成果。schema 26 新增科研闭环 22 张表（`db/schema.ts:1006-1385`，`drizzle/0026_research_loop.sql`）。迁移策略：Drizzle SQL 迁移加运行时校验，“迁移专属表”在运行时绝不自行创建（`lib/database.ts:14-29,148-177`） | 代码 + 测试（`tests/migration-upgrade.test.mjs`、`tests/research-loop-schema-worker.test.mjs`） |
| Git 集成 | 只保存仓库首页链接和元数据：`student_repository_bindings`（`db/schema.ts:100`），URL 规范为 `https://github.com/<owner>/<repo>`（`lib/student-repository.ts:43-57`）；不调用任何 GitHub API。GitHub App 读 token 和 SHA 解析目前只是契约桩，永远抛出“未配置”（`lib/github/tokens.ts:10-17`、`lib/github/repository-read.ts:10-18`） | 代码 + 测试（`tests/student-repository*.test.mjs`） |
| 模型接入 | 业务代码中没有任何 LLM 调用。`openai/anthropic/codex/deepseek` 只出现在 `lib/research-loop/contracts.ts` 的提供商枚举里。飞书“AI 总结”只是导入飞书生成的文本（`lib/feishu-message-import.ts`），平台本身不调用模型 | 代码（全仓 grep） |
| 作业执行 | 没有持久任务队列，也没有后台执行器。现有长流程（附件上传、飞书导入）都是请求内的 D1 事务加补偿队列 `progress_file_cleanup_queue`（`db/schema.ts:493`）。`infra/lab-runner`、`infra/agent-worker` 只有占位测试 | 代码 |
| 远端调用 | 没有 SSH、Runner 或 Slurm 接入，也没有拼接 shell 命令的路径 | 代码（grep） |
| 文件安全 | 附件扩展名白名单，单文件 50 MB、总计 80 MB、最多 5 个（`lib/progress-attachments.ts:1-43`）；R2 键由服务端生成（UUID，`lib/progress-attachments.ts:45-48`）；下载时重新校验学生范围（`app/api/progress/files/route.ts:34`），响应带 `attachment`、`nosniff`、`private, no-store`；文件名去掉路径和控制字符（`lib/progress-attachments.ts:12-24`） | 代码 + 测试（`tests/progress-attachments.test.mjs`） |
| 数据出站 | 外发方只有飞书（发卡片，`lib/feishu-auth.ts:164`）。没有云端模型调用，也没有向 GitHub 写入 | 代码 |
| 证据与指标 | 进展证据有 SHA-256（`app/api/progress/route.ts:43-49`）、修订号、审计；没有 Run、Artifact、metrics 概念（这些只在 schema 26 契约中出现） | 代码 |
| Webhook | 飞书事件：加密模式下验证签名（`lib/feishu-events.ts:25-29,49-60`），常量时间比较 Token（`app/api/feishu/events/route.ts:41,48`）；长连接中继使用 HMAC（`app/api/feishu/long-connection/route.ts:21`）。没有 GitHub webhook（契约表 `github_webhook_deliveries` 已建，处理逻辑由 W2 实现） | 代码 + 测试（`tests/feishu-*.test.mjs`） |
| 可观测性 | 追加式审计表：进展、角色变更、本地认证、仓库绑定；就绪检查 `/api/health/ready`（`app/api/health/ready/route.ts:25`）。没有费用、队列或运行对账 | 代码 + 运行 |
| 备份与恢复 | 仓库中没有备份脚本或演练记录；就绪检查把“备份恢复演练”列为 manual（`app/api/health/ready/route.ts` 中的 `backup_restore` 项） | 代码（结论为“未知 / 缺失”） |
| 自动测试 | `npm test` 先构建，再用 Node test runner 运行；Worker 测试用 Miniflare 加载 `dist/server`，并拦截所有外部请求；本轮 336/336 通过，详见 `baseline.md` | 运行 |
| 部署与资源 | 托管在 OpenAI Sites / Cloudflare Workers（`.openai/hosting.json`）；仓库里没有生产 wrangler 配置，网络边界由托管平台负责，无法核实 | 声明 / 未知 |

## 2. 设计包对象 → 本仓库

| 设计包对象 | 现有实现 | schema 26 契约（仅表与共享代码，服务待各工作流实现） |
|---|---|---|
| Project / Membership | 学生档案 `students` + `mentor_student_assignments`（`db/schema.ts:14,141`），一个学生对应一个课题 | 沿用现有表 |
| Discussion / Decision | `student_guidance_notes` / `_events` | `research_tasks.confirmed_version` 记录确认的决定 |
| ResearchTask | 缺失（导师意见有下一行动和验收标准，但没有允许修改范围、预算、不可变版本） | `research_tasks`、`research_task_versions`、`research_task_events`；`lib/research-loop/tasks-core.ts`（`createResearchTask` 幂等，默认受保护路径不可移除） |
| RepositoryBinding | `student_repository_bindings`，只有链接，学生可自行修改 | `repository_links`（GitHub 稳定 ID）、`github_installations` |
| AgentAttempt | 缺失 | `agent_attempts`、`agent_attempt_events`、`agent_credential_profiles` |
| ChangeRequest | 缺失 | `change_requests` |
| RunSpec / Approval | 缺失 | `run_specs`（以 sha256 为主键）、`run_approvals`；`runSpecSha256` 基于 `canonicalJson` 计算（`lib/research-loop/contracts.ts:117-135,219`） |
| Run / Artifact | 缺失 | `runs`、`run_events`、`run_artifacts`、`run_results`；状态机 `RUN_TRANSITIONS`（`contracts.ts:52`） |
| Review / AuditEvent | 进展审核与审计已有，与科研判断分开 | `result_reviews`、`result_comments`，技术有效性与假设结论分开 |
| 实验室执行器鉴权 | 缺失 | `lab_runners` + `lib/lab-runner-auth.ts`（Bearer token 只存 SHA-256，区分 kind） |

## 3. schema 26 科研闭环：契约已写好，服务尚未实现

- 已存在：迁移 `drizzle/0026_research_loop.sql`（22 张表）、Drizzle 定义、`lib/research-loop/contracts.ts`（枚举、状态机、规范 JSON 与哈希、路径策略、metrics 校验、实验室协议 DTO）、`tasks-core.ts`、`lab-runner-auth.ts`、两个 GitHub 桩。
- 测试：`tests/research-loop-contract.test.mjs`（6 项）、`tests/research-loop-schema-worker.test.mjs`（1 项）通过。
- 未实现：所有 API 路由、服务层、GitHub App、实验室执行器、代理工作进程、UI。现阶段只能说“契约已提交”，**不能**说“闭环已实现”。
- 契约层面的观察见 `security-findings.md` 中的 F-06、F-07。
