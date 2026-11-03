# 科研闭环本地合成数据（seed-research-loop）

用于在浏览器里核对任务阶段条与“下一步”（前端方案 F1）、来源/谱系链接（F3）和导师决策收件箱（FA1，`lib/research-loop-inbox.ts`）。
数据全部是合成的，只写入本地 `.wrangler/state`（Miniflare 的 D1/R2），从不连接线上数据库。

## 用法

```bash
npm run db:migrate:local      # 本地 D1 迁移
npm run dev:admin             # 本地超级管理员 local-admin
node --experimental-strip-types scripts/local-dev/seed-research-loop.mjs --reset
npm run dev -- --port 3124    # 打开 /students/synthetic-loop-01
```

- 不带 `--reset` 再次运行是幂等的：数据已存在时不写库，只重新打印期望阶段表。旧版本种子留下的数据会提示改用 `--reset`。
- `--reset` 只删除并重建脚本自己拥有的行：三个合成学生（`synthetic-loop-01/02/03`）及其任务、代理尝试、变更请求、运行、结果、指导意见，`local-dev-only:synthetic-*` 账号及其会话，`*_synth*` 编号的登记数据，以及 R2 中 `agent-attempts/att_synth*`、`runs/run_synth*` 下的对象。
- 本地登录：`synthetic-student`（学生视角）、`synthetic-mentor`（导师视角，审核三个合成学生）、`synthetic-mentor-readonly`（分配到 01 但 `can_review = 0`）、`synthetic-mentor-other`（只审核 02，未分配 01）、`local-admin`（超级管理员）。随机密码追加到已被 gitignore 的 `.local-dev-admin.txt`，脚本不打印密码。每次 `--reset` 会重新生成合成账号的密码，旧会话失效。
- GitHub 与实验室标识都是假的；本地未配置 GitHub App，所以“启动代理”“发布 PR”会返回 `GITHUB_NOT_CONFIGURED`。
- 编号固定（`task_synthS01`、`att_synthS04`、`cr_synthS06`、`run_synthS09a` …），便于对照。

## 场景与期望阶段

每张任务卡标题以【Sxx】开头。负责人用 `stage-model.ts` 的 `OWNER_LABELS` 用词。脚本最后会打印同一张表。

| 编号 | 任务 id | 数据情况 | 期望阶段（状态 · 负责人） |
|---|---|---|---|
| S01 | task_synthS01 | 草稿从未确认；来自导师意见《整理错误样本（合成）》 | 任务：第 1 版草稿待确认（学生） |
| S02 | task_synthS02 | v1 已确认，v2 为草稿 | 任务：第 2 版草稿待确认（学生）；第 1 版曾确认 |
| S03 | task_synthS03 | 已确认，没有代理尝试 | 代码：待启动代理（学生） |
| S04 | task_synthS04 | 代理 `running`，有心跳和事件 | 代码：代理运行中（代理） |
| S05 | task_synthS05 | 代理 `failed`，`POLICY_VIOLATION`（改了 data/splits/val.txt） | 代码：代理失败，需调整后重试（学生） |
| S06 | task_synthS06 | 变更 `pending_review`，触及 `src/requirements.txt`，需额外审查 | 代码：变更待额外审查（导师） |
| S07 | task_synthS07 | 变更 `pending_review`，只改允许路径 | 代码：变更待审阅发布（学生） |
| S08 | task_synthS08 | PR #8 `open`，没有运行 | 运行：待登记运行（学生） |
| S09 | task_synthS09 | 运行 #1 `awaiting_approval`，较新的运行 #2 `running` | 运行：运行 #1 待导师批准（导师），优先于运行 #2 运行中（实验室） |
| S10 | task_synthS10 | 运行 `reconciling`（租约第 2 代） | 运行：对账中（实验室） |
| S11 | task_synthS11 | 运行 `failed`，退出码 137，内存不足 | 运行：运行 #1 失败，需调整后重跑（学生） |
| S12 | task_synthS12 | 运行完成，指标有效，评审 `pending`，有一条评论 | 结果：待导师评审（导师） |
| S13 | task_synthS13 | 运行完成，`technical_validity = invalid`（评价协议不一致） | 结果：技术无效，不能验收，待导师退回或要求跟进（导师） |
| S14 | task_synthS14 | 评审 `accepted`，任务仍为 confirmed | 下一轮：已采纳，待决定关闭或开启下一轮（学生或导师） |
| S15 | task_synthS15 | 完整谱系链（见下），评审 `needs_followup` | 下一轮：已创建跟进任务【S15b】（无人需处理） |
| S15b | task_synthS15b | 跟进任务草稿，`source_run_id = run_synthS15a`，`parent_task_id = task_synthS15` | 任务：第 1 版草稿待确认（学生）；来源：S15 运行 #1 的评审 |
| S16 | task_synthS16 | 运行已采纳，PR 已合并，任务 `closed` | 全部完成：任务已关闭（无人需处理） |
| S17 | task_synthS17 | 草稿直接取消 | 任务：已取消，其余阶段不适用（无人需处理） |
| S18 | task_synthS18 | PR #18 `open`，运行 #1 `awaiting_approval`，由 `synthetic-mentor` 登记（`runs.created_by_user_id`） | 运行：运行 #1 待导师批准（导师）；须由另一位导师/管理员批准 |
| S19 | task_synthS19 | 草稿由 `synthetic-mentor` 起草（`created_by_user_id`） | 任务：第 1 版草稿待确认（学生） |
| S20 | task_synthS20 | 变更 `pending_review`，触及 `src/requirements.txt`，需额外审查；代理由 `synthetic-mentor` 发起（`agent_attempts.requested_by_user_id`） | 代码：变更待额外审查（导师）；须由另一位导师/管理员审查 |
| S21 | task_synthS21 | 学生 `synthetic-loop-03` 已停用（`students.active = 0`，`synthetic-mentor` 仍有 `can_review = 1` 的分配）；PR #21，运行 #1 `awaiting_approval` | 运行：运行 #1 待导师批准（导师）；但不进任何收件箱 |

