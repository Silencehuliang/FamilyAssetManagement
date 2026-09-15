# Cloudflare 免费套餐（Free plan）部署家庭财务管理系统 — 约束事实清单

> 研究性质：联网检索 **developers.cloudflare.com 官方文档** + 少量社区/博客经验交叉印证。
> 检索口径日期：**2026-09-15**。每条结论附「来源 URL + 文档 Last updated 日期」。
> 标注规则：
> - **[官方明确]** = Cloudflare 官方文档原文写明；
> - **[官方间接]** = 官方文档可逻辑推导（如 Pages Functions 跑在 Workers runtime 上，故适用 Workers 限制）；
> - **[社区经验]** = 社区/博客，非官方权威来源，仅供参考；
> - **[未找到权威来源]** = 官方文档未给出明确数字/说法。
>
> 重要更正：免费版 **不存在 "1MB 响应体限制"**（旧记忆有误），见第 1 节。

---

## 0. 结论速览（先给判断）

| 问题 | 结论 |
|---|---|
| Pages Functions 能否绑 D1/KV/R2/DO/Hyperdrive | **能，全部可绑**（官方列出子集包含全部 5 种） |
| Pages 能否配 Cron Triggers | **不能**（无此页面，Cron 仅 Worker 特性） |
| 标准做法 | **单独建一个 Worker 挂 Cron，绑定同一 D1**（官方模式） |
| 免费 CPU | **10ms/请求**（HTTP 与 Cron 都是 10ms），I/O 等待不计入 |
| D1 单库上限 | **500MB（Free）**，家庭记账量级"用不满" |
| D1 每调用查询数 | **50 次/调用（Free）** |
| Access 保护 | 需**自定义域**（pages.dev 不能直接挂 Access）；2 人免费但**需绑卡验证身份**（不扣费） |

---

## 1. Pages Functions 能力边界

### 1.1 支持哪些绑定
**[官方明确]** Pages Functions 仅支持全部绑定类型的「子集」，文档逐条列出的受支持绑定包括：**KV namespaces、Durable Objects、R2 buckets、D1 databases、Vectorize indexes、Workers AI、Service bindings、Queue Producers、Hyperdrive configs、Analytics Engine、Environment variables、Secrets**。
- 你问的 **D1 / KV / R2 / Durable Objects / Hyperdrive 全部在列，均可在 Pages Functions 中绑定**。
- 来源：<https://developers.cloudflare.com/pages/functions/bindings/>（页面 Last updated 约 2026）

### 1.2 路由约定
**[官方明确]** 基于文件的路由（`/functions` 目录）：
- 静态映射：`functions/index.js` → `/`，`functions/fruits/apple.js` → `/fruits/apple`。
- 单段动态：`functions/users/[user].js` → 匹配 `/users/nevi` 等单段。
- 多段动态：`functions/users/[[user]].js` → 匹配 `/users/nevi`、`/users/nevi/xyz/123` 任意深度。
- `_middleware.js`：放在 `/functions`（或子目录）下，会先于该目录及子目录所有 Pages Functions 的 `onRequest` 运行；`functions/_middleware.js` 作用于整个应用（含静态文件）。可用 `context.next()` 串联多个中间件（如错误处理 + 鉴权）。
- `_routes.json`：`include`/`exclude` 控制哪些路由触发 Function（默认加 Functions 后**所有请求都走 Function**，用 exclude 把静态路径排除可保留「静态请求无限免费」额度）。限制：至少 1 条 include，include+exclude 合计 ≤100 条，每条 ≤100 字符。
- 来源：<https://developers.cloudflare.com/pages/functions/routing/>（Last updated Apr 21, 2026）；<https://developers.cloudflare.com/pages/functions/middleware/>（Last updated Apr 21, 2026）

### 1.3 响应体大小 / 执行时长（免费版）
**[官方明确 + 官方间接]**
- Pages Functions 请求计入 **Workers 套餐配额**（"Requests to Pages functions count towards your quota for Workers plans"）。
- Pages 自身 limits 页未单列 CPU/时长，指向 Workers 平台限制。Workers Free 关键限制：
  - **CPU time：10 ms / 请求**（HTTP 与 Cron 同此值）。
  - **响应体：无强制上限**（"Response body size: No enforced limit"）；CDN 缓存上限 512MB（Free）。
  - 请求体：Free **100MB**。
  - 内存：128MB/isolate；子请求：**50/请求**；每日请求：**100,000**。
  - HTTP 请求墙钟时间**无硬上限**（客户端保持连接即可）；Cron 墙钟上限 15 分钟。
