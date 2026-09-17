# 鉴权与访问控制 · 实现契约

> 决策来源：决策票 #9 «鉴权与访问控制方案»
> 落地 DDL：`migrations/0002_auth.sql`（**唯一真相**）
> 可复跑实测：`docs/verification/auth-schema-probe.py` / `.out.txt`
> 本文件是**实现契约**，不是决策记录 —— 决策的论证与取舍住在那张票里。

---

## 1. 一句话总纲

**用户名 + 密码**（PBKDF2-SHA256 / 20,000 次 / PHC 单列存储）；会话是**不透明 token 存 D1**
（表内只有它的 SHA-256，明文只存在于 `Set-Cookie` 那一刻）；token 走 **HttpOnly Cookie**；
**滑动 30 天 + 绝对 90 天**；**不开放注册**（`/api/register` 这个端点不存在，不是被禁用）；
鉴权只覆盖 **`/api/*`**，静态资源直出。

---

## 2. 端到端流程

```
① 登录   POST /api/login  →  校验密码（PBKDF2）
                          →  生成 32B CSPRNG token
                          →  cookie 拿明文；D1 存 sha256(token) 的 hex
                          →  Set-Cookie

② 鉴权   每个 /api/* 请求 →  functions/api/_middleware.ts
                          →  取 cookie → 查 session（走 token_hash 唯一索引）
                          →  未撤销 且 未过期  →  放行，挂 context.data.member_id
                          →  否则 401 {"error":"unauthenticated"}

③ 续期   每次通过的请求    →  expires_at = min(now + 30d, absolute_expires_at)
                          →  last_seen_at 仅在距上次更新 > 24h 时才写（写行节流）

④ 登出   POST /api/logout →  置 revoked_at
```

---

## 3. 端点清单