负责人一栏是按方案 §1.2/§1.3 推出的期望值；若 `computeTaskStages` 的规则与此不同，以评审时商定的规则为准，并同步修改脚本中的 `SCENARIOS` 和本表。

## 期望导师决策收件箱（FA1）

规则见 `lib/research-loop-inbox.ts` 文件头：只看可审核的**在读**学生（超级管理员：全部；管理员：`can_review = 1` 的有效分配），不给自己起草的草稿、自己发起的代理的额外审查、自己登记的运行出待办；学生没有待办。脚本最后会打印同一张表。

| 登录 | 范围 | task_confirmation | change_extra_review | run_approval | result_review | 合计 |
|---|---|---|---|---|---|---|
| `synthetic-mentor` | admin，审核 01/02/03（03 已停用） | S01, S02 | S06 | S09（运行 #1） | S12, S13（技术无效） | 6 |
| `synthetic-mentor-readonly` | admin，分配 01，`can_review = 0` | — | — | — | — | 0 |
| `synthetic-mentor-other` | admin，只审核 02（无科研闭环数据） | — | — | — | — | 0 |
| `local-admin` | superadmin，所有在读学生 | S01, S02, S15b, S19 | S06, S20 | S09（运行 #1）, S18 | S12, S13（技术无效） | 10 |
| `synthetic-student` | student | — | — | — | — | 0 |

不出现的原因：
- `synthetic-mentor` 看不到 S15b、S19（本人起草）、S20（代理由本人发起）、S18（本人登记的运行）、S21（学生已停用）。
- 所有人都看不到：S17（已取消）、S09 运行 #2（运行中）、S14/S16（已采纳）、S15（`needs_followup`）、S21（学生已停用，超级管理员也不例外）。
- `synthetic-mentor-readonly` 能打开 01 的档案但不能审核，所以没有待办；`synthetic-mentor-other` 未分配 01，看不到 01 的任何事项。

## 谱系链（F3 / T25）

导师意见《补一组学习率消融（合成）》（`student_guidance_notes`）
→ `task_synthS15`（`source_guidance_note_id`，第 1 版已确认）
→ 代理 `att_synthS15`（`change_ready`，有事件和测试记录）
→ 变更 `cr_synthS15`，PR #15
→ 运行 `run_synthS15a`（已完成，执行 PR 的 head SHA）
→ 结果（指标有效）+ 评审 `needs_followup`（`followup_task_id = task_synthS15b`）
→ 跟进任务 `task_synthS15b`。

## 数据约定

- 提交 SHA 为 40 位、sha256 为 64 位十六进制；任务快照、代理上下文、运行规范的哈希用 `contracts.ts` / `tasks-core.ts` 的同一套函数计算。
- 运行状态通过 `run_events` 逐步记录，每一步都符合 `RUN_TRANSITIONS`；代理过程写入 `agent_attempt_events`；任务的创建、修订、确认、关闭、取消写入 `research_task_events`。
- 变更内容按代理服务的格式存放在 R2 `agent-attempts/<attemptId>/change.json`，`diff_sha256` 与内容一致；已外发的产物存放在 `runs/<runId>/…`。