- **更正用户假设**：免费版**没有 1MB 响应体限制**；返回 JSON 报表不受 1MB 限制（但仍建议分页/聚合）。
- 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated Sep 5, 2026）；<https://developers.cloudflare.com/pages/platform/limits/>

---

## 2. Cron Triggers 与 Pages 的关系（关键）

### 2.1 Pages 能否配 Cron
**[官方明确]** **不能。**
- `/pages/configuration/cron-triggers/` 返回 **404**（页面不存在）。
- Cron Triggers 文档整篇只讲 Worker："Cron Triggers allow users to map a cron expression to a **Worker** using a `scheduled()` handler"。
- 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated Sep 4, 2026）；Pages cron 页 404 实测。

### 2.2 标准做法：独立 Worker 挂 Cron + 共享 D1
**[官方明确]** 这正是官方推荐模式：
- 用独立 Worker，写 `scheduled()` handler，在 wrangler 配置 `[triggers]` / `triggers.crons` 里声明 cron 表达式，部署用 `wrangler deploy`。
- D1 是**账户级资源**：`wrangler d1 create` 在账户下创建，绑定靠 `database_id` 引用。Pages 的 wrangler 配置与 Cron Worker 的 wrangler 配置填**同一个 `database_id`** 即可共享同一库。官方文档中 "Build an API to access D1 using a proxy Worker" 与 "Use D1 from Pages" 均表明 Worker 与 Pages 可分别绑定同一 D1。
- 免费账户 **Cron 触发器上限：每账户 5 个**（Workers Free）。你的「每日抓取 + 周报 + 月报」= 3 个，富余；也可只建 1 个每日 Cron，在 handler 内按日期判断是否执行周/月任务。
- Cron 的 CPU 限制：Free 下 **Cron Trigger CPU time 也是 10ms**（墙钟 15 分钟）。A 股抓取要在 10ms CPU 内完成解析+入库（I/O 等待不计入 CPU，见第 3 节）。
- 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>；<https://developers.cloudflare.com/d1/platform/limits/>（Free 5 cron/账户）

### 2.3 绑定是账户级还是项目级 / 并发写入坑
**[官方明确]** 绑定通过 `database_id` 引用，任何绑定了该 id 的脚本（Pages 或 Worker、同账户）都能访问同一库——本质是账户级、按 id 共享，不存在「项目级隔离」。
- **并发坑**：每个 D1 数据库**单线程，一次处理一个查询**；并发过高会先排队，队满返回 **"overloaded" 错误**（"Concurrency and throughput" 段）。
- 对 2 人家庭 + 每日一次 Cron：写入量极小，碰撞概率极低。官方建议对写查询加重试退避（D1 会自动重试只读查询 2 次；写查询需自行重试可重试错误）。
- 来源：<https://developers.cloudflare.com/d1/platform/limits/>（"Concurrency and throughput"）；<https://developers.cloudflare.com/d1/best-practices/retry-queries/>（Last updated Aug 10, 2026）

---

## 3. 免费版 10ms CPU 的真实含义

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated Sep 5, 2026）

### 3.1 CPU time vs wall-clock time 定义
- **CPU time**："CPU time measures how long the CPU spends executing your Worker code. **Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time.**"
- **Wall-clock time**：从调用开始到结束的总耗时，**含等待网络/I/O/异步操作**；与 CPU time 不同。
- HTTP 请求墙钟**无硬上限**；Cron 墙钟 15 分钟。

### 3.2 哪些操作容易吃满 10ms
- 官方原话："Heavier workloads that handle authentication, server-side rendering, or **parse large payloads** typically use 10-20 ms."（鉴权、SSR、解析大响应）
- 易超：大 JSON 的 `JSON.parse`、循环、crypto、正则、重序列化。平均 Worker 约 **2.2ms/请求**。
- 对家庭记账 API 的启示：返回一个月明细时，避免在前端/Function 里对大响应做繁重的 JS 循环/序列化；尽量用 SQL（GROUP BY）在 DB 端聚合，既省 CPU 又省 `rows_read`（D1 按扫描行计费）。