| 方法 | 路径 | 需认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/login` | 否 | **唯一白名单端点** |
| `POST` | `/api/logout` | 是 | 撤销**当前**会话 |
| `GET` | `/api/session` | 是 | 返回 `{member_id, member_name}` —— 前端启动时探测「我是谁」 |
| `POST` | `/api/password` | 是 | 改密码，需旧密码；成功即**全端失效**（见 §5.3） |
| `POST` | `/api/sessions/revoke-all` | 是 | 登出所有设备（含当前） |

### 3.1 请求 / 响应形状

```jsonc
// POST /api/login
// 请求
{ "username": "husir", "password": "…" }
// 200
{ "member_id": 1, "member_name": "胡先森" }
//   + Set-Cookie: fam_session=<43 字符 base64url>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
// 401 —— 用户名不存在或密码错，**同一个形状**
{ "error": "invalid_credentials" }
// 429 —— 触发限速
{ "error": "too_many_attempts", "retry_after": <秒> }
```

```jsonc
// 未认证 / 会话失效 —— **统一形状，不区分**
// 401  { "error": "unauthenticated" }
// 非 GET 且 Origin 不符 —— 403  { "error": "bad_origin" }
```

**为什么「用户名不存在」与「密码错」必须同形**：分开就是在给攻击者做用户名枚举。
配套的**计时侧信道**见 §5.4。

### 3.2 改密码

```jsonc
// POST /api/password
{ "old_password": "…", "new_password": "…" }
// 200 —— 且该成员**全部会话立即失效**（含发起改密的这一条），前端须跳回登录页
{ "ok": true }
```

---

## 4. Cookie 规格

| 属性 | 取值 | 依据 |
|---|---|---|
| 名 | `fam_session` | — |
| 值 | 32 字节 CSPRNG 的 **base64url**（43 字符） | — |
| `Path` | `/` | — |
| `HttpOnly` | **是** | 防 XSS 读取 |
| `Secure` | **是** | 站点为 HTTPS；若站点不是 HTTPS，整个模型本就不成立 |
| `SameSite` | **`Lax`** | 阻断跨站 POST 携带 Cookie；`Strict` 会让外链进入时的首屏请求不带 Cookie，无收益 |
| `Domain` | **绝不设置** | ⚠️ `pages.dev` 在 **Public Suffix List** 的 PRIVATE 段（Cloudflare 2020-09-08 提交）⇒ 只能 host-only cookie |
| `Max-Age` | `2592000`（30 天） | 与滑动窗口一致，每次续期重发 |

---

## 5. 中间件、会话写与限速

### 5.1 中间件位置与覆盖面

- 文件：**`functions/api/_middleware.ts`** —— 只作用于 `/api/*` 下的 Functions。
- **同时**必须配 **`_routes.json`**，把静态路径排除在 Functions 之外：
  官方原文 *"On a purely static project, Pages offers unlimited free requests. However, once you add Functions on a Pages project, all requests by default will invoke your Function."*
  ⇒ 不配 `_routes.json`，每次页面加载的几十个静态请求都会吃掉 10 万/天 的额度。

### 5.2 会话的读写规则

| 动作 | 规则 |
|---|---|
| 签发 | `created_at = now`；`absolute_expires_at = now + 90d`；`expires_at = now + 30d` |
| 滑动续期 | 通过校验后 `expires_at = min(now + 30d, absolute_expires_at)` |
| 活跃时间 | **仅在 `now - last_seen_at > 86400` 时写** —— D1 按写行计费且**索引列写入额外 +1 行**，每请求写一次等于「请求数 × 2」的写行消耗 |
| 绝对上限 | 达到 `absolute_expires_at` 必须重新输密码，滑动无法越过 |
| 撤销 | 置 `revoked_at`；查询一律带 `revoked_at IS NULL` |
| 清理 | 见 §5.5 |

### 5.3 改密码 ⇒ 全端失效（由结构保证，非约定）

`migrations/0002_auth.sql` 的触发器 `trg_credential_gen_kill_sessions` 在
`member_credential.gen` 变化时删除该成员**全部**会话。

- **改密码** = `UPDATE member_credential SET phc = …, gen = gen + 1`
- **透明重哈希** = `UPDATE member_credential SET phc = …, iterations 变了但 gen 不变`

⚠️ 这个区分是**必须的**：若重哈希也踢人，用户会在参数升级那天被自己刚签发的会话踢出
（登录成功 → 重哈希 → 会话被删 → 下一请求 401）。实测已覆盖这两种情形（探针 C1/C2/C3）。

### 5.4 登录限速（防爆破）

**为什么不用平台限速**：免费套餐的 WAF Rate Limiting 只作用在 **zone** 上，而 `*.pages.dev`
**不是 zone** ⇒ 用不了。
**为什么不用 KV**：KV 免费写额度**仅 1,000 次/天**，一次爆破即打爆。

**必须正视的 DoS 放大**：登录失败要写库，攻击者狂打登录端点就能把 D1 的 10 万写行/天
打满，**导致全家正常记账写不进去**（D1 超限后对整个库拒服务）。故本设计有**三层封顶**：

| 层 | 规则 |
|---|---|
| ① 键粒度 | `(username, ip, 小时桶)` 主键；**反复覆盖而非新增行** ⇒ 单键始终只占 1 行 |
| ② 单键上限 | `ON CONFLICT … DO UPDATE SET n = n + 1 … WHERE n < 20` ⇒ **达 20 后不再写库**，直接拒绝 |
| ③ 全局上限 | 登录失败写行数 **≤ 2,000/天**（占日额度 2%）；达顶后只延迟、不落库 |

另有四条：

- **计时侧信道必须堵**：**用户名不存在时，也要对一条固定的假 `phc` 跑一次 PBKDF2**，
  再返回与「密码错」完全相同的 401。否则两条路径的响应耗时差就是一个用户名枚举器 ——
  这会让 §3.1「同一个形状」的防护白做。
- **失败响应固定延迟 500 ms**（`setTimeout` 是 wall time；官方明确 HTTP 请求的 wall time **无限制**，不烧 CPU 配额）。
- **不做账号锁定** —— 2 人自用，锁定会误伤自己打错密码；IP 计数已足够。
- IP 取 **`CF-Connecting-IP`**（客户端无法伪造），**不读 `X-Forwarded-For`**；
  `username` 存**小写归一化**后的值。

⚠️ **未证实**：D1 对 `INSERT … ON CONFLICT DO UPDATE` 的 `rows_written` 计数口径，官方文档
只枚举 INSERT / UPDATE / DELETE。**上线前须用响应里的 `meta.rows_written` 实测复核**，
再据此确认 §5.4 第③层的 2,000 这个数。

### 5.5 清理任务

挂在**已有的**「预算提醒巡检」cron（每日 20:00 CST）流程里，**不新增 cron、不新增 task 值**
（账户级 cron 配额仍余 1 个**空位** —— #15 已决议**不做自动备份、不新增 cron**，
该空位未分配；但任何新增仍须先回 #6 重排）：

```sql
DELETE FROM session       WHERE absolute_expires_at < :now;
DELETE FROM login_attempt WHERE bucket_at < :now - 86400;
```

---

## 6. 建号与密码重置（本地脚本）

**仓库是 public ⇒ 任何密码哈希都绝不能进 git。** `0002_auth.sql` 只建表、**不含任何凭据数据**。

```bash
# 建号 / 重置（两步，输出落在被 .gitignore 覆盖的 .secrets/）
node tools/make-credential.mjs 1 "口令" > .secrets/seed.sql
npx wrangler d1 execute <DB> --remote --file=.secrets/seed.sql
```

脚本产出的 SQL（改密码走 `INSERT … ON CONFLICT DO UPDATE` 并 **`gen = gen + 1`**）：

```sql
INSERT INTO member_credential (member_id, phc, gen, updated_at)
VALUES (1, 'pbkdf2-sha256$20000$<salt>$<hash>', 1, <now>)
ON CONFLICT (member_id) DO UPDATE SET
  phc = excluded.phc, gen = member_credential.gen + 1, updated_at = excluded.updated_at;
```

- `.secrets/` 已加入 `.gitignore`。
- **唯一信任根 = 你能访问 Cloudflare 账号**（D1 与 Workers 都是你的）⇒ 不再造第二条恢复通道，
  也就没有被攻击者利用的恢复入口。
- ⚠️ 必然后果：**既忘了密码又丢了 Cloudflare 账号访问权时，数据救不回来**。备份方案已由 #15
  落定为三层（见 `docs/specs/backup-export-contract.md`），但**第一层 D1 Time Travel 也在
  Cloudflare 账号之内** ⇒ 这条必然后果**不因备份的存在而改变**（这是设计上的有意取舍：
  不造第二条恢复通道，也就没有被攻击者利用的恢复入口）。
- 忘记密码**不需要**任何在线流程：重跑上面的脚本即完成重置。

---

## 7. 上线前门禁（必须逐项实测，不可推断）

| # | 项 | 为什么必须实测 |
|---|---|---|
| 1 | **PBKDF2 迭代 20,000 次的真实 CPU 时间** | 本机基准是 OpenSSL（i5-12400F），**workerd 用 BoringSSL**，且边缘 CPU 未知。官方与 workerd 仓库**均无「迭代次数 → ms」基准**。若超 10 ms，下调迭代次数（允许区间 10,000–50,000） |
| 2 | `_routes.json` 是否真的把静态请求挡在 Functions 之外 | 否则 10 万/天额度被静态资源吃掉 |
| 3 | 中间件能否访问 D1 绑定 | 官方文档只说明绑定经 `context.env` 在「Function code」中访问，**未就 middleware 作专门表述** |
| 4 | `INSERT … ON CONFLICT DO UPDATE … WHERE` | ① D1 是否接受该语法；② `meta.rows_written` 计几行 |
| 5 | `SELECT sqlite_version()` | 本机 SQLite **3.40.1**（探针运行环境）**不是** D1 的版本 |
| 6 | **iOS PWA 内的登录态** | WebKit bug 272325（iOS 17+ PWA 内会话 cookie 偶发回退为旧值 ⇒ 随机登出）状态为 **NEW**。须真机验证，并确认前端 401 兜底生效 |

---

## 8. 给下游票的派生要求

### → «前端信息架构与页面清单»（#11）

1. **必须有登录页**，且它是**唯一无需会话的页面**。**没有注册页**（端点不存在）。
2. **401 一律跳登录页** —— 不得白屏、不得静默失败。这不是防御性编程，是硬要求：
   事实 9（WebKit bug 272325）意味着 PWA 内**会**出现随机登出。
3. **首次在 PWA 里打开必须登录一次**，即使 Safari 里已登录 —— iOS 的 PWA 与 Safari 是
   **两套隔离的网站数据容器**（WebKit 官方 `by design`）。**不要**试图「自动带过登录态」。
   推论：**token 必须走 Cookie 而不是 localStorage**，但四条理由要说准 ——
   ① `HttpOnly` 让 XSS 读不到 token，localStorage 做不到这一点（这条本身就足以定案）；
   ② 「Web 为辅」那条路径跑在 Safari 里，而 Safari 内的脚本可写存储**确实**受 ITP 7 天规则清除；
   ③ ⚠️ 但在 **PWA 内部**，Home Screen web app 的第一方域名被 WebKit **显式豁免**于 ITP 的
   数据清除算法（原文见 §10.2）⇒ **localStorage 在 PWA 里反而不受 7 天规则**。
   所以「localStorage 会被 ITP 清掉」这个常见说法**在本项目的主路径上不成立**，
   别拿它当论据；真正的论据是 ① 和 ④。
   ④ 服务端 `Set-Cookie` 的第一方 Cookie 在出货软件里**没有过期上限**
   （WebKit 工程师原文：*"In shipping software, there's no cap on the expiry of server-set first-party cookies."*）
   ⇒ 30 天 `Max-Age` 会被遵守。
4. 需要一个 **「登出所有设备」** 入口（改密码会自动触发同一效果）。
5. **不做**「只读访客 / 分享链接」—— 见 §9。

### → «部署拓扑定稿»（#12）

6. **Pages Functions 必须绑定 D1**（中间件每请求要查 `session`）。
7. **必须提供 `_routes.json`**，把静态路径排除在 Functions 之外（§5.1）。
8. **不需要任何签名密钥** —— 不透明 token 方案下没有 HS256 secret 之类的 Secrets 要管。
   这是相对 JWT 的一处运维简化。
9. 那个每日 cron 需要能对 D1 执行 §5.5 的两条 DELETE。

### → «备份与导出策略»（#15 —— 已收口）

> ⚠️ **本节 3 条派生要求已由 #15 全部落定**（`docs/specs/backup-export-contract.md` §4）：
> `member_credential` 已列入必备份清单并标 🔴；`session` 与 `login_attempt` 均已从
> 13 张导出表中排除。本节保留原文供追溯，**不再代表未决事项**。

10. **`member_credential` 必须纳入备份** —— 它是「不可由其他表重算」的一类：
    不备份，恢复后就**没人能登录**（因为不开放注册、也无法从密码反推 phc）。
    且它是**敏感数据**，导出物绝不能进 git（票面 Q6 已要求）。
11. **`session` 不必纳入备份** —— 会话可重建（重新登录即可），不备份还少一份敏感面。
12. **`login_attempt` 不必纳入备份** —— 纯运行态计数，过期即清。

---

## 9. 未决缝与已知局限（明确不闭合）

1. **Passkey / WebAuthn 本次不做。** 技术可行（iOS PWA 内可用、`@simplewebauthn/server`
   官方支持 Workers 且是纯 WebCrypto），但 PWA 场景下有 **3 个未修复的 WebAuthn 缺陷**，
   不适合作为唯一入口。`member_credential` 的独立表设计已使其**可以并列后加**，
   不需要改现有表。**这是刻意的未来选项，不是遗漏。**
2. **不做角色区分、不做只读访客链接。** 领域模型里成员恒为 2 位且数据共享
   （每笔 Entry 归属且仅归属一位成员，但两人互见全部）；访客链接一旦存在就是
   一个永久有效的无凭据入口，在公网暴露的仓库里主动省掉这一整类风险。
3. **20,000 这个迭代次数是本机实测推出来的，不是 workerd 的测量值**（见 §7 第 1 项）。
   它落成常量 + 校准流程，而不是一个"已知安全"的数字。
4. **`member_credential.phc` 是单列 PHC 字符串** ⇒ 迭代次数**无法用 SQL CHECK 限定区间**。
   换取的是「换算法 / 提强度不改表结构」。属本票判断，可复议。
5. **`session` 与 `login_attempt` 的清理查询会全表扫描**（探针 V3/V5 如实列出）。
   本票**不修**：两张表的行数由「设备数 / 失败次数」决定而非时间累积，2 人自用为个位数到
   几十行，全扫即最优计划 —— 与 #14 对 `tag` 维度表的判断同构。
6. **`token_hash` 的 CHECK 不区分「哈希」与「恰好 64 位 hex 的明文」**。它挡的是最常见的那种
   误写（把明文 b64url 直接塞进来，43 字符对不上长度），不是全部误写。

---

## 10. 一手事实与实测（供下游复用）

### 10.1 平台事实（Cloudflare 官方，采集 2026-09-16）

| 事实 | 来源 |
|---|---|
| 免费版 CPU **10 ms/请求**；*"Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time."*；HTTP 请求的 wall time **无限制** | `developers.cloudflare.com/workers/platform/limits/` |
| **PBKDF2 迭代次数硬上限 100,000**（workerd `DEFAULT_MAX_PBKDF2_ITERATIONS`），Cloudflare 工程师 2024-01-03：*"in the production environment the current limit will remain for at least some period of time"*，**至 2026-09-16 无状态更新** | workerd `limit-enforcer.h`；`workerd#1346` |
| `pages.dev` 在 **PSL 的 PRIVATE 段**（Cloudflare 提交，2020-09-08） | `publicsuffix/list` commit `255371b` |
| 免费版平台限速只有 **zone** 上的 1 条规则；`*.pages.dev` **不是 zone**；DDoS 防护全计划包含但面向流量型攻击 | `developers.cloudflare.com/waf/rate-limiting-rules/`；`/ddos-protection/` |
| D1 免费：读 **5,000,000 行/天**、写 **100,000 行/天**；**"Indexes will add an additional written row when writes include the indexed column"** | `developers.cloudflare.com/d1/platform/pricing/` |
| Durable Objects **免费可用**（SQLite 后端，写 10 万行/天）；Workers KV 免费写 **1,000/天** | `/durable-objects/platform/pricing/`；`/workers/platform/pricing/` |
| `functions/_middleware.js`（`.ts` 同）**覆盖整个应用**；`_routes.json` 的 `exclude` 优先于 `include` | `/pages/functions/middleware/`；`/pages/functions/routing/` |

### 10.2 浏览器侧事实（WebKit / Apple 官方，采集 2026-09-16）

| 事实 | 来源 |
|---|---|
| **iOS 上「添加到主屏幕」的 PWA 与 Safari 是两套隔离的网站数据容器**（`by design`） | `webkit.org/tracking-prevention`；`bugs.webkit.org/181849#c3`；WWDC23-10120 |
| **ITP「7 天无交互清除」只针对脚本可写存储** —— *"ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction"*；在 bug 237350 中 WebKit 工程师进一步把 Home Screen web app 的 7 天上限限定为「JS 创建的 cookie」与「第三方 CNAME 伪装响应创建的 cookie」，并称 *"Non CNAME-cloaked server-set cookies and HTML storage should not be deleted for the main domain of Home Screen web apps."* | `webkit.org/tracking-prevention`；`bugs.webkit.org/237350` c1 |
| **服务端第一方 Cookie 没有过期上限** —— 回答「服务端下发 HttpOnly、expiry 设 28 天会不会被遵守」时，WebKit 工程师答 *"Yes."*，并称 *"In shipping software, there's no cap on the expiry of server-set first-party cookies."*（同处提到浏览器界有 ~400 天上限的共识，但 *"None of those caps are shipping though."* —— **两条一手陈述互相冲突，均保留**） | `bugs.webkit.org/237350` c7 |
| **Home Screen web app 的第一方域名被显式豁免于 ITP 的数据清除算法** —— *"an explicit exception for the first-party domain of home screen web applications to make sure ITP always skips that domain in its website data removal algorithm. In addition, the website data of home screen web applications is kept isolated from Safari"* | `webkit.org/blog/11338` |
| **WebKit bug 272325**：iOS 17.x 起 PWA 内会话 cookie **偶发回退为旧值** ⇒ 随机登出。状态 `NEW` | `bugs.webkit.org/272325` |
| 附带风险：**WebKit bug 255524** —— Safari 在资源请求与 `fetch()` 上偶发不带 `SameSite=Lax` 会话 cookie。状态 `RESOLVED CONFIGURATION CHANGED`，但报告线程中至 Safari 16.6 仍有人反馈 | `bugs.webkit.org/255524` |
| iOS PWA 内可用 WebAuthn，但存在未修复缺陷；Passkey 经 iCloud 钥匙串同步 | `bugs.webkit.org/291258` 等；`support.apple.com/en-us/102195` |

### 10.3 本机实测（**非 workerd**）

`docs/verification/auth-schema-probe.py`（Python 3.10.11 / SQLite **3.40.1**）
与 `.workbuddy/tmp/wf/pbkdf2_bench.js`（Node 22 / OpenSSL，i5-12400F）：

| 项 | 结果 |
|---|---|
| 断言 | **全数通过**（结构 15 表 / 17 触发器 / 11 显式索引与预期一致） |
| 每请求路径的查询计划 | V1 鉴权 `SEARCH … USING INDEX sqlite_autoindex_session_1 (token_hash=?)`；V2 按成员删 `SEARCH … COVERING INDEX ix_session_member`；V4 限速读 `SEARCH …（三列主键全匹配）` |
| 全扫处 | **2 处**：V3 `SCAN session`、V5 `SCAN login_attempt`（均为每日清理，理由见 §9.5） |
| 限速 upsert | 连打 21 次：单键 `n` 停在 **20**，表内**始终只占 1 行** |
| 触发器 | 改密码踢人 ✅ / 不误伤其他成员 ✅ / **透明重哈希不踢人** ✅ |
| PBKDF2 往返 | 正确密码验回 ✅ / 错误密码被拒 ✅ |
| PBKDF2 耗时（本机） | SHA-256：10k→2.18 ms、25k→5.42 ms、50k→11.13 ms、100k→22.08 ms（Node）；Python/OpenSSL 量级一致（20k→8.38 ms） |

> 探针版本提醒：本文件引用的两份探针跑在**不同 SQLite 版本**上
> （auth 探针 3.40.1；d1 探针 3.53.1），各自在输出首行标注。

### 10.4 一处上游勘误（本票核对发现）

`0001_init.sql` 的显式索引是 **10 个**（8 个 `ix_*` + 2 个 `ux_*`），
不是地图与 `d1-schema.md` 原先写的「11 个」。已在 `d1-schema.md` §10 留下更正记录。
`§5.3` 的逐条消费者表格本身是正确的（10 个索引逐行列全），错的是总数陈述。
