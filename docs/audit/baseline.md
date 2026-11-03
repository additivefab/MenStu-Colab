# 审计基线（P0）

审计时间：2026-11-03（CST）。执行人：工作流 W1（Claude Code 代理）。依据：设计包 `03_repository_audit_checklist.md`、`04_CODEX_GOAL.md` P0，以及 `docs/科研闭环_实施规格_v1.md`。

## 1. 版本

| 项 | 值 |
|---|---|
| 仓库 | 本地克隆，远端 `origin/main` |
| 审计基准分支 | `feature/research-loop` |
| 审计基准 HEAD | `46de41a6`（`46de41a Add research loop contract: schema 26, shared types, implementation spec`） |
| 基准的父提交 | `cdb0297`（`Update Site source`，即 `main` 上最后一次站点提交） |
| 工作树 | W1 独立 git worktree，审计开始时干净（`git status` 无改动） |
| 审计范围 | 只读源码、迁移、测试和文档；未访问生产 D1/R2、飞书或 GitHub；未读取任何真实学生数据 |

## 2. 工具链（实际版本）

| 工具 | 版本 | 来源 |
|---|---|---|
| Node.js | v26.3.0（`package.json` 要求 `>=22.13.0`） | `node --version` |
| npm | 11.16.0 | `npm --version` |
| TypeScript | 5.9.3 | `package.json` devDependencies（锁定） |
| ESLint | 9.39.4（含 `eslint-plugin-react-hooks` 7.1.1） | 同上 |
| vinext | 1.0.0-beta.2（Next.js App Router 跑在 Vite 上） | 同上 |
| Vite | 8.0.13 | 同上 |
| @cloudflare/vite-plugin | 1.37.1 | 同上 |
| wrangler | 4.92.0 | `npx wrangler --version` |
| miniflare | 4.20260515.0 | 同上 |
| drizzle-orm / drizzle-kit | 0.45.2 / 0.31.10 | 同上 |
| sqlite3 CLI（仅用于本地核对） | 3.51.0 | `sqlite3 --version` |

环境备注：本机 Homebrew Node 的默认 CA 证书库有问题，涉及网络的命令需要设置 `NODE_EXTRA_CA_CERTS=<Homebrew 的 ca-certificates/cert.pem>`。本次执行的命令都不需要联网。启动 workerd 的命令（构建、Miniflare 测试、开发服务器）在本机可以直接运行。

## 3. 实际执行的命令与结果

依赖：worktree 内 `node_modules` 是指向主检出目录 `node_modules` 的符号链接，未执行 `npm install`。

### 3.1 基准状态（`46de41a`，未做任何修改）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 个错误 |
| `npm run lint` | **失败：4 个错误，0 个警告**（全部为原有问题） |
| `npm test`（先 `vinext build`，再运行 `node --test`，覆盖 54 个 `tests/*.test.mjs` 和 2 个 `infra/feishu-relay/*.test.mjs`） | **336 项测试：通过 336，失败 0，跳过 0，取消 0** |

基准的 4 个 lint 错误：

1. `app/components/student-repository-card.tsx:88` `react-hooks/set-state-in-effect`（effect 中调用 `load()`，`load` 同步执行 setState）
2. `components/progress-resolution-panel.tsx:106` `react-hooks/set-state-in-effect`（effect 中同步重置状态）
3. `components/progress-resolution-panel.tsx:200` `react-hooks/set-state-in-effect`（openRequest effect 中同步 setState）
4. `tests/administrator-logins.test.mjs:58` `@typescript-eslint/no-unused-vars`（解构出的 `authorized_role` 未使用）

做法：先在 W1 分支改完这 4 个文件，再临时换回基准版本运行 lint 和测试，得到上表结果，最后恢复修改。

### 3.2 W1 修改之后（同一 worktree）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，0 个错误 |
| `npm run lint` | 通过，**0 个错误，0 个警告** |
| `npm test` | **336 项测试：通过 336，失败 0，跳过 0** |
| `npm run db:migrate:local`（新增） | 在空的本地 D1 上依次应用 0000–0026，共 27 个迁移，全部 ✅ |
| `npm run dev:admin`（新增） | 创建本地超级管理员；第二次执行输出“already set up”，不改数据库，`local_credentials.version` 仍为 1 |
| `npm run dev -- -p 3417` + `GET /api/health/ready` | `schema` 检查为 `pass`（“schema v26 / 期望 v26”）；`operators` 显示“超级管理员 1 人”，说明开发服务器读取的正是迁移脚本和 dev:admin 写入的那个 SQLite 文件。整体仍返回 503，原因是本地没有学生名册（`roster`、`identity_bindings` 两项为 fail），符合预期 |
| 用 `.local-dev-admin.txt` 中的凭据请求 `POST /api/auth/local/login` | 200；`GET /api/auth/session` 返回 `role: superadmin`；错误密码返回 401 |

### 3.3 未执行 / 无法执行

- 生产或托管环境的任何检查（D1、R2、飞书、GitHub App）：没有授权，结论记为“未知”。
- 浏览器端交互测试：本轮 lint 修复只调整状态更新的时机，没有做浏览器回归。依据是 lint、typecheck 和全量测试通过，以及下文“行为等价性说明”。
- CI：仓库中没有 `.github/` 或其他 CI 配置，也就没有可核对的 CI 结果。

## 4. lint 修复的行为等价性说明

- `student-repository-card.tsx`：组件外层已经以 `key={studentId}` 重新挂载。挂载时的初始状态与原 `load()` 开头的重置完全一致（`loading=true`，其余为空或 false），因此挂载 effect 只需发起请求。setState 全部放进 Promise 回调（`then` / `finally`）。用户点击“重新加载”时仍走 `load()`，先重置再请求，行为不变。
- `progress-resolution-panel.tsx`：
  - 切换学生、条目或 `initialFilter` 时的重置，改为 React 文档推荐的“渲染期依据上一次 key 调整状态”。重置内容与原 effect 加 `load()` 开头完全相同（同时置 `loading=true`、`error=""`），effect 只负责发起请求，并保留原来让在途请求失效的清理逻辑。
  - `filterRequest` / `openRequest` 的“每个 key 只处理一次”，从 ref 改为 state，同样在渲染期处理，并保持原 effect 的执行顺序：filter 先、open 后，二者同时到达时仍以 open 为准。
  - 有一处时序变化：重置所在的那次渲染不再处理 open 请求，要等新数据加载完才处理。原实现可能在同一提交里用上一位学生的旧数据匹配新的 open 请求，现在不会了。
- `administrator-logins.test.mjs`：用“复制后删除字段”替代解构，断言内容不变。