### 3.3 超限后果
- 返回 **Error 1102**，"Worker exceeded resource limits"；dashboard 显示 `Exceeded CPU Time Limits`。
- 偶有内置弹性（不频繁超限不会被立即杀）；**持续超限**则按配置终止执行。Free 无法调高（Paid 可调至 5 分钟）。

---

## 4. D1 能力与限制

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/limits/>（Apr 21, 2026）、<https://developers.cloudflare.com/d1/platform/pricing/>（Apr 21, 2026）、<https://developers.cloudflare.com/d1/sql-api/sql-statements/>（Apr 21, 2026）、<https://developers.cloudflare.com/d1/best-practices/use-indexes/>（Aug 10, 2026）、<https://developers.cloudflare.com/d1/best-practices/read-replication/>（Aug 10, 2026）

### 4.1 SQL 支持度
- 官方声明："D1 is compatible with most SQLite's SQL convention since it leverages SQLite's query engine." 支持的扩展：**FTS5、JSON 扩展（json_extract / json_each 等）、Math functions**。
- **GROUP BY、CTE（WITH）、子查询、窗口函数（ROW_NUMBER/RANK/OVER）** 均为标准 SQLite SQL，由 SQLite 引擎原生支持；官方未逐项列清单，但「兼容 SQLite SQL 约定」+ 启用上述扩展即意味着可用。**索引 `CREATE INDEX` 明确支持**（含多列索引、部分索引 `WHERE`）。
- **例外/坑**：
  - `RETURNING` 在旧 runtime 不支持——**[社区经验]** dev.to 博客称需 `compatibility_date >= 2024-09-23` 才完整支持 SQLite 3.46；非官方限制清单，谨慎对待。
  - **SQLite 确切版本号 [未找到权威来源]**：官方页面只说 "leverages SQLite's query engine"，未给出精确版本号；社区资料称约 SQLite 3.46（需 compatibility_date 2024-09-23+）。生产如需某特性，先实测。

### 4.2 索引 / batch() / EXPLAIN QUERY PLAN
- `CREATE INDEX` / `CREATE UNIQUE INDEX` / 多列 / 部分索引全部支持；索引自动随表更新。
- `EXPLAIN QUERY PLAN` **支持**（官方给出示例，验证是否走索引）；`PRAGMA optimize` 支持。
- 索引不可改：需 `DROP INDEX` 后 `CREATE INDEX`（建议用 D1 migrations 版本化管理）。
- **`batch()` 事务支持**：`env.DB.batch([stmt1, stmt2, ...])`，多条语句在一个事务/往返内执行；批内每条语句仍受单语句限制。
- 来源：<https://developers.cloudflare.com/d1/best-practices/use-indexes/>；<https://developers.cloudflare.com/d1/worker-api/>

### 4.3 「50 次查询」限制的准确表述
**[官方明确]** D1 limits 原文：
> "Queries per Worker invocation (read subrequest limits) **1000 (Workers Paid) / 50 (Free)**"
- 即：**免费版每个 Worker/Pages 调用最多 50 次 D1 查询**，与子请求限制挂钩。
- 月度/周报若用聚合 SQL 通常远少于 50；若 N+1 查询需小心（或用 `batch()` 合并写）。

### 4.4 读写延迟 / 一致性与读副本
- **默认（未开启读复制）**：所有读写都打到「主库实例」（primary database instance），延迟取决于用户到主库物理距离。
- **读复制（Read Replication）是可选、数据库级开启**：开启后异步复制到多区域只读副本，副本可能任意落后（**replica lag**），需 **Sessions API**（bookmark）保证顺序一致性。对 2 人家庭**无需开启**——默认主库模型即可，无副本延迟问题。
- 单库吞吐：单线程，约 1ms/查询 → ~1000 q/s；写需跨多地点持久化，耗时数毫秒。
- 来源：<https://developers.cloudflare.com/d1/best-practices/read-replication/>（Aug 10, 2026）

