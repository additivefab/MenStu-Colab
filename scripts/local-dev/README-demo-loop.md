# 科研闭环本地演示（demo-loop）

一条命令在本机跑通整个闭环，并可在浏览器里逐步观看：

确认任务 → 代理修改代码 → 变更请求 → 发布 PR（本地 GitHub 替身）→ 导师批准运行 → 实验室执行器执行 → 结果 → 评审。

不需要真实 GitHub App、模型订阅或 GPU。**所有身份、密钥和数据都是合成的，只在本机使用。**

## 用法

```bash
npm run dev                                                   # 终端 A（已在运行则跳过）
node --experimental-strip-types scripts/local-dev/demo-loop.mjs   # 终端 B
```

第一次运行会写入 `.env.local`，然后提示**重启一次** `npm run dev`（脚本会等待重启，然后自动继续）。之后再运行不需要重启：密钥、端口都复用。

| 选项 | 作用 |
|---|---|
| `--auto` | 设置完成后，用学生 / 导师账号经 HTTP API 自动跑一遍闭环并逐步打印，然后继续运行供浏览器演示 |
| `--auto --exit` | 只跑自动闭环；成功退出码 0，失败 1（用于验证） |
| `--platform-url URL` | 开发服务器地址，默认 `http://localhost:3000`（只接受本机地址） |
| `--github-port N` | GitHub 替身端口，默认 `4610`；改端口后需要重启开发服务器 |
| `--skip-db` | 不检查 / 迁移 / 种子本地 D1 |
| `--remove-env` | 从 `.env.local` 删除演示变量块后退出（之后重启开发服务器） |

Ctrl-C 停止替身、代理工作进程和执行器；开发服务器不受影响，脚本从不启动或结束它。

## 脚本做了什么

1. **本地数据库**：检查 `.wrangler/state` 中的 D1。未迁移则运行 `npm run db:migrate:local`；没有 `local-admin` 则运行 `npm run dev:admin`；没有合成种子（`synthetic-loop-01`、`synthetic-student`、`synthetic-mentor`）则运行 `seed-research-loop.mjs --reset`（只重建种子自己的行，见 `README-research-loop-seed.md`）。
2. **GitHub 替身**（`demo/fake-github.mjs`，改编自 `tests/research-loop-e2e.test.mjs`）：`127.0.0.1:4610` 上的 REST 接口（校验 App JWT 签名、签发单仓库令牌、把 blob/tree/commit/ref 真实写入本地裸仓库、创建 PR、向平台发送签名的 `pull_request` webhook）、git smart HTTP（`git http-backend`，只认它签发且有 contents 权限的令牌，拒绝 push）以及 PR 查看页 `http://127.0.0.1:4610/`（可“模拟合并”：发送 `pull_request.closed` webhook，不改动 main，便于重复演示）。
   演示仓库 `synthetic-lab-org/loop-demo`（id 880001，安装 90000001）与种子中 `synthetic-loop-01` 已有的仓库链接一致。仓库内有 `train.mjs`（读取数据，评测 `src/model.mjs`，写出 `out/metrics.json`，`tanyan.metrics/v1`）、故意少了系数 2 的 `src/model.mjs`、`node --test` 单元测试和评价协议。
3. **开发服务器环境**：在 `.env.local` 中写入一个带标记的块：`GITHUB_APP_ID`、`GITHUB_APP_SLUG`、一次性生成的 `GITHUB_APP_PRIVATE_KEY`、`GITHUB_WEBHOOK_SECRET`、`GITHUB_API_BASE_URL=http://127.0.0.1:4610`。`.env.local` 已被 `.gitignore`（`.env*`）忽略，文件权限 0600，块外的内容保持不动。
   本项目的 Cloudflare Vite 插件通过 wrangler 读取项目根目录的 `.dev.vars`，**没有 `.dev.vars` 时**才读取 `.env` / `.env.local`（启动日志会显示 “Using secrets defined in .env.local”）。如果你有 `.dev.vars`，脚本会提示，需要把演示块复制进去或临时移走它。
