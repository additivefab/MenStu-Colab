# 安全发现（只列有证据的）

基准：`46de41a`。每条都写明了文件行号和复现方法。“复现”是指在本地或测试替身中可以执行的步骤；本轮**没有**在生产环境验证任何一条。没有证据的猜测不列入本文件，统一放到 `gaps.md` 的“未知”中。

严重程度：高 / 中 / 低 / 提示。

---

## F-01 未激活学生账号使用公开的统一初始密码（中）

- **影响**：已开通但尚未首登改密的学生账号，登录名是姓名拼音缩写（可以猜到），初始密码为统一的 `123456789`，这个密码同时写在源码和 README 中。任何人都能先于本人登录，改成自己的密码，进而取得该学生的本人数据（进展、反馈、附件），并让本人无法登录。首登强制改密只能防止“长期使用初始密码”，防不住“抢先激活”。
- **证据**：`lib/local-password.ts:5`（`INITIAL_STUDENT_PASSWORD`）；`README.md:32`（公开初始密码和登录名规则）；初始化逻辑在 `lib/initial-student-logins.ts:6-42`、`lib/local-only-student-logins.ts:25-32`；登录在 `lib/local-auth-service.ts:128-155`。限流（`lib/local-auth-service.ts:17`，每个用户名 10 次）对已知密码不起作用。
- **复现（本地或测试替身）**：参考 `tests/local-auth-worker.test.mjs` 中 “original account -> activation -> login” 的流程：对任一 `must_change_password=1` 的账号 `POST /api/auth/local/login {username, password:"123456789"}` → 用 `POST /api/auth/local/password` 设置新密码 → 以该学生身份访问接口。
- **预期**：只有本人能激活账号。**实际**：知道登录名的人都能激活。
- **备注**：README 写明这是“按管理员要求”的决定。这里记为已知风险，是否接受由负责人决定。
- **建议修复**：未首登的账号改为每人一个一次性激活链接（现有机制：超级管理员生成 24 小时有效的一次性设置链接），或给统一密码设置截止时间，过期后自动失效；同时从 README 中删除明文初始密码。
- **回归测试**：初始密码过了截止时间，或账号已改用一次性链接后，`login` 返回 401。

## F-02 源码中提交了真实超级管理员的密码哈希（低）

- **影响**：两名真实超级管理员的 scrypt 加盐哈希写在源码里。仓库一旦泄露，攻击者可以离线暴力破解（N=16384, r=8, p=5，属于中等成本）。如果密码强度弱，可能被破解并取得最高权限。
- **证据**：`lib/administrator-logins.ts:3-6`。
- **复现**：读取该文件即可。本轮没有尝试破解。
- **建议修复**：改用一次性激活链接签发管理员凭据（`local-auth-service` 已有激活流程），从源码中删除哈希；如果这两个密码在其他地方也用过，应当更换。
- **回归测试**：用源码扫描测试断言 `lib/` 中不出现 `scrypt:16384:8:5:` 字面量。

## F-03 未鉴权的就绪接口泄露运营元数据（低）

- **影响**：`GET /api/health/ready` 不需要登录，返回有效学生人数、已绑定账号数、超级管理员和管理人员人数、飞书与 R2 的配置状态。不含姓名，但可以用来侦察。
- **证据**：`app/api/health/ready/route.ts:25-140`，路由中没有 `requireAppUser`。
- **复现（本轮实际执行）**：在本地开发服务器上执行 `curl http://localhost:<port>/api/health/ready`，不带 Cookie 也返回完整 checks（包括“超级管理员 1 人 · 管理人员 1 人”）。
- **建议修复**：未登录时只返回 `{ready}` 和状态码，明细只返回给超级管理员。
- **回归测试**：未登录请求的响应中不含 `checks[].detail`。

## F-04 附件下载沿用客户端声明的 Content-Type（低）