### 4.5 单库 500MB 上限 → 家庭记账量级（**估算，非官方数字**）
- 官方约束：单库最大 **500MB（Free）**；单行最大 2MB；空库约 **12KB**；空表按列数占几 KB；免费额度：行读 500 万/天、行写 10 万/天、存储总额 5GB（pricing）。超额拒绝查询、不收费。
- **可复核估算**（基于官方单行大小约束自行推算）：
  - 一条交易记录 ≈ `id INTEGER(8B) + 日期 TEXT(~10B) + 分类 TEXT(~16B) + 金额 REAL(8B) + 备注 TEXT(~50B) + 时间戳(~20B) + 账户(~10B)` ≈ 120B 数据；加索引再 +60~100B → **约 200–500 字节/行（含索引）**。
  - 500MB / 250B ≈ **200 万行**；即便按 500B/行 ≈ **100 万行**。
  - 家庭记账 50 笔/天 ≈ 1.8 万行/年 → 100 万行 ≈ **55 年**，200 万行 ≈ **110 年**。
  - **结论**：免费 500MB 对家庭记账实质"用不满"；真正的瓶颈更可能是「50 次查询/调用」与「每日行写 10 万」额度（前者远够，后者家庭级也远够）。
- ⚠️ 上述行字节数为**估算**，请以 `meta.size_after` / `rows_read` 实测为准；非 Cloudflare 官方承诺数字。

---

## 5. Cloudflare Access 保护自建应用

**[官方明确]** 来源：<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>（Apr 17, 2026）、<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>（May 6, 2026）、<https://developers.cloudflare.com/cloudflare-one/plans/>（产品页）

### 5.1 关键前提（务必注意）
- Self-hosted Access 应用要求"一个在 Cloudflare 上的 **active domain / zone**"（域名须在活跃 zone 内）。
- **`*.pages.dev` 不在你自己的 Cloudflare zone 内，不能直接作为 Access 应用主机名** → 必须用你自己的域名（Free zone 即可，免费）为 Pages 项目添加**自定义域**，再在该自定义主机名上建 Access 应用。

### 5.2 邮箱 OTP 登录步骤
1. 把自有域名加到 Cloudflare（Free zone，免费）。
2. Pages 项目 Add custom domain（如 `finance.yourdomain.com`）。
3. Zero Trust → Access controls → Applications → Create → **Self-hosted** → Add public hostname（选你的 zone 域名）→ 设 **Access policy**（Allow，含两名成员邮箱）→ 选择 IdP：开启 **One-Time PIN**（邮箱验证码，无需额外 IdP 配置）或用邮箱 OTP。
4. 设 Session Duration（过期时间）→ Create。

