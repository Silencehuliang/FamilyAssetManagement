# 部署拓扑定稿 —— 实现契约

> 产出票：[#12 部署拓扑定稿](https://github.com/Silencehuliang/FamilyAssetManagement/issues/12)
> 本文件是**第五份实现契约**（前四份：`quote-parsing-contract.md` / `auth-contract.md` / `offline-sync-contract.md` / `frontend-ia.md`）。
> 本票证据链（一手调研，均已入库）：
> - `docs/research/cloudflare-pages-project-config-facts.md` —— monorepo 布局 / Pages 配置白名单 / `database_id` / preview 与 production / Secrets
> - `docs/research/cloudflare-pages-static-layer-facts.md` —— `_routes.json` / `_headers` / `_redirects` / SPA 回退 / `/sw.js` 缓存头
> - `docs/research/cloudflare-pages-deploy-and-quota-facts.md` —— 三条部署通道 / 构建配额 / Functions 请求计费边界 / Cron 部署 / 本地工具链 / 官方配额数字

---

## 0. 本文件的地位

**本票是消费者，不是定义者。** 部署拓扑建立在下列已冻结结构之上，本文件不得另立口径：

| 来源 | 冻结内容 | 本文件消费点 |
|---|---|---|
| `migrations/0001_init.sql`（#14） | 12 表 / 10 索引 / 16 触发器；迁移文件不得手改 | §3 操作入口、§10 迁移流程 |
| `migrations/0002_auth.sql`（#9） | 鉴权只覆盖 `/api/*`；HttpOnly host-only Cookie（`pages.dev` 在 PSL PRIVATE 段） | §6 同域约束、§6.1 `_routes.json` |
| `migrations/0003_offline.sql`（#10） | `/sw.js` 与 `manifest.webmanifest` 由静态层直出；SW 作用域 `/` | §8 门禁一、§6.3 `_headers` |
| `docs/specs/quote-parsing-contract.md`（#13） | 行情抓取链在 Cron Worker 内；`MON-FRI` 一条 cron | §5 Cron Worker 部署 |
| `docs/specs/frontend-ia.md`（#11） | 前端 SPA + 客户端路由；`dist/` 顶层不得有 `404.html` | §8 门禁二 |
| `CONTEXT.md` | 全部领域术语（唯一术语来源） | 全篇 |

**不在本文件范围内**：前端具体路由字符串（#11 留实现期）；行情抓取算法（#13）；备份策略（#15）；测试策略与 CI（仍留雾区）。

**形态前提**：单仓库、双部署单元 —— **Cloudflare Pages（静态前端 + Functions API）+ 独立 Cron Worker + 共享 D1**，只用**免费套餐**，2 人家庭自用，仓库 **public**，默认分支 **`master`**。

---

## 1. 决议摘要

| 问题 | 决议 |
|---|---|
| Q1 目录结构与配置落点 | `frontend/`（Pages 项目根，含 `functions/`）+ `cron-worker/`（独立 Worker）；两份配置各用 **`wrangler.jsonc`**；**不引入 npm workspaces**；wrangler **v4** |
| Q2 共享 D1 | `database_id` **明文入库**（Pages 侧禁 `secrets` 键 ⇒ 走 Secrets 不可行）；**操作入口单一化** —— 只有 `cron-worker/` 声明 `migrations_dir: "../migrations"` |
| Q3 部署通道 | **Pages = Git 集成**（production branch `master`、root directory `frontend/`、显式 `NODE_VERSION`）+ **关闭非 `master` 分支自动部署**；**Cron Worker = 本地 `wrangler deploy`**（不引入 GitHub Actions） |
| Q4 环境划分 | **不设 staging，只保留「本地 / 生产」两档**（Pages 命名环境只有 `preview` / `production`，没有 staging） |
| Q5 域名与 API | **确认 `*.pages.dev` + API 同域 `/api/*`**（#9 的 host-only Cookie 已使独立域名不可选）；四项配套见 §6 |
| 票面第 6 问 配额核算 | **不是一个待决项，是分析结果** —— 见 §7。唯一接近上限的是 **Cron 触发器 4/5 = 80%**；单请求最紧的是 **CPU 10 ms**（只落在登录路径） |

---

## 2. 目录结构与配置文件落点（Q1 决议）

### 2.1 定型布局

```
repo/
  migrations/                    ← 留在原地不动（地图与 docs/specs 均引用此路径）
  docs/                          ← specs / research / verification
  frontend/                      ← Pages 项目的「Root directory」
    public/                      ← 会被原样复制到 dist/ 的内容
      _routes.json               → 构建后 = dist/_routes.json
      _headers                   → 构建后 = dist/_headers
      manifest.webmanifest
      sw.js
      favicon.ico
    src/                         ← React + Vite 源码
    dist/                        ← Vite 构建输出（= pages_build_output_dir）；顶层不得有 404.html
    functions/                   ← 必须在「Pages 项目根」，不在 dist 内
      _middleware.ts             ← 鉴权中间件（只作用于 /api/* 判定，见 §6.1）
      api/                       ← API 端点（登录 / 会话 / entry / stock / …）
    wrangler.jsonc               ← Pages 配置：必须有 pages_build_output_dir，绝不能有 main
    package.json / package-lock.json
  cron-worker/
    src/index.ts                 ← scheduled() 入口
    wrangler.jsonc               ← Worker 配置：必须有 name + main + triggers.crons + migrations_dir
    package.json / package-lock.json
```

### 2.2 三条已核实事实定形了这个形状

1. **Pages 官方支持 monorepo**：用 dashboard 的 **Root directory (advanced) > Path** 指定子目录；「同一仓库最多 **5 个 Pages 项目**」，且「All project names must be unique even if connected to the same repository」。Cron Worker **不算 Pages 项目**（不占这 5 个名额）。⇒ 本仓库只建 1 个 Pages 项目。
2. **`functions/` 必须在「Pages 项目根」，不能进构建输出目录**。官方逐字："Make sure that the `/functions` directory is at the root of your Pages project (and not in the static root, such as `/dist`)." ⇒ 落 `frontend/functions/`，**不在 `frontend/dist/` 内**。
3. **`_routes.json` / `_headers` / `_redirects` 必须在「构建输出目录」**（官方："It should be placed in the build directory of your project."）。本仓库做法：源文件写 `frontend/public/`，Vite 构建时原样复制到 `frontend/dist/`。

### 2.3 配置文件的选择与硬约束

**两份配置都用 `wrangler.jsonc`**，理由为官方明文：
- 「recommends using `wrangler.jsonc` for new projects」；
- 「some newer Wrangler features will only be available to projects using a JSON config file」；
- 源码中同一目录只取**一个**配置文件，优先级 `wrangler.json` → `wrangler.jsonc` → `wrangler.toml` ⇒ 同目录**不得**并存两份，避免歧义。

**Pages 侧配置（`frontend/wrangler.jsonc`）三必填 + 一禁项**：

| 键 | 要求 | 依据 |
|---|---|---|
| `name` | 必填 | 官方 |
| `pages_build_output_dir` | 必填（本仓库 = `./dist`） | 官方；且**它是源码判定「是否 Pages 配置」的唯一依据** |
| `compatibility_date` | 必填 | 官方 |
| `main` | **绝不能有** | 源码逐字报错：`Configuration file cannot contain both "main" and "pages_build_output_dir" configuration keys.` |

**Worker 侧配置（`cron-worker/wrangler.jsonc`）必填**：`name` + `main` + `compatibility_date`（官方："At a minimum, the `name`, `main` and `compatibility_date` keys are required to deploy a Worker."）+ `triggers.crons`（#6 定稿的 4 条）。

**不引入 npm workspaces**：Pages 构建在 Root directory（`frontend/`）内跑 `npm install`，各单元独立 `package-lock.json` 最直接 —— 避免 workspace 提升导致的构建期依赖解析差异，也避免「cron-worker 的依赖出现在 Pages 构建里」这类隐性耦合。**wrangler 用 v4**。

---

## 3. 共享 D1 的配置与操作入口（Q2 决议）

### 3.1 `database_id` 明文写入两份配置文件并随仓库入库

一手事实：
- `database_id` 在官方体系里是 D1 绑定的**普通必填 `string`**，官方**全部示例**都明文写在配置文件里；
- 它**从未出现在 "Secrets" 机制**中，也不属于「应放进 `.dev.vars` / 环境变量」的内容；
- **Pages 侧配置根本不允许 `secrets` 键**（源码白名单 `supportedPagesConfigFields` 不含 `secrets`，写入会报 `Configuration file for Pages projects does not support "secrets"`）⇒ **「`database_id` 走 Secrets」在 Pages 侧技术上不可行**。

⇒ **决议：明文写入 `frontend/wrangler.jsonc` 与 `cron-worker/wrangler.jsonc`，两处填同一个 `database_id`，随仓库入库。**

**⚠️ 残余风险如实标注**：官方**没有任何一句**承诺「`database_id` 可以安全公开」。本决议的依据是**基于官方设计意图的判断**（它单独不能访问数据；访问数据需要账户级 API token），**不是官方保证**。仓库虽 public，但泄露 `database_id` 不足以读写数据 —— 真正的访问边界是账户凭据与 #9 的自研鉴权。

### 3.2 操作入口单一化

- `migrations/` **留在仓库根不动**（地图与 `docs/specs/*` 均引用此路径）。
- **只有 `cron-worker/wrangler.jsonc` 声明 `migrations_dir: "../migrations"`**。
- D1 的**迁移 / 播种 / 查询一律从 `cron-worker/` 目录跑**（`wrangler d1 migrations apply` / `wrangler d1 execute`）。

理由：
1. 迁移是**数据库级**操作，给两个入口只制造「从哪跑」的歧义；
2. **Pages 配置能否接受 `migrations_dir` 字段无官方明文**（白名单里没有它）⇒ 不在 Pages 侧声明，就不必承担这个不确定性；
3. 官方文档对 `migrations_dir` 的定位正是 monorepo 场景：「for example, if you have a mono-repo setup, and want to use a single D1 instance across your apps/packages」。

---

## 4. 部署通道（Q3 决议）

### 4.1 定型

| 单元 | 通道 | 参数 |
|---|---|---|
| **Pages（静态前端 + Functions）** | **Git 集成** | Production branch = `master`；Root directory = `frontend/`；构建命令 `npm run build`；构建输出 = `dist`；显式设 `NODE_VERSION` 环境变量 |
| **Cron Worker** | **本地 `wrangler deploy`** | 手动执行；不接 CI |

### 4.2 Pages = Git 集成（含关预览的抉择）

**为何选 Git 集成**：本仓库在 GitHub（Git 集成的**唯一两个支持平台**是 GitHub / GitLab），push 即构建，无需另建 CI。

**⚠️ 三条硬约束**：

1. **显式设 `NODE_VERSION`，不依赖 `engines` 探测**。官方 v3 build image 默认 Node **22.16.0**，且明说「在 v3 下**不要依赖 `package.json > engines` 来指定 Node 版本**，要用 `NODE_VERSION` 或 `.nvmrc` / `.node-version`」。（另注：Known issues 页仍写「默认 Node 12.18.0」，与 Build image 页**直接冲突**，两页均保留 ⇒ 更须显式钉版本。）
2. **构建成败只由退出码决定**：「Any non-zero return code will cause a build to be marked as failed」，且「exit code 0 … assets will be uploaded **regardless of if error logs are written to standard error**」⇒ 构建脚本**必须**让 lint / typecheck / 构建任一失败即返回非 0，否则错误会被静默吞掉并照样部署。
3. **关闭非 `master` 分支的自动部署**（dashboard 里关闭 preview branch 自动构建）。

**为何关闭非 `master` 分支自动部署**：核心是**消灭一处「官方未证实」的风险**。事实：Pages 的命名环境只有 `production` / `preview` 两档，且**「preview 部署默认是否复用生产 D1 的绑定」官方全无明文**（两条官方原文可推出互相不一致的两种读法，调研报告**不选边**）。若预览复用生产 D1，则**每次往分支 push 都会得到一个公开可访问、写的是生产数据的站点**。在「2 人自用」场景下，这个收益趋近于零、风险不为零。

**代价与副作用（如实标注）**：
- 关闭后，push 非 `master` 分支**不再产生预览地址**。需要预览时仍可**临时手动** `wrangler pages deploy`（Git 集成项目**仍可用** `wrangler pages deploy` 手动部署；反向不可以 —— Direct Upload 项目**不可**后接 Git 集成）。
- 省下的构建配额是**附带收益**（免费版 500 builds/月，见 §7）。

### 4.3 Cron Worker = 本地 `wrangler deploy`（不引入 GitHub Actions）

**为何不用 GitHub Actions**：
1. **避免把 Cloudflare API token 存进 GitHub** —— 少一处凭据暴露面（仓库 public，任何配置泄漏都不该是部署能力的来源）；
2. 项目本来就有「**本地跑 wrangler 做迁移与凭据播种**」的运维姿态（#9 已定：凭据只经本地脚本 + `wrangler d1 execute` 落地）⇒ 把 Worker 部署并入**同一本 runbook** 最一致。

**代价如实标注**：Worker 侧**无自动部署**，存在「改了代码忘了部署」的风险 ⇒ 由 runbook 缓解：**部署后必须核对 `wrangler deployments list`**（见 §10）。

### 4.4 被否选项

| 被否 | 理由 |
|---|---|
| **两侧都走 GitHub Actions** | ① Pages 项目类型**不可逆**地变成 Direct Upload（「If you choose Direct Upload, you cannot switch to Git integration later.」）；② 要把 Cloudflare API token 存进 GitHub；③ **`wrangler pages deploy` 是否计入 500 builds/月 官方未明文** ⇒ 可能反而消耗配额。 |
| **混合方案**（Pages 接 Git + Worker 走 Actions） | 两套机制并存，仍需在 GitHub 存 token；比「Worker 走本地」多一处凭据面而无实质收益。 |
| **Pages 全走 Direct Upload + 自建 CI** | 同「两侧都走 Actions」的①②③，且额外失去 Git 集成的零配置构建。 |

---

## 5. 环境划分（Q4 决议）

### 5.1 决议：只保留「本地 / 生产」两档，不设 staging

| 档位 | 构成 | 数据 |
|---|---|---|
| **本地** | `wrangler pages dev`（默认 `localhost:8788`，**本身即本地模式，没有 `--local` flag**）；Cron Worker 用 `wrangler dev --test-scheduled` | 本地 D1，落在 **`.wrangler/state`**，**删目录即重置** |
| **生产** | `master` → Git 集成（Pages）；本地 `wrangler deploy`（Cron Worker） | 远端 D1（唯一一份真实数据） |

**事实依据**：Pages 的命名环境**只有 `preview` / `production` 两档，没有官方 staging 档**（源码级校验：写别的环境名直接报错 `The supported named-environments for Pages are "preview" and "production".`）。

**本地与生产物理隔离**：本地 D1 在 `.wrangler/state`；且官方逐字：「A local session does not have access to your production data by default.」+「**It is currently not possible to develop against a *remote* D1 database when using Cloudflare Pages.**」⇒ 本地**不可能**误连生产库。本地种子流程见 §10.2。

### 5.2 Cron Worker 的本地测试

```powershell
cd cron-worker
wrangler dev --test-scheduled
# 另一个终端：
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=30+7+*+*+MON-FRI"
```

⚠️ **路由名是 `/cdn-cgi/local/scheduled`，不是旧写法 `/__scheduled`** —— 当前官方文档里**没有**后者。

### 5.3 被否：给 Worker 加 `[env.staging]`

`[env.staging]` 会**真实多创建一个 Worker**（`<name>-staging`）并占用账户配额，而 staging 的 `triggers.crons` 若不显式清空（`crons: []`）会**真实触发定时任务** ⇒ 制造「测试 cron 打到数据」的新风险。与「2 人自用、不设 staging」不匹配。

---

## 6. 域名与 API 同域（Q5 决议）

### 6.1 决议：`*.pages.dev` + API 同域 `/api/*`

**这一问没有选择余地**：#9 已冻结「不透明 token + HttpOnly Cookie + **host-only（不设 `Domain`）**」，而 `pages.dev` 在 **PSL 的 PRIVATE 段** ⇒ API 若走独立 Worker 域名就是**跨站 Cookie**，host-only 约束与 `Origin` 校验都得重做。⇒ **确认同域**。

### 6.2 四项配套

**① `_routes.json` = 收窄 include 到唯一需要它的前缀**

```json
{ "version": 1, "include": ["/api/*"], "exclude": [] }
```

⚠️ **这与 Pages 官方的写法方向相反** —— 官方示例是 `include: ["/*"]` + 枚举 exclude 静态路径。本决议**收窄 include** 的理由：**「命中 include 但没有对应 Function 文件的路径是否也计一次调用」官方无明文**（调研报告 §6 列为需实测项）。把 include 收到 `/api/*`，可把这个不确定性**直接消除** —— 只有真正有 Function 的路径才会进判定分支。

**必须自写且必须放在 `dist/` 根**：项目里有 `functions/` 时 Pages 会**自动生成**一份 `_routes.json`（官方："This file will be automatically generated if a `functions` directory is detected"），但「自写是否会覆盖自动生成的那份」**官方未明文**（只有第三方适配器层面的线索）⇒ **需在上线后实测核对**（见 §13 局限与 §10.4）。

**② 不写 `_redirects`，且 `dist/` 顶层不得有 `404.html`**

理由见 §8 门禁二。

**③ `_headers` 钉住 SW / manifest / 资源缓存策略**

```
/sw.js
  Cache-Control: no-cache

/manifest.webmanifest
  Cache-Control: no-cache

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

- `/assets/*` 是 Vite 产物，文件名带内容哈希 ⇒ `immutable` 安全。
- ⚠️ **`_headers` 不作用于 Pages Functions 的响应** —— 官方逐字："Custom headers defined in the `_headers` file are not applied to responses generated by Pages Functions, even if the request URL matches a rule defined in `_headers`." ⇒ **`/api/*` 的响应头必须在 Function 代码里 `Response` 上加**（含 `Cache-Control: no-store`、`Content-Type: application/json` 等）。
- 限制：`_headers` 最多 **100 条规则**、每行 **≤2000 字符**；`_headers` / `_redirects` 文件**本身不会被当作静态资源提供**。

**④ Runtime 设 `Fail open`**

Functions 函数路由的**运行时**（Runtime）设为 **Fail open**。含义：**日额度打满时，静态壳仍能打开**（Functions 失效，静态资源照常服务），前端可给一句「服务额度已用尽」，而不是甩一张 Cloudflare 错误页。依据：官方 Pages Functions Routing 页 Fail open / closed 小节。

### 6.3 项目名（决定子域名）

暂定 **`hujia-ledger`**（`.pages.dev` 子域名 = `hujia-ledger.pages.dev`）。

⚠️ **取个不易猜的名字只是降低被扫到的噪声，不构成安全边界** —— 真正的边界是 #9 的自研鉴权（无注册端点 + PBKDF2 + host-only Cookie）。这不是「通过隐蔽性实现安全」的辩护，而是「顺手降低噪声」的陈述。

---

## 7. 配额核算（票面第 6 问 —— 分析结果，非待决项）

### 7.1 官方数字 + 预期用量

| 项 | Free 上限（官方） | 预期用量（估算） | 占用 |
|---|---|---|---|
| **Cron 触发器 / 账户** | **5** | **4**（#6 定稿） | **80%** ← 占比最高 |
| **CPU / 请求** | **10 ms** | 登录路径 PBKDF2 20,000 次 ≈ **4.4 ms**（本机实测） | **≈44%** ← 单请求最紧 |
| Workers 请求 / 天 | 100,000 | **仅 `/api/*` 计**（静态请求免费无限） | < 1% |
| D1 读行 / 天 | 5,000,000 | 列表页几百行/次 | < 1% |
| D1 写行 / 天 | 100,000 | 2 人每天几十笔 ×（1 + 索引行） | < 0.1% |
| D1 存储 / 库 | 500 MB | 行情 ≈0.31 MB/年（#8 估算） | < 1% |
| Pages 构建 / 月 | **500** | 只构建 `master` | 2–6% |
| Pages 并发构建 | **1**（per account） | 单人开发 | — |
| Pages 项目数 | 100（与 Workers 100 分开计） | 1 | 1% |
| Pages 单站点文件数 | 20,000 | Vite 产物远低于此 | < 1% |
| Pages Functions 子请求 | 外部 50 / 内部服务 1,000 | D1 走内部服务口径；单请求远低于 | < 1% |

### 7.2 结论

- **唯一接近上限的是 Cron 触发器（4/5 = 80%）** —— 这也是全系统最稀缺的资源，任何「想加定时任务」的需求都必须先回 #6 重排（把周报/月报合并为「一个每日 cron + 按 CST 日期分派」是可逆的腾挪手段）。
- **最紧的单请求硬预算是 CPU 10 ms，且只落在登录请求上**（PBKDF2）。会话校验是 SHA-256 + 一次索引 D1 查询，远低于此。**其余所有请求都不该接近 10 ms**（D1 查询属 I/O，不计 CPU）。
- **所有日累计额度都在 1% 量级以下**。

### 7.3 ⚠️ 用法列的诚实标注

- **「预期用量」列是估算**（基于已冻结的架构参数推算），**非实测**。实测项列在 §13。
- **两处官方数字自相矛盾，本票按保守侧规划**：
  1. **D1 单请求子请求上限**：D1 Limits 页写 Free **50**，Workers Limits 页 + 2026-02-11 Changelog 写对内部服务 **1,000** ⇒ 本票按 **50** 规划。
  2. **Pages 500 builds/月 的计数口径**：官方**未明文**说明 direct upload 是否计入、preview 是否计入、是每账户还是每项目 ⇒ 本票**只构建 `master`**，把三种口径的不确定性一并压到最低。
- **「静态请求不计数」有官方明文支撑**：「On both free and paid plans, requests to static assets are free and unlimited. A request is considered static when it does not invoke Functions.」**未找到相反表述** —— 这正是 §6.2 ① 收窄 `_routes.json` include 的收益来源。

---

## 8. 两道继承门禁的闭合

本票接收了上游两道**必须核实**的门禁，结论都是**好消息**：

### 8.1 门禁一（#10 留）：`/sw.js` 的默认 `Cache-Control` —— **风险不成立**

- **一手事实**：Pages 对可缓存资产的默认响应头是 **`Cache-Control: public, max-age=0, must-revalidate`**（官方列在 "Headers sometimes added"，条件是「资产可缓存且请求不带 `Authorization` / `Range`」）；且所有 `200 OK` 恒带 `ETag`，可 304。
- **语义**：`max-age=0, must-revalidate` = 「可以存，但每次使用前必须向服务器校验」⇒ **SW 的更新检查不会被 HTTP 缓存挡住**。「SW 永久卡旧版本」这个经典风险在 Pages 默认配置下**不成立**。
- **决议**：仍用 `_headers` **显式钉住** `/sw.js` 为 `no-cache`。**目的从「修 bug」变成「把门禁文档化、防未来默认值变化」** —— 显式化本身有价值，因为它把一条隐式依赖变成可审阅的配置。

### 8.2 门禁二（#11 留）：SPA fallback —— **不需要配置**

- **一手事实**：Pages 在**没有顶层 `404.html`** 时**自动**进入 SPA 模式，把所有未匹配路径映射到根 `index.html`。官方逐字：「If your project **does not include a top-level `404.html` file**, Pages assumes that you are deploying a single-page application… Pages' default single-page application behavior **matches all incoming paths to the root (`/`)**」。
- **决议**：
  1. **不写 `_redirects`** —— Pages 默认已实现 SPA fallback。
  2. **必须保证 `dist/` 顶层不出现 `404.html`**（否则 SPA 模式被关闭，`/entry`、`/stocks` 等前端路由全部 404）。
  3. **反而不能显式写 `/* /index.html 200`** —— 官方：「Redirects are always followed, **regardless of whether or not an asset matches the incoming request**.」⇒ 写了它，**不存在的 `/assets/foo.js` 也会命中 `/*` 被 rewrite 成 HTML 并返回 200**（而不是 404）。这正是「SPA fallback 把缺失资产变成 200 HTML」的经典陷阱，**必须避开**。

---

## 9. 上游派生要求的落点清单（逐条核验）

本票接收上游派生要求，逐条落点如下：

| # | 来源 | 要求 | 落点 |
|---|---|---|---|
| 1 | #9 | Pages Functions 必须绑定 D1 | §2.3 `frontend/wrangler.jsonc` 的 `d1_databases` 绑定 |
| 2 | #9 | 必须提供 `_routes.json`（否则静态请求吃 10 万/天额度） | §6.2 ① |
| 3 | #9 | 不需要任何签名密钥（Secrets 清单如实记为「无」） | §3.1（全系统无 Secrets） |
| 4 | #9 | 每日 cron 需能执行两条 DELETE（清过期 `session` / `login_attempt`），**不新增 cron** | §5 Cron Worker 在既有 cron 内执行；§1（仍占 4/5） |
| 5 | #10 | `/sw.js` 与 `/manifest.webmanifest` 须由静态层直出（`exclude` 需覆盖） | §6.2 ①（include 只留 `/api/*`，静态路径天然不经 Function）+ §6.2 ③ |
| 6 | #10 | `/sw.js` 的缓存头须确保能定期拿到新版 | §8.1（默认已满足，仍显式钉住） |
| 7 | #10 | SW 作用域为 `/` | §2.1（`sw.js` 置于 `public/` 根 ⇒ 构建后为 `dist/sw.js`，作用域 `/`） |
| 8 | #11 | 前端是 SPA + 客户端路由 ⇒ 部署侧必须有 catch-all fallback 到 `index.html` | §8.2（Pages 内建，无需配置） |
| 9 | #11 | `dist/` 顶层不得有 `404.html` | §8.2 决议 2 |
| 10 | #13 | 行情抓取链在 Cron Worker 内，`MON-FRI` 一条 cron | §5.2 本地测试路由；§4.3 部署通道 |
| 11 | #14 | 迁移文件不得手改 | §3.2（迁移一律经由 `cron-worker/` 跑） |
| 12 | #6 | 4 条 cron 编排定稿 | §2.3 `triggers.crons` |

> 本清单为**文本引用核验**，非机器校验 —— 见 §13 局限 4。

---

## 10. 运维 Runbook（部署 / 迁移 / 播种 / 测试）

### 10.1 首次建立 Pages 项目

1. dashboard → Workers & Pages → Create → Pages → Connect to Git → 选 `Silencehuliang/FamilyAssetManagement`。
2. **Root directory (advanced) > Path** = `frontend`。
3. Build command = `npm run build`；Build output directory = `dist`。
4. 环境变量：`NODE_VERSION` = 项目的 Node 主版本（**显式设，不依赖探测**）。
5. **关闭非 `master` 分支的自动部署**（§4.2）。
6. Runtime 设 **Fail open**（§6.2 ④）。

### 10.2 本地开发与本地 D1

```powershell
cd cron-worker
wrangler d1 migrations apply <DB_NAME> --local     # 按序应用 0001/0002/0003
# 运行种子脚本灌假数据（#11 雾区「本地 D1 数据种子」仍待定，见 §12）

cd ../frontend
wrangler pages dev                                   # localhost:8788，连本地 D1
```

- 本地 D1 数据在 **`.wrangler/state`**，**删该目录即重置**。
- 本地**不可能**连远端 D1（官方：Pages 不支持对远端 D1 做本地开发）。

### 10.3 生产迁移与凭据播种

```powershell
cd cron-worker
wrangler d1 migrations apply <DB_NAME> --remote     # 生产迁移
wrangler d1 execute <DB_NAME> --remote --file=../.secrets/seed-credentials.sql
```

- `.secrets/` 已在 `.gitignore`（#9 已加），凭据产物**不得入库**（仓库 public）。
- 迁移**只能追加**，**不得手改既有 0001/0002/0003**（#14/#9/#10 唯一真相）。

### 10.4 部署与核对

```powershell
# Cron Worker
cd cron-worker && wrangler deploy
wrangler deployments list            # ← 必须核对：确认新版本已上线（无自动部署，靠这一步兜底）

# Pages（仅在需要临时预览时手动）
cd ../frontend && wrangler pages deploy dist --project-name=hujia-ledger
```

**上线后必须实测核对三项**（官方未明文，见 §13）：
1. `curl -sI https://<project>.pages.dev/sw.js` → 确认 `Cache-Control` 是预期值、`_headers` 生效；
2. `curl -sI https://<project>.pages.dev/api/<some-route>` → 确认 API 未被 `_headers` 污染、响应头来自 Function 代码；
3. 访问一个前端路由（如 `https://<project>.pages.dev/entry`）→ 确认**不 404**（SPA fallback 生效）；再访问一个**不存在的** `/assets/does-not-exist.js` → 确认返回 **404 而非 200 HTML**（§8.2 陷阱已避开）。

---

## 11. 禁用清单

1. **Pages 侧 `wrangler.jsonc` 不得出现 `main`**（会与 `pages_build_output_dir` 冲突并直接报错）。
2. **不得用 `secrets` 键配 Pages**（源码白名单不含，会报错）。
3. **不得使用 `preview` / `production` 以外的 `[env.*]` 名**（Pages 只认这两个）。
4. **不得在 `frontend/` 与 `cron-worker/` 的同一目录里并存多份 wrangler 配置文件**（源码只取一个，优先级固定 ⇒ 歧义）。
5. **不得写 `_redirects` 做 SPA fallback**（`/* /index.html 200` 会把缺失的 `/assets/*.js` 变成 200 HTML）。
6. **不得在 `dist/` 顶层放 `404.html`**（会关闭 SPA 模式，前端路由全 404）。
7. **不得依赖 `package.json > engines` 指定 Pages 构建的 Node 版本**（v3 下不生效，要用 `NODE_VERSION`）。
8. **不得让构建脚本在 lint / typecheck 失败时仍返回 0 退出码**（Pages 只看退出码，非 0 才算失败；错误日志写 stderr 不影响判定）。
9. **不得把 Cloudflare API token 存进 GitHub**（Worker 走本地部署的核心理由）。
10. **不得给 Worker 加 staging 环境**（会真实多创建 Worker 并可能让测试 cron 真实触发）。
11. **不得把 `/api/*` 的响应头写进 `_headers`**（不作用于 Function 响应，写了是空操作而已，会误导后来者）。
12. **不得把 `.secrets/` 下任何凭据产物提交入库**（仓库 public）。

---

## 12. 未决缝与留给下游

| 项 | 状态 | 归属 |
|---|---|---|
| 测试策略与 CI（wrangler 本地测试、D1 本地实例的具体形态） | **仍留雾区** | 后续票 / 实现期 |
| 本地开发环境的 D1 数据种子与假数据 | **仍留雾区** | 后续票 / 实现期 |
| 导出格式规范（CSV / JSON schema） | **已由 #15 落定** | `docs/specs/backup-export-contract.md` §6 |
| 数据归档与冷备 | **已由 #15 落定**（三层备份：D1 Time Travel + 手动导出 + 「迁移前先导出」runbook） | `docs/specs/backup-export-contract.md` §3 |
| HTTP API 侧的可观测性与 Error 1102 监控 | **仍留雾区** | 后续票 / 实现期 |
| 第三方推送渠道的具体选型 | **仍留雾区** | 后续票 |
| 图表库选型与可视化交互细节 | **仍留雾区** | 后续票 / 实现期 |
| `hujia-ledger` 项目名 | **暂定**（可改，改名即换子域名） | 实现期 |
| `cron_run.task` / `report_delivery.channel` 的 CHECK 枚举 | 本票**未锁死** | 若需枚举请回 #14 复议 |
| 前端 12 页的确切路由字符串 | 未定 | 实现期 |

---

## 13. 已知局限（如实标注）

1. **配额表中的「预期用量」列是估算，非实测**（§7.3）—— 依据是已冻结的架构参数推算。实测项（如 `/sw.js` 响应头、SPA fallback 行为）列在 §10.4。
2. **`preview` 部署默认是否复用生产 D1 绑定，官方未证实** —— 本票用「关闭非 `master` 分支自动部署」**绕开**了这个不确定性，而非**解决**了它。若日后要开预览，必须先实测这条行为。
3. **`_routes.json` 自写是否会覆盖 Pages 自动生成的那份，官方未明文** —— 只有第三方适配器层面的线索。**上线后须实测核对**（§10.4）。
4. **上游派生要求的落点是文本引用核验，非机器校验** —— 本文件与 `migrations/*`、`CONTEXT.md`、四份契约之间**没有编译期或脚本级校验**，改动任一侧需人工比对。
5. **构建镜像的 Node 默认版本存在官方页面间冲突**（v3 页写 22.16.0，Known issues 页写 12.18.0）—— 本票用**显式 `NODE_VERSION`** 绕开，但这条冲突本身未被官方澄清。
6. **`D1 单请求子请求上限` 官方数字自相矛盾**（50 vs 1,000）—— 本票按 50 规划，未做实测辨别。
7. **未做真实部署验证**：本文件的所有配置形态（`wrangler.jsonc` 字段、`_routes.json` include 收窄、`_headers` 规则、Fail open 行为）**均未在真实 Cloudflare 项目上部署验证**。