- **影响**：上传时直接保存浏览器提供的 `file.type`（可以是 `text/html` 等），下载时原样作为 `Content-Type` 返回。由于同时返回了 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`，主流浏览器不会内联渲染，目前看不到可利用的路径。这里记为纵深防御项。
- **证据**：`lib/progress-attachments.ts:41`；`app/api/progress/files/route.ts:42-46`；`app/api/progress-resolutions/files/route.ts:25`。
- **复现**：上传 `report.txt` 时把类型设成 `text/html`，下载响应头就是 `Content-Type: text/html`。
- **建议修复**：由服务端根据已校验的扩展名映射 Content-Type。
- **回归测试**：上传声明为 `text/html` 的 `.txt` 文件，下载时 `Content-Type` 为 `text/plain`。

## F-05 学生可修改的仓库绑定将成为 GitHub 链接的输入（中，前瞻性，W2 必须处理）

- **影响**：学生可以把自己的 `student_repository_bindings` 改成任意 `owner/repo`（这是现有设计：写操作只校验 `canViewStudent`）。按实施规格 §6.2，`link_repository {studentId}` 会“按学生已有绑定的 full name 在安装范围内解析”稳定 ID。如果学生把绑定改成同一 App 安装范围内的另一位同学的仓库，而超级管理员照常执行 link，该学生的代理和运行就能读取别人的代码，对应 T03（越权仓库）。
- **证据**：`app/api/student-repositories/route.ts:54,70`（写操作使用 `canViewStudent`，学生本人可写）；`docs/科研仓库绑定_2026-11-01.md:26`（“学生只能管理自己”）；规格 `docs/科研闭环_实施规格_v1.md` §6.2 中的 `link_repository`。
- **复现**：目前还不能复现，因为 link 服务尚未实现。这里记为对 W2 的约束。
- **建议修复（W2）**：link 时在管理界面显示解析出的 full name、owner 和稳定 ID，由超级管理员明确确认；学生之后修改或解除绑定时，自动把对应的 `repository_links` 置为 revoked，需要重新 link；可选做法是校验仓库协作者中包含学生登记的 `github_username`。
- **回归测试**：学生修改绑定后，`repository_links` 不再是 active，`agent-attempts start` 和 `runs create` 被拒绝。

## F-06 契约：默认受保护路径没有覆盖环境依赖文件（中，契约问题，需主控处理）

- **影响**：设计包 T05 要求 AI 修改“CI、安全策略或环境依赖”时触发额外审查。`DEFAULT_PROTECTED_PATHS` 覆盖了 CI、密钥和评价协议，但没有覆盖依赖和环境清单，例如 `requirements*.txt`、`pyproject.toml`、`environment*.yml`、`setup.py`、`package.json`、各类 lock 文件、`Dockerfile`、`*.def`（Apptainer）。代理改动依赖后，change request 不会被标记 `requires_extra_review`。
- **证据**：`lib/research-loop/contracts.ts:90-106`。
- **复现**：`evaluatePathPolicy(["requirements.txt"], [], DEFAULT_PROTECTED_PATHS).protectedTouched` 的结果是 `[]`。
- **建议修复**：由主控在契约中补充上述模式（只追加，不改签名）。W3/W6 不需要改代码。
- **回归测试**：在 `tests/research-loop-contract.test.mjs` 中断言上述路径命中 `protectedTouched`。

## F-07 契约：`.git` 与受保护路径匹配区分大小写（低，契约问题）

- **影响**：`normalizeRepoPath` 只拒绝小写的 `.git`，受保护路径的 glob 匹配也区分大小写。如果代理工作进程或执行器的检出位于不区分大小写的文件系统（macOS 默认 APFS、Windows），`.GIT/hooks/...` 这类路径实际会写进 `.git` 目录，`.GitHub/workflows/x.yml` 也能绕过 `.github/**` 规则（GitHub 本身对这个目录名区分大小写，所以后者影响较小）。实验室服务器如果是 Linux 加 ext4/xfs，就不受影响。
- **证据**：`lib/research-loop/contracts.ts:239`；`globToRegExp` 没有 `i` 标志（`contracts.ts:243-261`）。
- **复现**：`normalizeRepoPath(".GIT/config")` 返回 `".GIT/config"`，没有抛错。
- **建议修复**：对 `.git` 做不区分大小写的比较；或在 W6 中规定代理工作区必须位于区分大小写的文件系统，并在收集变更时拒绝大小写折叠后重名的路径。
- **回归测试**：`normalizeRepoPath(".Git/config")` 抛出 `PathPolicyError`。

## F-08 `assertSameOrigin` 接受没有 Origin 头的请求（提示）

- **影响**：没有 `Origin` 头的写请求会被放行。会话 Cookie 是 `SameSite=Lax`，跨站 POST 不会带上 Cookie，而且现代浏览器对跨源 POST 总会发送 Origin，所以目前看不到可利用的路径。这里记为纵深防御项。新增的科研闭环写接口会沿用这一函数。
- **证据**：`lib/feishu-auth.ts:438-441`；`lib/feishu-auth.ts:376`（SameSite=Lax）。
- **建议修复**：对改变状态的方法要求 `Origin` 或 `Sec-Fetch-Site: same-origin` 二者至少有一个。
- **回归测试**：既没有 Origin 也没有 Sec-Fetch-Site 的 POST 返回 403；先确认飞书 webhook 等机器调用不受影响。

---

## 本轮核查后未发现问题的项（附证据，便于复核）

- 会话令牌只存 SHA-256，Cookie 为 HttpOnly + Secure（`lib/feishu-auth.ts:190,374`）。
- 本地密码使用 scrypt，常量时间比较，对未知账号做同样的计算（`lib/local-password.ts:34-40`）。
- 全部 34 个 API 路由中，写接口都校验同源（飞书入站接口改用签名或 Token）。
- 附件下载按学生范围再次鉴权（`app/api/progress/files/route.ts:34`）。
- 实验室执行器 token 只存哈希并区分 kind（`lib/lab-runner-auth.ts:17-22`）。