### 5.3 JWT 校验（在 Pages Functions 里）
**[官方明确]** 官方 Workers 示例可直接用于 Pages Functions（本质相同）：
- Access 在请求头加 **`Cf-Access-Jwt-Assertion`**（浏览器也会带 `CF_Authorization` cookie）；官方建议校验 header 而非 cookie。
- **JWKS 端点**：`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`（含 JWK 与 PEM，含当前+上一把密钥）。
- **`aud` 校验**：每个应用有唯一 **Application Audience (AUD) Tag**（Additional settings 复制），验证时 `audience: POLICY_AUD`、`issuer: TEAM_DOMAIN`。
- 推荐 `jose` 的 `createRemoteJWKSet` + `jwtVerify`（自动按 `kid` 匹配），不要硬编码公钥（密钥每 6 周轮换，旧密钥保留 7 天）。
- 最小片段（放在 `functions/_middleware.js` 做统一校验）：
  ```js
  import { jwtVerify, createRemoteJWKSet } from "jose";
  export async function onRequest(context) {
    const token = context.request.headers.get("cf-access-jwt-assertion");
    if (!token) return new Response("Missing CF Access JWT", { status: 403 });
    try {
      const JWKS = createRemoteJWKSet(new URL(`${context.env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
      await jwtVerify(token, JWKS, { issuer: context.env.TEAM_DOMAIN, audience: context.env.POLICY_AUD });
      return context.next();
    } catch { return new Response("Invalid token", { status: 403 }); }
  }
  ```
- 来源：<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>

### 5.4 免费版 50 用户 / 绑卡
**[官方明确]**
- 产品页："**Free Plan $0 forever — Best for teams under 50 users**"；中文区"免费保护最多 50 名用户"。2 人**完全免费**。
- **绑卡要求（重要，针对"尽量不绑卡"诉求）**：官方 "Create a Zero Trust organization" 明确——"If you chose the Zero Trust Free plan, this step [entering payment details] is still needed but you will not be charged." 西语企业页亦写 "A credit card is required for our user-limited Free Plan."
- **结论：2 人使用 $0，但激活 Free 计划仍需绑定支付方式（卡/PayPal）用于身份验证，不会扣费。** 这与"尽量不绑卡"冲突，需提示用户决策。

### 5.5 API 路径是否也被保护
- Access 在**边缘对整個应用主机名**生效：任何到该主机名的请求（含 `/api/*`）若无有效 token 会被重定向登录；合法请求自动带上 `Cf-Access-Jwt-Assertion`。故**页面入口与 API 路径都被边缘保护**。
- 若 API 被脚本/无浏览器 Cookie 的客户端调用，需使用 **Service Token** 或在请求里带上 token。
- **应用内再鉴权**：边缘已挡匿名访问；对敏感写接口可做防御纵深，在 `functions/_middleware.js` 或具体路由里按 5.3 再校验 JWT（可选但推荐）。

---

## 6. 工程结构

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Jun 25, 2026）、<https://developers.cloudflare.com/pages/get-started/>（Aug 21, 2026）、<https://developers.cloudflare.com/workers/configuration/cron-triggers/>

### 6.1 单仓库同时放 Pages + 独立 Cron Worker
官方推荐形态（两个独立 wrangler 配置，不合并）：
```
repo/
  frontend/                 # React + Vite
    dist/                   # 构建输出
    functions/              # Pages Functions
      _middleware.js        # Access JWT 校验（统一）
      api/transactions.js
    wrangler.toml           # Pages 配置（见下）
  cron-worker/              # 独立 Worker（每日抓取 + 周/月报）
    src/index.ts            # scheduled() handler
    wrangler.toml           # Worker 配置（含 triggers.crons + 同 database_id）
```
- **Pages** 部署：`wrangler pages deploy dist`（或 Git 集成自动构建）。Pages 的 wrangler 配置**不能含 `main`**（那是 Worker 专用），必须有 `pages_build_output_dir`。
- **Cron Worker** 部署：`wrangler deploy`，配置含 `name`、`main`、`triggers.crons`、`d1_databases`（同 `database_id`）。
- 两者通过**同一个 D1 `database_id`** 共享数据库；各自 wrangler 文件独立，互不影响。

Pages `wrangler.toml` 最小片段：
```toml
name = "family-finance"
pages_build_output_dir = "./dist"
compatibility_date = "2026-09-15"
compatibility_flags = ["nodejs_compat"]
d1_databases = [{ binding = "DB", database_name = "family", database_id = "<SAME_ID>" }]
```
Cron Worker `wrangler.toml` 最小片段：
```toml
name = "finance-cron"
main = "src/index.ts"
compatibility_date = "2026-09-15"
triggers = { crons = ["0 16 * * *"] }   # 每日 UTC 16:00（A股收盘后）
d1_databases = [{ binding = "DB", database_name = "family", database_id = "<SAME_ID>" }]
```

### 6.2 `*.pages.dev` 免费域名 vs 自定义域名
| 维度 | `*.pages.dev` | 自定义域（自有域 + Free zone） |
|---|---|---|
| 成本 | 免费，无需自有域 | 需自有域加到 Cloudflare（Free zone 免费） |
| SSL | 自动 Universal SSL | 自动 Universal SSL |
| Cookie 域 | 共享 `.pages.dev` | 你自己的域，隔离干净 |
| Access 配置 | **不能直接挂 Access**（不在你 zone） | **可直接建 Access 应用 + 邮箱 OTP** |
| WAF/规则 | 受限 | 可加 zone 级 WAF/规则 |

- **结论**：若要用 Access 登录保护，必须用**自定义域**；`pages.dev` 仅适合公开/无需鉴权的场景。

---

## 7. 风险与建议（综合）
1. **绑卡**：Access（Zero Trust Free）需绑定支付方式验证身份，虽不扣费，与"尽量不绑卡"冲突——请知悉。
2. **Cron 10ms CPU**：每日抓取解析要轻量；用 `fetch()` 拉数据（I/O 不计 CPU），解析+入库控制在 10ms 内。
3. **50 次查询/调用**：报表用聚合 SQL（GROUP BY）而非 N+1；写用 `batch()`。
4. **D1 单线程**：家庭级写入量无压力；写查询加重试退避即可。
5. **读复制**：2 人场景无需开启，默认主库即可，避免 replica lag 复杂度。
6. **Access 必须自定义域**：规划时把"自有域名 + Cloudflare Free zone"算进架构。

---
*本文件为可审计事实清单，所有 [官方明确]/[官方间接] 结论均附 developers.cloudflare.com 来源 URL 与文档日期；[社区经验]/[未找到权威来源] 已单独标注，请勿当作官方承诺。*
