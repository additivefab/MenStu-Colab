# 缺口清单：缺失 / 部分 / 已验证 / 未知

基准：`46de41a`。状态定义如下：

- **已验证**：读过代码，有自动化测试，并且本轮测试全部通过；
- **部分**：有实现，但缺少设计包要求的关键属性；
- **缺失**：代码中不存在；
- **未知**：缺少权限或环境，无法核实。

README 中的说法不作为已验证的依据。

## 1. 已验证（本地自动化测试，336/336 通过）

| 能力 | 证据 |
|---|---|
| 服务端角色和学生范围隔离（学生只能访问本人，导师限于分配范围，审核需要 `can_review`） | `lib/authorization.ts:19-41`；`tests/access-policy.test.mjs`、`tests/student-scoped-reads-worker.test.mjs` |
| 不能审核自己提交的进展 | `lib/authorization.ts:33`、`app/api/reviews/route.ts:170`；`tests/research-workflow-source.test.mjs:48` 只断言源码中有这句文本，`tests/dual-persona-source.test.mjs` 覆盖双身份场景；这两个测试都不是 HTTP 行为测试 |
| 本地账号签发时固定授权角色，学生升级为管理员后不能沿用学生密码 | `lib/local-auth-service.ts:9-13`；`tests/administrator-logins.test.mjs` |
| 附件范围鉴权、大小和类型白名单 | `app/api/progress/files/route.ts:34`、`lib/progress-attachments.ts`；`tests/progress-attachments.test.mjs` |
| 迁移专属表不能由运行时伪造，0026 缺失时拒绝服务 | `lib/database.ts:161-167`；`tests/research-loop-schema-worker.test.mjs`、`tests/migration-upgrade.test.mjs` |
| 科研闭环契约：规范 JSON、RunSpec 哈希、路径策略、metrics 校验 | `lib/research-loop/contracts.ts`；`tests/research-loop-contract.test.mjs`（6 项） |
| 本地 D1 迁移后开发服务器 schema 检查通过（本轮新增脚本） | `npm run db:migrate:local` + `/api/health/ready` 的 `schema: pass`（见 `baseline.md` §3.2） |

## 2. 部分

| 能力 | 已有 | 缺少（对应设计包或验收 ID） |
|---|---|---|
| 讨论 → 研究任务 | 导师意见有下一行动、期限、验收标准、核验方式 | 允许修改范围、预算、不可变版本快照、确认流程（任务契约表已建，服务由 W3 实现） |
| 仓库绑定 | 只有链接、owner/repo 和可见性记录，带审计 | GitHub 稳定 ID、安装授权、撤权同步；学生可以自行修改绑定（见 F-05，T02/T03） |
| 证据追溯 | 进展证据 SHA-256、修订、审计 | 执行 SHA、数据版本、环境摘要、run_id、指标来源（T18） |
| 受保护路径策略 | 契约中有默认列表 | 不含环境依赖清单（F-06，T05）；大小写问题（F-07） |
| 可观测性 | 审计表、就绪检查 | 队列、费用、运行对账（T11/T13/T16） |
| 本地开发 | 本轮新增 `db:migrate:local` 和 `dev:admin` | 没有本地种子名册，空库时就绪检查会因名册 fail 返回 503，但不影响登录和开发 |

## 3. 缺失

| 能力 | 设计包 / 验收 ID | 负责工作流 |
|---|---|---|
| GitHub App（token、读树、SHA 解析、发布 PR、webhook） | T02、T03、T06、T07、T08 | W2（目前只有桩：`lib/github/*.ts`） |
| 研究任务 API、代理尝试队列、凭据档案映射 | T01、T04、T05 | W3 |
| 运行登记、批准绑定哈希、租约、对账、结果评审 | T09–T13、T16–T21、T23、T25 | W4 |
| 实验室计算执行器（Apptainer/Slurm、外发闸门） | T11、T13、T15、T17 | W5（`infra/lab-runner` 只有占位） |
| 代理工作进程（Codex/Claude 适配器） | T14、T24 | W6（`infra/agent-worker` 只有占位） |
| 任何 LLM 或代理调用 | 设计包 §4 | W6 |
| 持久任务队列或后台执行 | 设计包 §6 | W3/W4（以 D1 表加租约实现） |
| CI 配置 | 审计清单“自动测试” | 不在本期范围；仓库中没有 `.github/` |
| 备份恢复脚本与演练 | T26 | 不在本期范围 |
| 根许可证文件 | 审计清单“许可证” | 需负责人决定 |

## 4. 未知（需要权限或真实环境）

| 项 | 原因 | 核实方式 |
|---|---|---|
| 生产 D1 的 schema 版本和迁移状态 | 本轮没有访问托管数据库 | 用托管平台的只读工具查询 `app_schema_meta`、`d1_migrations` |
| 生产就绪检查的结果 | 同上。另外代码要求超级管理员**恰好 1 人**（`app/api/health/ready/route.ts:114`），而 README 写的是两名超级管理员（佘阳、于兴华）。如果两人都启用，`operators` 检查会一直是 fail，需要核实哪一边是对的 | 由负责人确认，再调整其中一方 |
| 托管平台的网络边界、密钥管理、资源限制 | 由 OpenAI Sites / Cloudflare 负责，仓库中看不到 | 查平台控制台和文档 |
| 飞书 webhook 在生产环境是否启用加密和签名 | 取决于部署时的环境变量 | 查看就绪检查的 `feishu` 项，或托管环境变量（不读取值） |
| R2 和 D1 的备份策略 | 仓库中没有相关内容 | 由平台和负责人确认 |
| 第三方产品模式的复用是否完全合规 | 只有 `THIRD_PARTY_NOTICES.md` 的声明 | 需要人工法律审查，不属于代码审计 |
| 真实 GitHub、GPU 和数据环境的验收（T02、T14、T15、T22） | 本期没有授权真实资源 | 在后续授权的测试环境中执行 |

## 5. 文档与代码不一致（已修正或已记录）

- README 写“首次请求会在本地 D1 中创建匿名演示数据”，但代码中没有任何演示数据生成逻辑，空库在迁移前返回 503（`lib/database.ts:161-167`）。**已在 README 中修正**，并补充本地初始化步骤。
- README 写“26 名真实学生名册……本地首次启动仍可生成匿名演示数据”，后半句同样不成立，已修正。
- 就绪检查要求超级管理员恰好 1 人，README 写的是两名，见上表，未修改。