4. **登记**（全部经超级管理员 API，与运维操作一致）：同步安装、验证 `synthetic-loop-01` 的仓库链接；登记一个代理工作进程和一个计算执行器（令牌只保存在 `.wrangler/demo-loop/secrets.json`，0600，再次运行时沿用）；把合成学生的 codex 凭据档案（种子中的 `cred_synthstudent`）改指向演示工作进程（只用 codex，这样 `seed-research-loop.mjs --reset` 仍能清理）；登记入口 `demo_train_eval`、数据集「演示合成数据 v1」（清单哈希）并授权给该学生。
5. **实验室进程**（本进程内运行真实的 `infra/` 代码）：
   - `infra/agent-worker` + `FakeAdapter`：脚本化地把 `predict` 改为 `2 * x`，并在工作区真实运行 `node --test`。没有模型参与，消息里也注明“合成演示代理”。先出计划模式会返回一段固定计划。
   - `infra/lab-runner` + local 调度器 + 测试用 apptainer 替身：领取、按批准的 SHA 检出、校验数据清单、运行、外发审查、上报结果。
   - **只读数据**：执行器按 `/data:ro` 挂载数据集，但替身**没有任何隔离**，无法强制挂载；这里靠数据文件 0444、目录 0555 防止作业写入。
6. 创建一个待确认的演示任务（「【演示闭环】修正 predict 的缩放（合成）」），打印浏览器步骤。

## 浏览器步骤（脚本最后也会打印）

1. 用 `synthetic-student` 登录（密码在 `.local-dev-admin.txt` 的 `synthetic_student_password`）。
2. 展开演示任务，「确认第 1 版」，提供商选 Codex，「用第 1 版启动代理」；几秒后变为「已产出修改」。
3. 在变更请求中审阅改动，「发布为 Draft PR」；到 `http://127.0.0.1:4610/` 查看 PR。平台上的 PR 链接是 github.com 格式（平台只接受该前缀），本地不可打开。
4. 「登记运行」：代码版本选该变更请求，入口 `demo_train_eval`，数据集「演示合成数据 v1」，GPU 0。
5. 换 `synthetic-mentor` 登录，核对后「批准此规范」（发起人不能批准自己登记的运行）。
6. 执行器几秒内完成：`accuracy = 1`，产物 `metrics.json`、`predictions.csv`、`logs/job.log`。导师「保存评审」。

## 安全边界

- `lib/github/http.ts` 只在 `GITHUB_API_BASE_URL` 为 `http://localhost|127.0.0.1|[::1][:端口]` 这样的纯本机 origin 时才使用它；其他任何值（https、其他主机、带用户名 / 路径 / 查询 / 片段）都会直接报错，不发出请求，因此不可能把生产环境的 App 令牌转发到别处（`tests/github-api-base-override.test.mjs`）。
- 脚本从不打印密码、会话、执行器令牌、App 私钥或 webhook 密钥；只在内存中读取 `.local-dev-admin.txt`。
- 所有状态都在已忽略的路径中：`.env.local`、`.wrangler/state`（D1/R2）、`.wrangler/demo-loop/`（仓库、数据集、工作目录、令牌）。

## 清理

```bash
node --experimental-strip-types scripts/local-dev/demo-loop.mjs --remove-env   # 然后重启 npm run dev
chmod -R u+w .wrangler/demo-loop && rm -rf .wrangler/demo-loop                 # 删除演示仓库、数据与令牌
```

数据库中留下的演示任务、运行等都是本地合成数据。`seed-research-loop.mjs --reset` 会删除合成学生的任务 / 运行、演示入口（同一仓库 id）、数据授权和 codex 凭据档案，下次启动 demo-loop 时会自动重新登记；演示的两个执行器和数据集版本行不在其清理范围内，可在超级管理员的实验室登记中停用。
