# 家庭财务系统 · Cloudflare D1 自带备份 / 恢复 / 导出 / 导入 能力 — 一手事实清单

> **采集日期**：2026-09-17（下文所有 URL 均于该日访问）
> **范围**：D1 平台**自带**的备份/恢复/导出/导入官方通道（Time Travel、`wrangler d1 export` / `d1 execute --file`、D1 REST API 的 `export` / `import` / `time_travel` 端点、官方最佳实践页），以及 R2 / KV 免费额度的绑卡要求。**不含**任何「我们自己写的备份代码」的设计判断。
> **一手来源**：`developers.cloudflare.com`（D1 / Workers / Workflows / KV / R2 / Billing 文档 + Cloudflare API 参考）、`cloudflare/workers-sdk` 仓库源码与测试、`cloudflare.com` 官方产品页。**二手来源（博客 / 知乎 / 掘金 / CSDN / Medium / Cloudflare Community）一律不作为结论依据**，仅在「官方未找到」处作为旁证列出并明确标注。
> **标注规则**（沿用 `cloudflare-free-tier-constraints.md` / `cloudflare-pages-deploy-and-quota-facts.md` 的口径，并新增一项）：
> - **[官方明确]** = 官方文档 / API 参考 / 官方仓库源码与测试的原文逐字写明；
> - **[官方间接]** = 由官方原文可逻辑推导，但官方无逐字表述；
> - **[未找到一手来源]** = 官方文档未给出该表述、数字或端点；
> - **[未证实]** = 无官方原文，且无法由原文推导，只能实测的行为性结论。
> **术语衔接**：本文沿用既有报告的「D1 / Time Travel / rows written / rows read / 子请求」口径，不重复 `cloudflare-free-tier-constraints.md` §4、`cloudflare-pages-deploy-and-quota-facts.md` §3.4/§5.6、`cloudflare-runtime-fetch-facts.md` §7 已核实的部分；凡重合处只做「口径复述 + 补引文」。
> **易变事实提醒**：以下所有天数、版本号、额度均为 **2026-09-17 快照**。每页标注其文档 `Last updated` 日期；`—` 表示该页**不显示** Last updated。

---

## 0. 结论速览（先给判断）

| # | 问题 | 结论 | 标注 |
|---|---|---|---|
| 1 | D1 是否有 Time Travel | **有**。官方页标题即 **"Time Travel and backups"**，URL `/d1/reference/time-travel/` | [官方明确] |
| 2 | 免费 / 付费可回溯多久 | **Free 7 天 / Paid 30 天**（网传属实，官方逐字确认）；**恢复速率上限 10 次 / 10 分钟 / 库** | [官方明确] |
| 3 | 恢复粒度 | 官方措辞是 **"any minute"**（分钟级）；API 接受 Unix 秒或 RFC3339（含毫秒），但**秒级/毫秒级精度无官方保证** | [官方明确]（分钟）/[未证实]（秒级） |
| 4 | 恢复方式 | **wrangler CLI** `wrangler d1 time-travel restore` + **REST API** `POST .../time_travel/restore`；**dashboard 通道本轮未找到官方一手来源** | [官方明确]/[未找到一手来源] |
| 5 | 恢复是覆盖还是新库 | **原地覆盖（destructive，overwrites the database in place）**；官方明确「不支持 fork/clone，未来才支持」 | [官方明确] |
| 6 | 恢复可逆吗 | **可撤销**。官方逐字给出 `previous_bookmark` / "To undo this operation, you can restore to the previous bookmark" | [官方明确] |
| 7 | 默认开启？额外费用？ | **不需要开启，always on**；**"Database history and restoring a database incur no additional costs"** | [官方明确] |
| 8 | **Time Travel 能否替代定期自动备份** | **官方确实把它定位为备份机制**（见 §1.7）；**但 Free 窗口只有 7 天**，且官方对「超过 30 天」的场景**明确指向 export 到 R2**。官方**未**写「Time Travel 可完全替代外部长期备份」 | [官方明确]（定位）/ [未找到一手来源]（替代性结论） |
| 9 | `wrangler d1 export` 全部参数 | `--output`(必填) / `--local` / `--remote`(互斥) / `--skip-confirmation`(`-y`) / `--table`(可重复) / `--no-schema` / `--no-data`。**无 `--preview`** | [官方明确] |
| 10 | 导出格式 | **只有 `.sql`（SQL dump）**。**官方没有 CSV / JSON 导出通道** | [官方明确] |
| 11 | 只导 schema / 只导 data / 单表 | **三者都支持**（`--no-data` / `--no-schema` / `--table`，`--table` 可多次） | [官方明确] |
| 12 | 导出大小上限 / 超时 | **官方未给导出大小上限**；导入上限 **5 GiB**（`d1 execute`）。**"A running export will block other database requests"** | [官方明确]（阻塞/导入 5 GiB）/[未找到一手来源]（导出上限） |
| 13 | 导出的 SQL 长什么样 | 官方无 dump 样例；**wrangler 官方测试快照**给足证据：首行 `PRAGMA defer_foreign_keys=TRUE;`，随后 `CREATE TABLE ...;` + 逐行 `INSERT INTO "t" ("c") VALUES(...);`，`\n` 连接，**无 `BEGIN TRANSACTION`/`COMMIT`** | [官方明确]（本地 Miniflare 路径）/[官方间接]（`--remote` 路径） |
| 14 | D1 REST API 有 export / import 吗 | **两者都有**：`POST .../d1/database/{id}/export`、`POST .../d1/database/{id}/import`，**均为异步轮询式** | [官方明确] |
| 15 | 因此「站内按钮生成可回导 SQL」可行吗 | **协议层可行**（API 有完整 export + import + 轮询），**但需在服务端持有 D1 权限的 API Token**，且导出期间库不可用、不轮询会自动取消 | [官方明确]（端点）/ [官方间接]（可行性） |
| 16 | `d1 execute --file` 的限制 | 文件 **5 GiB**；单条语句 **100 KB**（超了报 `Statement too long`，需拆 INSERT）；**语句数上限官方未给** | [官方明确]（5 GiB / 100 KB）/[未找到一手来源]（语句数） |
| 17 | 回导是否吃「10 万行写/天」 | 官方 FAQ：**"any queries you run against your database ... count as either reads or writes"**；建索引会使写入行数 ×2 | [官方明确]（查询计数）/ [官方间接]（import 整体口径） |
| 18 | 外键怎么处理 | 官方唯一指定逃生口：**`PRAGMA defer_foreign_keys = true`**；另官方要求**按正确表顺序导入** | [官方明确] |
| 19 | `PRAGMA foreign_keys = OFF` 在 D1 可用吗 | **官方两页互相冲突**：`/d1/sql-api/foreign-keys/` 说「user queries cannot change this」；`/d1/sql-api/sql-statements/` 却把 `PRAGMA foreign_keys = (on|off)` 列为 **compatible**，示例首行就是 `PRAGMA foreign_keys=off;`。**两边都保留**（§8-1） | [官方明确]（冲突） |
| 20 | `--file` 的事务语义 | 官方文档**未写**；但 wrangler 源码在导入前打印 **"if the execution fails to complete, your DB will return to its original state and you can safely retry."**；`--remote` 走 import API（非本地 batch） | [官方间接] |
| 21 | 官方有无专用「备份与恢复」文档页 | **有 3 页 + 1 篇官方 how-to**：`Time Travel and backups`、`Backups (Legacy)`、`Import and export data`、Workflows 的 `Export and save D1 database` | [官方明确] |
| 22 | 官方对「不做备份的风险」有无表态 | **未找到**任何免责声明。最接近的只有 D1 概览页 "**built-in disaster recovery**" 与「改大 schema 前先手动备份是好习惯」 | [官方明确]（built-in disaster recovery）/ [未找到一手来源]（风险表态） |
| 23 | R2 免费额度是否要绑卡 | **仍成立**：开通 R2 = 走 checkout 订阅；官方 Billing 政策要求「enabling subscriptions 前必须有有效付款方式」并点名 R2 会因付款方式失败而断访问。**但没有任何一句官方文档逐字写「R2 免费层必须绑信用卡」** | [官方间接]（多页共同指向）/ [官方明确]（官方营销页 "input your payment details"） |
| 24 | R2 免费额度数字 | **10 GB-month/月 + Class A 100 万次/月 + Class B 1000 万次/月 + egress 免费**（仅 Standard，不含 Infrequent Access） | [官方明确] |
| 25 | 不绑卡还能放小文件吗 | **KV**：随 Workers Free 计划提供，**无需单独订阅**（故 [官方间接] 不需绑卡）；Free 额度 **读 10 万/天、写 1,000/天、存储 1 GB/账户、单 value 25 MiB**。**D1 自身**也在 Workers Free 内（Free 10 库/账户、单库 500 MB、账户 5 GB） | [官方明确]（数字）/ [官方间接]（KV 不需绑卡） |

---

## 1. Time Travel（时间回溯）——本轮最重要的一问

### 1.1 功能是否存在、官方页面在哪

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/reference/time-travel/> —— 页面标题即为 **"Time Travel and backups"**，Last updated **Apr 21, 2026**。

> "Time Travel is D1's approach to backups and point-in-time-recovery, and allows you to restore a database to **any minute** within the last 30 days."

同页顶部三条 bullet（逐字）：

> "- You **do not need to enable** Time Travel. It is **always on**.
> - Database history and restoring a database **incur no additional costs**.
> - Time Travel **automatically creates bookmarks** on your behalf. You do not need to manually trigger or remember to initiate a backup."

**[官方明确]** D1 概览页把它列为一项 Feature（来源：<https://developers.cloudflare.com/d1/>，Last updated **Apr 30, 2026**）：

> "Time Travel — Time Travel is D1's approach to backups and point-in-time-recovery, and allows you to restore a database to any minute within the last 30 days."

### 1.2 免费 / 付费可回溯多久（逐字 + 确切天数）

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/limits/>，Last updated **Apr 21, 2026**，Limits 表逐字行：

> `Time Travel duration (point-in-time recovery) | **30 days (Workers Paid) / 7 days (Free)**`
> `Maximum Time Travel restore operations | **10 restores per 10 minutes (per database)**`

**[官方明确]** 同口径在 Time Travel 页末「Notes」节再次逐字出现：

> "You can restore a database back to a point in time up to **30 days in the past (Workers Paid plan) or 7 days (Workers Free plan)**. Refer to Limits for details on Time Travel's limits."

**[官方明确]** 同页 Bookmarks 节：

> "**Bookmarks older than 30 days are invalid** and cannot be used as a restore point."

**[官方明确]** 最早的功能公告（来源：<https://developers.cloudflare.com/d1/platform/release-notes/>，条目日期 **2023-07-27**）：

> "**Time Travel** — Time Travel is now available. Time Travel allows you to restore a D1 database back to **any minute within the last 30 days (Workers Paid plan) or 7 days (Workers Free plan)**, at **no additional cost for storage or restore operations**."

> **对网传说法的核实**：「免费 7 天 / 付费 30 天」**属实**，官方文档与 2023-07-27 发布说明两处均逐字确认。
> **⚠️ 文档措辞陷阱**：Time Travel 页**正文首句**只写 "within the last 30 days"（付费值），**7 天这个免费值只出现在页面末尾 Notes 与 Limits 表**。只读首句会误判免费额度为 30 天。

### 1.3 恢复的粒度

**[官方明确]** 官方保证的粒度是**分钟**（"any minute"）。Time Travel 页 Timestamps 节逐字列出支持的两种时间戳格式：

> "- Unix timestamps, which correspond to seconds since January 1st, 1970 at midnight. This is always in UTC.
> - The JavaScript date-time string format, which is a simplified version of the ISO-8601 timestamp format. An valid date-time string for the July 27, 2023 at 11:18AM in Americas/New_York (EST) would look like `2023-07-27T11:18:53.000-04:00`."

**[官方明确]** Bookmarks 节（时间戳 → bookmark 的映射性质）：

> "Bookmarks can be derived from a Unix timestamp (seconds since Jan 1st, 1970), and conversion between a specific timestamp and a bookmark is **deterministic (stable)**."

**→ 结论**：**接口层面接受秒/毫秒精度的输入**（RFC3339 带时区、含 `.000` 毫秒），但官方**只承诺 "any minute"** 的回溯粒度。**秒级是否真的精确到秒，官方未逐字保证 → [未证实]**（见 §7）。

### 1.4 恢复方式（CLI / API / dashboard）

**[官方明确] wrangler CLI**（来源：<https://developers.cloudflare.com/workers/wrangler/commands/d1/>，**页面不显示 Last updated**）：

```
## `d1 time-travel info`      — Retrieve information about a database at a specific point-in-time using Time Travel
## `d1 time-travel restore`   — Restore a database back to a specific point-in-time
```
> `[DATABASE]` required — "The name or binding of the DB"
> `--bookmark` — "Bookmark to use for time travel"
> `--timestamp` — "Accepts a Unix (seconds from epoch) or RFC3339 timestamp (e.g. 2023-07-13T08:46:42.228Z) to retrieve a bookmark for (within the last 30 days)"
> `--json` — default: `false`
> 两条子命令均注明：**"This command acts on remote D1 Databases."**（不吃 `--local`）

命令原文（Time Travel 页逐字）：

```
wrangler d1 time-travel info YOUR_DATABASE
wrangler d1 time-travel info YOUR_DATABASE --timestamp="2023-07-09T17:31:11+00:00"
wrangler d1 time-travel restore YOUR_DATABASE --timestamp=UNIX_TIMESTAMP
```

**[官方明确] REST API**（来源：<https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/restore/> 与 <https://developers.cloudflare.com/api/resources/d1/>）：

> `GET /accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark` — "Get D1 database bookmark"
> `POST /accounts/{account_id}/d1/database/{database_id}/time_travel/restore` — "Restore D1 Database to a bookmark or point in time"
> `bookmark`: "A bookmark to restore the database to. **Required if timestamp is not provided.**"
> `timestamp`: "An ISO 8601 timestamp to restore the database to. **Required if bookmark is not provided.**"（`format: date-time`）
> 返回 `TimeTravelRestoreResponse { bookmark, message, previous_bookmark }`，其中 `previous_bookmark` = "The bookmark representing the state of the database before the restore operation. **Can be used to undo the restore if needed.**"

**[未找到一手来源] dashboard 通道**：本轮逐页核对 `/d1/reference/time-travel/`、`/d1/platform/limits/`、`/d1/reference/faq/`、`/d1/reference/backups/`、`/d1/platform/release-notes/`，**均未出现**「在 Cloudflare dashboard 上执行 Time Travel 恢复」的步骤说明。官方目前的文字只覆盖 **wrangler CLI** 与 **REST API** 两条通道。
> 注：这**不等于** dashboard 没有该 UI，只是「官方文档未写明」→ 归入 §7 实测项。

### 1.5 恢复的行为：覆盖 / 新库 / 能否撤销

**[官方明确] 原地覆盖，不是新库**（Time Travel 页 Restore 节，Caution 框逐字）：

> "**Caution** — Restoring a database to a specific point-in-time is a *destructive* operation, and **overwrites the database in place**. In the future, D1 will support branching & cloning databases using Time Travel."

CLI 实际输出（同页逐字）：

```
⚠️ This will overwrite all data in database YOUR_DATABASE.
In-flight queries and transactions will be cancelled.
```

**[官方明确] 「不支持 fork/clone」**（同页 Notes）：

> "Time Travel does not yet allow you to **clone or fork an existing database to a new copy**. In the future, Time Travel will allow you to fork (clone) an existing database into a new database, or overwrite an existing database."

**→ 即：恢复到某时间点 = 覆盖当前库，不生成新库。**

**[官方明确] 恢复本身可以撤销**（Time Travel 页 Undo a restore 节，逐字）：

> "You can undo a restore by:
> - Taking note of the **previous bookmark** returned as part of a `wrangler d1 time-travel restore` operation
> - Restoring directly to a bookmark in the past, prior to your last restore."

CLI 输出还原：

```
✅ Database YOUR_DATABASE restored back to bookmark 00000080-...
↩️ To undo this operation, you can restore to the previous bookmark: 00000085-...
```

同页 Notes 第三条：

> "The restore operation will return a bookmark that allows you to **undo and revert** the database."

Bookmarks 节：

> "Restoring a database to a specific bookmark **does not remove or delete older bookmarks**. For example, if you restore to a bookmark representing the state of your database 10 minutes ago, and determine that you needed to restore to an earlier point in time, **you can still do so**."

**→ 结论：官方明确说恢复是「破坏性 / 原地覆盖」，但也明确说「可以撤销」。**
**⚠️ 关于「官方是否警告恢复不可逆」**：本轮**未找到**任何「恢复不可逆」的官方措辞；官方文本的方向相反（给 `previous_bookmark`、给 undo 章节）。
**⚠️ 但撤销有窗口边界**：撤销手段本身仍受 **Free 7 天 / Paid 30 天** 的 bookmark 有效期约束（"Bookmarks older than 30 days are invalid"）。**在窗口内可撤销；窗口外无法回溯**——这是由两条原文合成的 [官方间接] 结论。

**[官方明确] 恢复还会打断在途查询**：

> "Queries in flight will be cancelled, and an error returned to the client."

**⚠️ 关于「官方是否警告恢复是不可逆的」的准确回答**：官方**没有**用 "irreversible" 这个词；官方用的是 "destructive"（破坏性）+ "overwrites in place"（原地覆盖），并同时提供 undo 通道。**「不可逆」是社区常见转述，非官方措辞。**

### 1.6 默认开启 / 额外费用 / 前置条件

**[官方明确]**（Time Travel 页，逐字，已在 §1.1 引全）：
- "You do not need to enable Time Travel. It is **always on**."
- "Database history and restoring a database **incur no additional costs**."
- "Time Travel automatically creates bookmarks on your behalf."

**[官方明确] 前置条件**（同页 Requirements 节）：

> "- `Wrangler` **v3.4.0 or later** installed to use Time Travel commands.
> - A database on D1's **production backend**. You can check whether a database is using this backend via `wrangler d1 info DB_NAME` - the output show `version: production`."

同页 Support 框：

> "Databases using D1's new storage subsystem can use Time Travel. **Time Travel replaces the snapshot-based backups used for legacy alpha databases.**"
> "Databases with `version: production` support the new Time Travel API. Databases with `version: alpha` only support the older, snapshot-based backup API."

**→ 对本项目**：仓库 `migrations/` 用 `wrangler d1 migrations apply` 建库（2026 年新建），必然走 production backend；**Time Travel 无需任何配置、无额外费用、默认全程开启**。

### 1.7 ⚠️ 关键推论：Time Travel 能否替代「定期自动备份」？

**官方是否把它定位为「备份」？→ 是，而且不止一处。**

| 证据 | 逐字 | 来源 |
|---|---|---|
| 页面标题 | **"Time Travel and backups"** | <https://developers.cloudflare.com/d1/reference/time-travel/>（Apr 21, 2026） |
| 首句定位 | "Time Travel is D1's **approach to backups and point-in-time-recovery**" | 同上 |
| 明确否定手工/定时快照的必要性 | "**By not having to rely on scheduled backups and/or manually initiated backups**, you can go back in time and restore a database prior to a failed migration or schema change, a `DELETE` or `UPDATE` statement without a specific `WHERE` clause, and in the future, fork/copy a production database directly." | 同上 |
| 无需自己触发备份 | "Time Travel automatically creates bookmarks on your behalf. **You do not need to manually trigger or remember to initiate a backup.**" | 同上 |
| 替代了旧的快照备份 | "**Time Travel replaces the snapshot-based backups** used for legacy alpha databases." | 同上 |
| 产品层表述 | D1 概览页："D1 is Cloudflare's managed, serverless database with SQLite's SQL semantics, **built-in disaster recovery**, and Worker and HTTP API access." | <https://developers.cloudflare.com/d1/>（Apr 30, 2026） |

**但官方同时划出了它的边界，且边界对「Free 计划」是硬的：**

1. **[官方明确]** 窗口限制：Free **7 天**（§1.2）。「Bookmarks older than 30 days are invalid」——**超过窗口的历史状态不存在，无法恢复**。
2. **[官方明确]** 官方在「需要保存更久」时**指向 export 到 R2**，而不是说 Time Travel 就够了：
   > "**Export D1 into R2 using Workflows** — You can automatically export your D1 database into R2 storage via REST API and Cloudflare Workflows. **This may be useful if you wish to store a state of your D1 database for longer than 30 days.**"（Time Travel 页末节，Apr 21, 2026，指向 <https://developers.cloudflare.com/workflows/examples/backup-d1/>）
3. **[官方明确]** 官方**没有**提供「fork/clone 到新库再取走」的通道（§1.5），即 Time Travel **不能**用来生成一份可离线保存的副本。

**→ 因此，只能给出如下**严格依据官方文本**的判断：**
- **官方把 Time Travel 定位为 D1 的备份与 PITR 机制**（标题 + 首句 + "built-in disaster recovery"），并且**明确表示其存在就是为了「不必依赖定时/手动备份」** → **[官方明确]**
- **官方从未表述「Time Travel 可以完全替代外部长期备份」** → 此结论 **[未找到一手来源]**，本清单**不代替官方下这个结论**。
- **可由官方原文直接推出的边界**（[官方间接]，但依据是逐字原文）：Free 计划下 **7 天窗口之外的数据状态不可恢复**，且**没有向外的导出通道**；官方自己对「>30 天留存」的答案是 **export 到 R2**。
  → 对本项目（Free、2 人家庭、`quote_daily` 为唯一副本、重建成本不可逆）而言，**Time Travel 覆盖的是「最近 7 天内的误操作 / 失败迁移」，不是「历史副本的长期留存」**。

---

## 2. `wrangler d1 export`（命令行导出）

### 2.1 官方文档页与完整参数

**[官方明确]** 来源（两处，本文以命令页为准）：
- 命令参考：<https://developers.cloudflare.com/workers/wrangler/commands/d1/> — **该页不显示 Last updated**
- 用法指南：<https://developers.cloudflare.com/d1/best-practices/import-export-data/> — Last updated **Apr 21, 2026**

命令页逐字：

```
## `d1 export`
Export the contents or schema of your database as a .sql file

npx wrangler d1 export [NAME]
```

| 参数 | 类型 | 逐字说明 |
|---|---|---|
| `[NAME]` | `string` **required** | "The name of the D1 database to export" |
| `--local` | `boolean` | "Export from your local DB you use with `wrangler dev`" |
| `--remote` | `boolean` | "Export from a remote D1 database" |
| `--skip-confirmation`（别名 `--y`） | `boolean`, default `false` | "Skip confirmation" |
| `--output` | `string` **required** | "Path to the SQL file for your export" |
| `--table` | `string` | "Specify which tables to include in export" |
| `--no-schema` | `boolean` | "Only output table contents, not the DB schema" |
| `--no-data` | `boolean` | "Only output table schema, not the contents of the DBs themselves" |

**⚠️ 三个容易踩的点，由 wrangler 官方源码佐证**（来源：<https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/export.ts>，`main` 分支，采集于 2026-09-17）：

1. **`--local` 与 `--remote` 互斥**：源码 `conflicts: "remote"` / `conflicts: "local"`；测试快照报错为 `Arguments local and remote are mutually exclusive`。
2. **`--no-schema` 与 `--no-data` 互斥**：源码 `conflicts` 互指，并有显式校验：
   > `Cannot use --no-schema and --no-data together. At least one of schema or data must be included in the export. Remove one of the flags.`
3. **`--table` 可重复传入**（源码注释逐字）：`// Allow multiple --table x --table y flags or none`；`table: { type: "string", ..., array: true }`。
4. **`export` 没有 `--preview`**：源码 `args` 中只有 `local` / `remote`（对比 `d1 execute` 有 `--preview`）。**官方 export 无法直接导出 preview 数据库**（可用 `--local` 导出本地库）。
5. 另有**隐藏参数** `--schema` / `--data`（`hidden: true, default: true`）——为让 `--no-*` 生效而存在，正常不必手写。

### 2.2 官方用法示例（6 条，逐字）

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/best-practices/import-export-data/>（Apr 21, 2026），"Export an existing D1 database" 节：

```
# 全库 schema + data
npx wrangler d1 export <database_name> --remote --output=./database.sql
# 单表 schema + data
npx wrangler d1 export <database_name> --remote --table=<table_name> --output=./table.sql
# 只导全库 schema
npx wrangler d1 export <database_name> --remote --output=./schema.sql --no-data
# 只导单表 schema
npx wrangler d1 export <database_name> --remote --table=<table_name> --output=./schema.sql --no-data
# 只导全库 data
npx wrangler d1 export <database_name> --remote --output=./data.sql --no-schema
# 只导单表 data
npx wrangler d1 export <database_name> --remote --table=<table_name> --output=./data.sql --no-schema
```

**参考本节回答四连问（逐条）**

| 子问题 | 结论 | 依据 |
|---|---|---|
| 导出什么格式？SQL dump / CSV / JSON？ | **只有 `.sql`（SQL dump）**。官方描述："Export the contents or schema of your database as a **`.sql` file**"；用法页标题即 "You can export a D1 database to a `.sql` file" | [官方明确] |
| 能否只导 schema / 只导 data？ | **能**（`--no-data` / `--no-schema`） | [官方明确] |
| 能否导出单张表？ | **能**（`--table`，且可 `--table a --table b` 多表） | [官方明确] |
| 能否导出为 CSV / JSON？ | **官方没有 CSV / JSON 导出通道**。本轮逐页核对 D1 文档（Time Travel 页、Limits 页、Import/Export 页、FAQ 页、wrangler `d1` 命令页）与 D1 REST API 参考（`export` 端点只有 `dump_options { no_data, no_schema, tables }`），**无任何 CSV / JSON 选项** | [未找到一手来源]（即：官方不支持；如需 CSV/JSON，只能自己序列化数据） |

### 2.3 限制：大小 / 超时 / 是否受「50 次查询」约束

**[官方明确] 阻塞行为**（三处逐字）：

- Import/Export 页 Known limitations：
  > "**A running export will block other database requests.**"
- wrangler `d1 export --remote` 的确认提示（源码逐字 + 测试快照逐字）：
  > "⚠️ This process may take some time, during which your D1 database will be **unavailable to serve queries**."
- Export REST API 说明（API 参考逐字）：
  > "Returns a URL where the SQL contents of your D1 can be downloaded. Note: this process may take some time for larger DBs, **during which your D1 will be unavailable to serve queries**. **To avoid blocking your DB unnecessarily, an in-progress export must be continually polled or will automatically cancel.**"

**[官方明确] 无导出大小上限**：D1 Limits 页（Apr 21, 2026）的限额表**只有** `Maximum file import (d1 execute) size | 5 GB`，**没有**任何 export 大小/时长条目 → **导出大小上限 [未找到一手来源]**。
**[官方明确] 无导出超时上限**：同样**未找到**；但有一个**行为性等价物**——`--remote` 导出必须被持续轮询，**不轮询会自动取消**（见上引 API 原文）。

**[官方间接] 「每调用 50 次查询」是否约束导出？——不受。**
- `wrangler d1 export --remote` 走 **D1 REST API**（源码：`fetchResult(... /accounts/{accountId}/d1/database/${db.uuid}/export, { method: "POST" ... })`），**不是 Worker invocation**，因此不受 `Queries per Worker invocation` 限额约束。
- 引用既有报告口径：D1 查询计入「对 Cloudflare 内部服务的子请求」（Workers Free **1,000 / invocation**，<https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/>，**2026-02-11**），而 D1 Limits 页仍写 `1000 (Workers Paid) / 50 (Free)`——**该冲突已在 `cloudflare-pages-deploy-and-quota-facts.md` §3.4/§8-1 记录，本文不重复**。两者都只约束**Worker invocation 内**的查询，与 CLI/API 导出无关。

**[官方间接] 导出是否消耗 rows read 日配额？**
官方 FAQ（<https://developers.cloudflare.com/d1/reference/faq/>，Apr 21, 2026，与 Pricing 页 Apr 21, 2026 同句）：

> "**Do queries I run from the dashboard or Wrangler (the CLI) count as billable usage?** — Yes, **any queries you run against your database**, including inserting (`INSERT`) existing data into a new database, **table scans (`SELECT * FROM table`)**, or creating indexes count as either **reads or writes**."

→ 导出本质是全表扫描，**按此口径应计 rows read**（Free **500 万行/天**）。但「REST API export 作业」是否逐行计入，**官方未逐字说明** → **[官方间接] + 列入 §7 实测**。

### 2.4 导出 SQL dump 的具体形态

**⚠️ 官方文档完全没有给 dump 样例。** 但 **wrangler 官方仓库的测试快照**给出了可逐字核对的形态（一手来源：<https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/d1/export.test.ts>，`main` 分支，采集于 2026-09-17）。

测试建了两张表并断言导出内容**逐字节等于**：

```js
const create_foo = "CREATE TABLE foo(id INTEGER PRIMARY KEY, value TEXT);";
const insert_foo = [
  `INSERT INTO "foo" ("id","value") VALUES(1,'xxx');`,
  `INSERT INTO "foo" ("id","value") VALUES(2,'yyy');`,
  `INSERT INTO "foo" ("id","value") VALUES(3,'zzz');`,
];
// 全量导出
expect(fs.readFileSync("test-full.sql", "utf8")).toBe(
  ["PRAGMA defer_foreign_keys=TRUE;", create_foo, ...insert_foo, create_bar, ...insert_bar].join("\n")
);
// 只导 schema（--no-data）
["PRAGMA defer_foreign_keys=TRUE;", create_foo, create_bar].join("\n")
// 只导 data（--no-schema）
["PRAGMA defer_foreign_keys=TRUE;", ...insert_foo, ...insert_bar].join("\n")
// 单表（--table foo）
["PRAGMA defer_foreign_keys=TRUE;", create_foo, ...insert_foo].join("\n")
// 多表（--table foo --table baz）
["PRAGMA defer_foreign_keys=TRUE;", <foo 的建表与数据>, <baz 的建表与数据>].join("\n")
```

即，一份**全量** dump 的真实形态等价于：

```sql
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE foo(id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO "foo" ("id","value") VALUES(1,'xxx');
INSERT INTO "foo" ("id","value") VALUES(2,'yyy');
INSERT INTO "foo" ("id","value") VALUES(3,'zzz');
CREATE TABLE bar(id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO "bar" ("id","value") VALUES(1,'aaa');
...
```

| 形态问题 | 结论 | 依据 |
|---|---|---|
| 含 `CREATE TABLE`？ | **含**（`--no-schema` 可去掉） | [官方明确]（源码测试断言） |
| 含 `PRAGMA`？ | **含，且是第一行**：`PRAGMA defer_foreign_keys=TRUE;` | [官方明确]（源码测试断言） |
| 含事务包裹（`BEGIN TRANSACTION` / `COMMIT`）？ | **不含**。测试断言中无任何 `BEGIN`/`COMMIT`；且官方在导入侧明确要求**删掉** dump 里的 `BEGIN TRANSACTION`/`COMMIT`（§4.4） | [官方明确]（测试断言）/ [官方间接]（无事务包裹是设计意图） |
| 日期 / 时间怎么写？ | **无特殊处理**：按 SQLite 存储类型原样序列化。测试中的 `TEXT` 值 → **单引号字符串**（`'xxx'`）；`INTEGER` → 裸数字（`1`）。**本项目日期若按 TEXT/INTEGER 存，则分别输出为 `'2026-09-17'` 或裸数字** | [官方明确]（TEXT/INTEGER 形态）/ [官方间接]（对日期类型的推广） |
| 分隔符 | 语句之间用 `\n`（无空行） | [官方明确]（`.join("\n")`） |
| 是否含索引 / 触发器 / 视图？ | **本项目 12 个显式索引是否出现在 dump 中，测试未覆盖，官方文档亦未说明** → [未找到一手来源]（§7 实测） | — |
| 表顺序 | 测试中按建表顺序（foo → bar）；**官方未说明是否按外键依赖排序** | [未找到一手来源] |

**⚠️ 本小节的适用边界（必须写清楚）**：
- 上面这份**可逐字核对的 dump 样例来自 `--local`（Miniflare）路径**。本地导出走的是 **Miniflare 私有 PRAGMA**（源码逐字）：
  > `// Special local-only export pragma. Query must be exactly this string to work.`
  > `db.prepare('PRAGMA miniflare_d1_export(?,?,?);').bind(noSchema, noData, ...tables).raw()`
- **`--remote` 路径完全不同**：wrangler **不在客户端拼 SQL**，而是调 D1 REST API 的 `export` 端点、轮询，最后从 `signed_url` 下载服务端生成的 SQL 文件（源码逐字见 §2.3 与 §3.1）。
- **因此：`--remote` 导出的 SQL 文本是 D1 服务端生成的，其确切形态官方文档未写、wrangler 源码里也看不到。** 上表按 **[官方间接]** 处理（Miniflare 的 dump 与 D1 服务端 dump 通常同风格，首行 `PRAGMA defer_foreign_keys=TRUE;` 也与官方导入指导一致），**但必须实测核对**（§7）。

### 2.5 `--remote` 是否必须联网 / 用账户凭据

**[官方明确]** 是。
- 源码逐字：`const accountId = await requireAuth(config);` —— `--remote` 路径**强制鉴权**，随后按 `db.uuid` 调 `POST /accounts/{accountId}/d1/database/{db.uuid}/export`。
- 凭据口径沿用既有报告：`CLOUDFLARE_API_TOKEN`（或 `wrangler login` 的 OAuth）→ 见 `cloudflare-pages-deploy-and-quota-facts.md` §1.5。官方 Workflows 备份示例另注明该 Token 需要「permission to export the target D1 database」（<https://developers.cloudflare.com/workflows/examples/backup-d1/>，Last updated **Jun 2, 2026**）。
- **[官方明确]** `--local` 路径**不联网**：走本地 Miniflare + `.wrangler/state`（沿用 `cloudflare-pages-deploy-and-quota-facts.md` §5.3 已核实口径）。
- **[官方明确]** `--remote` 成功后，wrangler 会打印一条可手工下载的链接（源码逐字）：
  > "You can also download your export from the following URL manually. **This link will be valid for one hour**: ${finalResponse.result.signed_url}"
  同义官方 API 字段：`signed_url` — "The URL to download the exported SQL. **Available for one hour.**"

---

## 3. D1 REST API 是否支持导出 / 导入（**决定「站内按钮」可行性的一问**）

### 3.1 结论：**export 与 import 两个端点都存在，且都是异步轮询式**

**[官方明确]** 端点清单位于 D1 API 资源页（来源：<https://developers.cloudflare.com/api/resources/d1/>，采集于 2026-09-17）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/accounts/{account_id}/d1/database/{database_id}/query` | Query D1 Database |
| `POST` | `/accounts/{account_id}/d1/database/{database_id}/raw` | Raw D1 Database query |
| **`POST`** | **`/accounts/{account_id}/d1/database/{database_id}/export`** | **Export D1 Database as SQL** |
| **`POST`** | **`/accounts/{account_id}/d1/database/{database_id}/import`** | **Import SQL into your D1 Database** |
| `GET` | `/accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark` | Get D1 database bookmark |
| `POST` | `/accounts/{account_id}/d1/database/{database_id}/time_travel/restore` | Restore D1 Database to a bookmark or point in time |

### 3.2 export 端点（来源：<https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/>，采集于 2026-09-17；**该页不显示 Last updated**）

**顶部说明逐字：**

> "Returns a URL where the SQL contents of your D1 can be downloaded. Note: this process may take some time for larger DBs, during which your D1 will be unavailable to serve queries. **To avoid blocking your DB unnecessarily, an in-progress export must be continually polled or will automatically cancel.**"

**请求体（逐字）：**

| 字段 | 类型 | 逐字说明 |
|---|---|---|
| `output_format` | `"polling"` | "Specifies that you will poll this endpoint until the export completes" |
| `current_bookmark` | optional `string` | "To poll an in-progress export, provide the current bookmark (returned by your first polling response)" |
| `dump_options.no_data` | optional `boolean` | "Export only the table definitions, not their contents" |
| `dump_options.no_schema` | optional `boolean` | "Export only each table's contents, not its definition" |
| `dump_options.tables` | optional `array of string` | "Filter the export to just one or more tables. **Passing an empty array is the same as not passing anything and means: export all tables.**" |

**响应（逐字关键字段）：**
- `result.at_bookmark` — "The current time-travel bookmark for your D1, used to poll for updates. **Will not change for the duration of the export task.**"
- `result.status` — `"complete"` | `"error"`
- `result.result.filename` — "The generated SQL filename."
- `result.result.signed_url` — "The URL to download the exported SQL. **Available for one hour.**"
- `result.messages` — "Logs since the last time you polled"
- `result.type` = `"export"`

**curl 示例（官方逐字）：**

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID/export \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{
          "output_format": "polling"
        }'
```

**→ 是否为异步？是。** 「先发起（拿 `at_bookmark`）→ 用 `current_bookmark` 反复轮询 → `status: complete` 后拿 `signed_url` → 下载」——这是官方 Workflows 备份示例的**实际实现路径**（§5.4），也是 wrangler `--remote` 的实现路径（§2.3）。

### 3.3 import 端点（来源：<https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/>，采集于 2026-09-17；**该页不显示 Last updated**）

**顶部说明逐字：**

> "Generates a temporary URL for uploading an SQL file to, then instructing the D1 to import it and polling it for status updates. **Imports block the D1 for their duration.**"

**三段式请求体（逐字）：**

| 形态 | 字段 | 逐字说明 |
|---|---|---|
| Init | `action: "init"`、`etag: string` | "Indicates you have a new SQL file to upload." / etag = "An **md5 hash** of the file you're uploading. Used to check if it already exists, and validate its contents before ingesting." |
| Ingest | `action: "ingest"`、`etag`、`filename` | "Indicates you've finished uploading to tell the D1 to start consuming it" |
| Poll | `action: "poll"`、`current_bookmark` | "This identifies the currently-running import, checking its status." |

**响应（逐字关键字段）：**
- `upload_url` — "The **R2 presigned URL** to use for uploading. **Only returned when for the 'init' action.**"
- `filename` — "Derived from the database ID and etag, to use in avoiding repeated uploads. Only returned when for the 'init' action."
- `at_bookmark` — "Only returned if an import process is currently running or recently finished."
- `result.result.final_bookmark` — "**The time-travel bookmark if you need restore your D1 to directly after the import succeeded.**"
- `result.result.num_queries` — "The total number of queries that were executed during the import."
- `result.result.meta` — 含 `changes`（"Rough indication of how many rows were modified by the query, as provided by SQLite's `sqlite3_total_changes()`"）、`rows_read`、`rows_written`、`size_after`、`sql_duration_ms` 等
- `result.status` — `"complete"` | `"error"`；`result.error` = "Only present when status = 'error'"
- `result.type` = `"import"`

**curl 示例（官方逐字）：**

```bash
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID/import \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -d '{
          "action": "init",
          "etag": "etag"
        }'
```

### 3.4 ⚠️ 对「前端按钮点一下就能生成可回导的 SQL 备份」这句的关键回答

**协议层：可行。** 因为 **export 与 import 都有官方 HTTP 端点**，且 export 返回的是一个 **1 小时有效的 `signed_url`**（可直接 `fetch` 下载 SQL 文本），import 只需 `md5` + `PUT` + `init/ingest/poll` 三步。**不需要自己拼 SQL 序列化。**（[官方明确] 端点存在；[官方间接] 「站内可调用」）

**但有四条官方原文写明的硬约束，直接决定可行性边界：**

1. **[官方明确] 需要账户级 API Token**。两个端点都是 `POST /accounts/{account_id}/d1/database/{database_id}/...`，鉴权为 `Authorization: Bearer <API_TOKEN>` 或 API Email + API Key。→ 站内按钮若要复用官方通道，**服务端必须持有一枚有 D1 导出/导入权限的 Token**（存为 Pages/Worker secret）。官方 Workflows 示例的注释逐字：
   > "Create `D1_REST_API_TOKEN` as a **secret** with permission to export the target D1 database."（<https://developers.cloudflare.com/workflows/examples/backup-d1/>，Jun 2, 2026）
2. **[官方明确] 导出期间库不可用**：API 页逐字 "during which your D1 will be unavailable to serve queries"。→ 对 2 人家庭自用应用，意味着**点下按钮的那几秒到几十秒内，记账请求会被阻塞/排队**。
3. **[官方明确] 导出作业必须被持续轮询，否则自动取消**："an in-progress export must be continually polled or will automatically cancel"。
4. **[官方明确] 导入同样阻塞**："Imports block the D1 for their duration."（且 `wrangler d1 execute --file --remote` 会打印 "This process may take some time, during which your D1 database will be unavailable to serve queries."）

**→ 与用户假设的对照**：问题里假设「若 export 只有 wrangler CLI 通道，那么站内按钮只能自己序列化数据」。**事实是：官方 REST API 就有 export 端点**，所以「自己序列化」不是唯一路径；但它换来的是「需要服务端持有高权限 API Token + 期间阻塞数据库 + 必须轮询」。**两者都是真实可选路径，本清单只给事实，不做选择。**

---

## 4. 回导 / 恢复数据（把导出的东西装回去）

### 4.1 `wrangler d1 execute --file=<x.sql>` 官方用法

**[官方明确]** 命令参考（<https://developers.cloudflare.com/workers/wrangler/commands/d1/>，**无 Last updated**）：

```
## `d1 execute`
Execute a command or SQL file
You must provide either --command or --file for this command to run successfully.
```

| 参数 | 逐字说明 |
|---|---|
| `[DATABASE]` | "The name or binding of the DB" |
| `--command` | "The SQL query you wish to execute, or multiple queries separated by ';'" |
| `--file` | "A .sql file to ingest" |
| `--yes`（`-y`） | "Answer \"yes\" to any prompts" |
| `--local` | "Execute commands/files against a **local** DB for use with `wrangler dev`" |
| `--remote` | "Execute commands/files against a **remote** D1 database for use with remote bindings or your deployed Worker" |
| `--persist-to` | "Specify directory to use for local persistence (for use with --local)" |
| `--json` | default `false`，"Return output as JSON" |
| `--preview` | default `false`，"Execute commands/files against a preview D1 database" |

**[官方明确]** 用法示例（Import/Export 页，Apr 21, 2026）：

```
npx wrangler d1 execute example-db --remote --file=users_export.sql
npx wrangler d1 execute example-db --remote --command "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;"
```
> 输出提示逐字："🌀 To execute on your local development database, remove the --remote flag from your wrangler command."
> 另注："The `_cf_KV` table is a reserved table used by D1's underlying storage system. It cannot be queried and does not incur read/write operations charges against your account."

**[官方明确] `--file` 只接受 SQL 文本，不接受 `.sqlite3` 二进制**（wrangler 源码逐字）：
> `Provided file is a binary SQLite database file instead of an SQL text file. The execute command can only process SQL text files. Please export an SQL file from your SQLite database and try again.`

### 4.2 限制：单文件大小 / 语句数 / 是否吃 10 万写行 日配额

**[官方明确] 单文件大小上限 = 5 GiB**（两处同口径）：
- Import/Export 页 Known limitations：
  > "For imports, **`wrangler d1 execute --file` is limited to 5GiB files**, the same as the R2 upload limit. For imports larger than 5GiB, we recommend **splitting the data into multiple files**."
- D1 Limits 页（Apr 21, 2026）：`Maximum file import (d1 execute) size | **5 GB**`

**[未找到一手来源] 语句数上限**：官方文档**未给**单文件/单次导入的语句条数上限。D1 Limits 页只给**单条语句**维度的限制（`Maximum SQL statement length 100,000 bytes (100 KB)`、`Maximum bound parameters per query 100`）。

**[官方明确] 单条语句超长会失败，官方给了修法**（Import/Export 页 "Resolve `Statement too long` error" 节，逐字）：
> "it means that one of the SQL statements in your file exceeds the maximum allowed length. To resolve this issue, **convert the single large `INSERT` statement into multiple smaller `INSERT` statements.** For example, instead of inserting 1,000 rows in one statement, split it into four groups of 250 rows"

**[官方明确] 是否吃「每天 10 万写行」？——官方 FAQ 的原话是「任何查询都算」**（<https://developers.cloudflare.com/d1/reference/faq/> 与 <https://developers.cloudflare.com/d1/platform/pricing/>，均 Apr 21, 2026）：

> "Do queries I run from the dashboard or Wrangler (the CLI) count as billable usage? — **Yes, any queries you run against your database, including inserting (`INSERT`) existing data into a new database**, table scans (`SELECT * FROM table`), or creating indexes **count as either reads or writes**."

配套定义（Pricing 页 Definitions #02 / #06，逐字）：
> "**Rows written** measure how many rows were written to D1 database. Write operations include `INSERT`, `UPDATE`, and `DELETE`. ... A query that `INSERT` 10 rows into a `users` table would count as **10 rows written**."
> "**Indexes will add an additional written row** when writes include the indexed column, as there are two rows written: one to the table itself, and one to the index."

**[官方明确] Free 日配额与重置**：`Rows read 5 million / day`、`Rows written 100,000 / day`、`Free limits reset daily at 00:00 UTC`（Pricing 页，Apr 21, 2026）。
**[官方明确] 超限后果**：
> "When your account hits the daily read and/or write limits, **you will not be able to run queries against D1**. D1 API will return errors to your client indicating that your daily limits have been exceeded."

**→ 结论**：导入 = 执行 `INSERT` 语句 → **按官方口径计入 rows read / rows written**（[官方明确]「任何查询都算」）。但 **「一次 REST API import 作业整体如何折算成 rows_written」官方未给逐字口径**（`meta.rows_written` 会在 `complete` 响应里返回，可实测）→ **[官方间接] + §7 实测**。
**→ 对本项目**：15 张表、2 人家庭数据量极小（既有报告估算 55–110 年撑不满 500 MB），**一次全量回导的写行数远低于 10 万/天**；唯一需要留意的是**索引列写入使行数翻倍**（Definitions #06）——本仓库有 12 个显式索引，回导时行数按「表行 + 索引行」计。

### 4.3 外键问题（**本项目 15 张表带外键，是本问的核心**）

**[官方明确] 官方在导入侧只推荐一个逃生口**（Import/Export 页 "Foreign key constraints" 节，逐字）：

> "When importing data, you may need to temporarily disable foreign key constraints. To do so, call **`PRAGMA defer_foreign_keys = true`** before making changes that would violate foreign keys."

同句亦见 Migrations 页（<https://developers.cloudflare.com/d1/reference/migrations/>，Last updated **Jun 8, 2026**）"Foreign key constraints" 节，逐字一致。

**[官方明确] 官方同时要求「按正确表顺序导入」**（Import/Export 页 Troubleshooting 节，逐字）：

> "If you have foreign key relationships between tables, **ensure you are importing the tables in the right order**. You cannot refer to a table that does not yet exist."

**[官方明确] 且官方要求 dump 里不要带事务包裹**（同页 Troubleshooting 节，逐字）：

> "If you receive a `\"cannot start a transaction within a transaction\"` error, make sure you have removed **`BEGIN TRANSACTION` and `COMMIT`** from your dumped SQL statements."

同页 "Convert SQLite database files" 节给出的两条编辑指令（逐字）：
> "1. Remove `BEGIN TRANSACTION` and `COMMIT;` from the file
> 2. Remove the following table creation statement (if present): `CREATE TABLE _cf_KV ( key TEXT PRIMARY KEY, value BLOB ) WITHOUT ROWID;`"

**→ 注意这条与本仓库导出物的关系**：`wrangler d1 export` 的产物**本身不含 `BEGIN TRANSACTION`/`COMMIT`**（§2.4 已证），且**首行就是 `PRAGMA defer_foreign_keys=TRUE;`**，与官方导入指导**方向一致**。

**[官方明确] D1 的外键强制模型**（<https://developers.cloudflare.com/d1/sql-api/foreign-keys/>，Last updated **Apr 21, 2026**，逐字）：

> "**By default, D1 enforces that foreign key constraints are valid within all queries and migrations.** This is identical to the behaviour you would observe when setting **`PRAGMA foreign_keys = on`** in SQLite for every transaction."

> "D1's foreign key enforcement is equivalent to SQLite's `PRAGMA foreign_keys = on` directive. **Because D1 runs every query inside an implicit transaction, user queries cannot change this during a query or migration.** Instead, D1 allows you to call **`PRAGMA defer_foreign_keys = on`** or `off`, which allows you to violate foreign key constraints temporarily (**until the end of the current transaction**)."

> "Calling `PRAGMA defer_foreign_keys = off` does not disable foreign key enforcement outside of the current transaction. If you have not resolved outstanding foreign key violations at the end of your transaction, it will fail with a `FOREIGN KEY constraint failed` error."

同页给出的写法（逐字）：

```sql
-- Defer foreign key enforcement in this transaction.
PRAGMA defer_foreign_keys = on

-- Run your CREATE TABLE or ALTER TABLE / COLUMN statements
ALTER TABLE users ...

-- This is implicit if not set by the end of the transaction.
PRAGMA defer_foreign_keys = off
```

**⚠️ `PRAGMA foreign_keys = OFF` 在 D1 上到底能不能用？——上游结论需复核，结果是「官方两页冲突」。**

| 说法 | 逐字 | 来源 |
|---|---|---|
| **不能**：用户查询无法关闭外键 | "Because D1 runs every query inside an implicit transaction, **user queries cannot change this** during a query or migration." | <https://developers.cloudflare.com/d1/sql-api/foreign-keys/>（Apr 21, 2026） |
| **能**：`PRAGMA foreign_keys` 被列为 Compatible，且页面示例首行就是关掉它 | Compatible PRAGMA statements 列表含 `### PRAGMA foreign_keys = (on\|off)`，正文："Toggles the foreign key constraint enforcement. When `PRAGMA foreign_keys` is set to: `ON`: stops operations which violate foreign key constraints / **`OFF`: allows operations which violate foreign key constraints**"；且该页示例 SQL 块首行为 **`PRAGMA foreign_keys=off;`** | <https://developers.cloudflare.com/d1/sql-api/sql-statements/>（Apr 21, 2026） |

**→ 处理**：**两边都保留**（见 §8-1）。上游报告 `cloudflare-free-tier-constraints.md`/`cloudflare-d1-*` 引用的「D1 恒为 `PRAGMA foreign_keys = ON`，用户查询无法关闭」出自 foreign-keys 页，**该引用仍然成立**；但 sql-statements 页的存在使「是否真的无法关闭」成为**官方内部冲突**，而非单方事实。**落地建议（事实层）：按官方在导入章节唯一指定的 `PRAGMA defer_foreign_keys` 来做，不要依赖 `PRAGMA foreign_keys = OFF`**；并做 §7 实测。

**⚠️ 另一条未被官方解释的张力（重要）**：`d1 export` 的产物首行是 `PRAGMA defer_foreign_keys=TRUE;`，而官方说 **"D1 PRAGMA statements only apply to the current transaction."**（sql-statements 页 Caution 框逐字）。若导入被拆成多个事务逐条执行，这个「全局 defer」可能只对紧随其后的那一条语句生效。**官方未说明 import 作业的事务边界** → **[未证实]**（§7 列为高优先级实测项）。

### 4.4 `--file` 是否支持分片 / 多文件顺序执行

**[官方明确] 官方只给了「拆成多个文件」的建议，没有提供批量参数**：
> "For imports larger than 5GiB, we recommend **splitting the data into multiple files**."（Import/Export 页，Apr 21, 2026）

**[官方明确] CLI 的 `--file` 是单值**（命令页与源码均为 `--file string`，不是数组；对比 `d1 export --table` 是 `array: true`）。→ **多文件只能靠多次串行调用 `wrangler d1 execute <DB> --remote --file=part1.sql`、`... --file=part2.sql`**，即**由调用方（脚本/GitHub Actions/我们的代码）保证顺序**。
**[未找到一手来源]** 官方**未提供**任何「目录批量导入」「多文件原子提交」的原生通道；也**未说明**多文件之间是否共用一个事务（按 API 语义，每次 `--file` 是一次独立的 import 作业 → [官方间接] **不共用事务**）。

### 4.5 `wrangler d1 execute` 的事务语义（**官方未明确写文档，但有源码级证据**）

**[官方明确] wrangler 源码在 `--file` 导入前打印这句**（来源：<https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/execute.ts>，`main` 分支，采集于 2026-09-17）：

```js
logger.log(
  chalk.gray(
    `Note: if the execution fails to complete, your DB will return to its original state and you can safely retry.`
  )
);
```

**→ 这是「整个文件是一次原子操作、失败则回到原状」的最强官方证据**（来自 Cloudflare 自己的 CLI 源码，而非第三方）。
**[官方间接]（由此可推）**：`--file` 的导入**不是「逐语句部分落库」**——至少 CLI 向用户这样承诺。

**[官方明确] 但实现路径 `--local` 与 `--remote` 完全不同**（源码逐字）：

| 目标 | 实现 | 逐字证据 |
|---|---|---|
| `--local` | 读文件 → **拆分语句** → **一次 `db.batch()`** | `const queries = splitSqlQuery(sql);` / `results = await db.batch(queries.map((query) => db.prepare(query)));` |
| `--remote` | **不拆 SQL**，先 `md5File` 求 etag，走 import API 的 `init` → `PUT`（上传到 `upload_url`）→ `ingest` → `poll` | `const etag = await md5File(input.file);` … `d1ApiPost(config, accountId, db, "import", { action: "init", etag })` … `fetch(upload_url, { method: "PUT", ... body: createReadStream(file), duplex: "half" })` … `{ action: "ingest", filename, etag }` … `{ action: "poll", current_bookmark: response.at_bookmark }` |
| `--command`（非 `--file`） | 直接 `POST .../query`，**由服务端按 `;` 拆分** | `const result = await d1ApiPost<QueryResult[]>(config, accountId, db, "query", { sql });` + 注释 `// The D1 query API splits multi-statement SQL on ';' server-side, and mishandles CRLF line endings inside compound statements such as a 'CREATE TRIGGER ... BEGIN ... END;' body (issue #14991). Normalize structural line endings while preserving quoted SQL values.` |

**→ 结论（严格）**：
- **`--local`**：官方源码显示是**单次 `db.batch()`**，而 D1/Miniflare 的 `batch()` 语义是「作为 SQL 事务顺序、原子执行；任一条失败则整体回滚」（沿用 `cloudflare-runtime-fetch-facts.md` §4 已核实口径）→ **原子**。[官方间接]
- **`--remote`**：走 import API 作业，CLI **向用户承诺**「失败回到原状」（源码逐字），但**官方文档从未写 import 作业的事务边界、失败后是否部分落库** → **「整个文件是一个事务」[未证实]；「失败会部分落库」亦 [未证实]**。
- **官方文档层面：`wrangler d1 execute --file` 的事务语义 [未找到一手来源]**（命令页与 Import/Export 页均无该表述）。

**[官方明确] 导入完成后的可见输出**（源码逐字）：

```
🚣 Executed {num_queries} queries in {meta.duration}ms ({meta.rows_read} rows read, {meta.rows_written} rows written)
   Database is currently at bookmark {final_bookmark}.
```
→ 这给了一条**实测「导入吃了多少写行」的现成通道**（`rows_written` 直接可见，见 §7）。

**[官方明确] 导入是异步作业，可 `status: "error"`**：
> `error`："Only present when `status = 'error'`. Contains the error message that prevented the import from succeeding."（import API 参考）
> CLI 侧对应抛出 `response.errors?.join("\n")`（源码逐字）。

### 4.6 用 SQL 重建整个库（含触发器 / 索引）的官方推荐流程

**官方材料里能拼出的只有这几条（不含推测）：**

1. **[官方明确] 官方对「库结构如何版本化」的答案是 migrations，不是 dump**：
   > "Database migrations are a way of **versioning your database**. Each migration is stored as an `.sql` file in your `migrations` folder. ... **Every migration file in the `migrations` folder has a specified version number in the filename. Files are listed in sequential order.**"（<https://developers.cloudflare.com/d1/reference/migrations/>，Jun 8, 2026）
   > "Creating migrations will keep a record of applied migrations in the **`d1_migrations`** table found in your database."（同页）
2. **[官方明确] 官方在迁移侧同样只用 `defer_foreign_keys`**（Migrate 页逐字，与 §4.3 同句）。
3. **[官方明确] `wrangler d1 migrations apply` 会**自动**抓一份备份**（`d1` 命令页逐字，**该页无 Last updated**）：
   > "This command will prompt you to confirm the migrations you are about to apply. Confirm that you would like to proceed. **After applying, a backup will be captured.**
   > When running the apply command in a CI/CD environment or another non-interactive command line, the confirmation step will be skipped, but **the backup will still be captured**.
   > If applying a migration results in an error, **this migration will be rolled back, and the previous successful migration will remain applied.**"
   > ⚠️ 注意：这句出现在 **`wrangler d1` 命令参考页**，其措辞（"a backup will be captured"）**未说明**该 backup 落在哪（是否即 Time Travel bookmark / 快照 API）；旧快照 API 已随 alpha 后端下线（§5.1）。→ 该 backup 的确切载体 **[未找到一手来源]**，列入 §7。
4. **[官方明确] 触发器 / 索引随 `CREATE TABLE` / `CREATE INDEX` 语句走 SQL 通道**：D1 支持 FTS5、JSON、Math 扩展（沿用 `cloudflare-free-tier-constraints.md` §4.1 口径）；`PRAGMA foreign_key_list / index_list / index_info` 等**结构内省 PRAGMA 在 D1 可用**（sql-statements 页 Compatible 列表：`PRAGMA table_list`、`table_info`、`table_xinfo`、`index_list`、`index_info`、`index_xinfo`、`quick_check`、`foreign_key_check`、`foreign_key_list`）→ **可用它们核验回导后的表/索引是否齐备**。[官方明确]
5. **[官方明确] 索引/触发器在「达到存储上限」时会受影响**：
   > "Once you have reached your included storage limit, you will need to delete unused databases or clean up stale data before you can insert new data, create or alter tables or **create indexes and triggers**."（FAQ，Apr 21, 2026）
6. **[未找到一手来源] 官方没有给出**「用 SQL 从零重建含触发器/索引的库」的**编号流程**；官方只分别给了 migrations 流程与 import 流程。

---

## 5. 备份的官方最佳实践

### 5.1 官方有没有专门的「备份与恢复 / 导入导出」文档页？——有，共 3 页 + 1 篇 how-to

| 页面标题（逐字） | URL | Last updated | 定位 |
|---|---|---|---|
| **Time Travel and backups** | <https://developers.cloudflare.com/d1/reference/time-travel/> | **Apr 21, 2026** | 事实上的「Back up and restore」主页面 |
| **Backups (Legacy)** | <https://developers.cloudflare.com/d1/reference/backups/> | **Apr 21, 2026** | 仅适用 `version: alpha` 旧库；**计划于 2025-07-01 移除** |
| **Import and export data** | <https://developers.cloudflare.com/d1/best-practices/import-export-data/> | **Apr 21, 2026** | 导出/导入的官方做法与限制 |
| **Export and save D1 database**（Workflows how-to） | <https://developers.cloudflare.com/workflows/examples/backup-d1/> | **Jun 2, 2026** | 官方「长期留存」的推荐实现 |

### 5.2 「Backups (Legacy)」页的现状（**不要误用**）

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/reference/backups/>（Apr 21, 2026）：

> "**Planned removal** — Access to snapshot based backups for D1 alpha databases described in this documentation will be removed on **2025-07-01**."（页内链接至 <https://developers.cloudflare.com/d1/platform/release-notes/#2025-07-01>）
> "D1 has built-in support for creating and restoring backups of your databases with **wrangler v3**, including support for scheduled automatic backups and manual backup management."
> "D1 automatically backs up your databases **every hour** on your behalf, and **retains backups for 24 hours**. Backups will block access to the DB while they are running."

**[官方明确]** 发布说明（<https://developers.cloudflare.com/d1/platform/release-notes/>，条目 **2025-07-01**）：
> "**D1 alpha database backup access removed** — Following the removal of query access to D1 alpha databases on 2024-08-23, **D1 alpha database backups can no longer be accessed or created with `wrangler d1 backup`**, available with wrangler v3."

**[官方明确]** 条目 **2023-12-18**：
> "**Legacy alpha automated backups disabled** — Databases using D1's legacy alpha backend will no longer run automated hourly backups. ... The new backend also supports Time Travel, which allows you to restore your database to any minute in the past 30 days **without relying on hourly or manual snapshots**."

**→ 结论**：`wrangler d1 backup list/create/download/restore` 系列命令属于 **alpha 旧后端**，**已于 2025-07-01 下线**（`wrangler d1 backup` 相关能力对 production 库不可用）。**本项目 2026 年新建的库走 production 后端，`d1 backup` 路径不适用**。
> ⚠️ 注意矛盾点：wrangler `d1` 命令参考页**仍列有** `d1 migrations apply` 的「a backup will be captured」，而 alpha 快照备份已于 2025-07-01 下线。→ 该句的载体 **[未找到一手来源]**（§7）。

### 5.3 官方逐条推荐做法（只摘官方原文）

| # | 官方原文 | 出处 | 标注 |
|---|---|---|---|
| 1 | "Time Travel ... **You do not need to enable** Time Travel. It is always on."（默认机制，无需配置） | Time Travel 页 | [官方明确] |
| 2 | "By not having to rely on scheduled backups and/or manually initiated backups, you can go back in time and restore a database prior to **a failed migration or schema change**, a `DELETE` or `UPDATE` statement without a specific `WHERE` clause"（典型适用场景） | Time Travel 页 | [官方明确] |
| 3 | "You can automatically export your D1 database into R2 storage via REST API and Cloudflare Workflows. **This may be useful if you wish to store a state of your D1 database for longer than 30 days.**" | Time Travel 页 / Workflows how-to | [官方明确] |
| 4 | "Creating a **manual backup** of your database **before making large schema changes, manually inserting or deleting data**, or otherwise modifying a database you are actively using **is a good practice to get into**." | Backups (Legacy) 页（Apr 21, 2026）—— **该页属 alpha 语境，但这是全站唯一一句「该备份」的规范性表述** | [官方明确]（措辞）/ [官方间接]（对本项目的适用性） |
| 5 | "You should also consider **using migrations** to simplify changes to an existing database."（同段落） | Backups (Legacy) 页 | [官方明确] |
| 6 | "Restoring a backup will overwrite the existing version of your D1 database in-place. **We recommend you make a manual backup before you restore a database**, so that you have a backup to revert to if you accidentally restore the wrong backup" | Backups (Legacy) 页 | [官方明确]（措辞）/ 同 4 的适用性保留 |
| 7 | 导入侧："call `PRAGMA defer_foreign_keys = true`"、"ensure you are importing the tables in the right order"、"remove `BEGIN TRANSACTION` and `COMMIT`" | Import/Export 页 | [官方明确] |
| 8 | 导入大小："limited to 5GiB files ... **splitting the data into multiple files**" | Import/Export 页 | [官方明确] |
| 9 | 结构内省可用于核验："`PRAGMA quick_check` / `foreign_key_check` / `index_list` / `table_list`"（均为 Compatible PRAGMA） | sql-statements 页 | [官方明确] |

### 5.4 官方「长期留存」的推荐实现（可直接核对的官方代码）

**[官方明确]** 来源：<https://developers.cloudflare.com/workflows/examples/backup-d1/>（Last updated **Jun 2, 2026**）。官方要点逐字：

> "In this example, we implement a Workflow that runs **on a schedule** using the `schedules` field on the Workflow binding. That Workflow **initiates a backup for a D1 database using the REST API**, and then **stores the SQL dump in an R2 bucket**."
> "When the Workflow is triggered, it fetches the REST API to initiate an export job for a specific database. Then it fetches the same endpoint to check if the backup job is ready and the SQL dump is available to download."
> "Create `D1_REST_API_TOKEN` as a secret with permission to export the target D1 database."

官方示例的核心两步（逐字代码）：

```js
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
// 第一步：发起导出，拿 at_bookmark
const payload = { output_format: "polling" };
const { result } = await res.json();
if (!result?.at_bookmark) throw new Error("Missing `at_bookmark`");
// 第二步：用 current_bookmark 轮询，拿到 signed_url 后下载并写入 R2
const payload = { current_bookmark: bookmark };
const { result } = await res.json();
if (!result?.signed_url) throw new Error("Missing `signed_url`");
const dumpResponse = await fetch(result.signed_url);
await this.env.BACKUP_BUCKET.put(result.filename, dumpResponse.body);
```

官方 Wrangler 配置片段（逐字）：

```jsonc
"workflows": [{ "name": "backup-workflow", "binding": "BACKUP_WORKFLOW", "class_name": "backupWorkflow", "schedules": ["0 0 * * *"] }],
"r2_buckets": [{ "binding": "BACKUP_BUCKET", "bucket_name": "d1-backups" }]
```

> 官方另注："Use the latest Wrangler release when configuring Workflow schedules. If your local Wrangler schema does not recognize `schedules` yet, update Wrangler before deploying."；示例 `package.json` 写 `"wrangler": "^3.99.0"`（**官方示例自身用的是 v3 版本号**）。
> **⚠️ 该方案依赖 R2 ⇒ 受 §6 的绑卡问题约束**（[官方间接]：官方示例未讨论绑卡成本）。

### 5.5 官方有没有说「导出物里必须包含迁移文件 / schema」？

**[未找到一手来源]** 逐页核对 Time Travel 页、Backups (Legacy) 页、Import/Export 页、Migrations 页、Workflows how-to，**没有任何一句要求「导出物必须包含迁移文件」**。
**能确证的相邻事实（[官方明确]）**：
- `wrangler d1 export` **默认就是 schema + data**（`--no-data` 才只导 data，`--no-schema` 才只导 schema）→ 官方默认口径是「导出物自带 schema」。
- 官方把 **migrations 目录**作为 schema 的**版本化来源**（"Database migrations are a way of versioning your database."），并把已应用记录存在库内 `d1_migrations` 表（**该表会随全量 export 一起被导出**，因为它也在库里 → [官方间接]）。
- **官方未说明** `d1_migrations` 表是否应随生产数据一起回导（会不会影响 `wrangler d1 migrations list` 的判断）→ **[未找到一手来源]**，列入 §7。

### 5.6 官方对「D1 不做备份的风险」有无表态？

**[未找到一手来源]**。逐页核对 D1 概览页、FAQ 页、Limits 页、Pricing 页、Migrations 页、Storage options 页、Time Travel 页、Backups (Legacy) 页，**均无**免责声明、SLA 说明或「请自行备份，否则……」类表述。

**能确证的只有两条相邻表述（[官方明确]）**：
1. D1 概览页（<https://developers.cloudflare.com/d1/>，Apr 30, 2026）：
   > "D1 is Cloudflare's managed, serverless database with SQLite's SQL semantics, **built-in disaster recovery**, and Worker and HTTP API access."
2. Storage options 页（<https://developers.cloudflare.com/workers/platform/storage-options/>，Last updated **Apr 23, 2026**）：
   > "D1 aims for a 'batteries included' feature set, including the above HTTP API, database schema management, **data import/export**, and database query insights."
3. D1 FAQ 关于写入持久性（转述官方博客，**标 [官方间接]**）："Writes need to be durably persisted across several locations - learn more on how D1 persists data under the hood"（链接到 Cloudflare 官方博客 <https://blog.cloudflare.com/d1-read-replication-beta/>）。

**→ 严格结论**：**官方没有对「不做备份的风险」作出表态**。本清单**不代替官方**说「D1 会丢数据」或「D1 不会丢数据」。若有此需求，应查 Cloudflare **Self-Serve Subscription Agreement**（本轮未检索该法律文件，**列为缺口**）。

---

## 6. R2 与免费套餐的绑卡要求

### 6.1 直接结论

**「R2 免费额度需要先绑定付款方式才能开通」这条 —— 仍然成立，但最强的证据是 [官方间接]（多页共同指向），而不是一句逐字原文。**

### 6.2 逐条证据

| # | 逐字 | 来源 | 标注 |
|---|---|---|---|
| 1 | "**Before you begin** — You need a Cloudflare account **with an R2 subscription**. If you do not have one: 1. Go to the Cloudflare Dashboard. 2. Select **Storage & databases > R2 > Overview** 3. **Complete the checkout flow to add an R2 subscription to your account.**" | <https://developers.cloudflare.com/r2/get-started/>，Last updated **Apr 21, 2026** | [官方明确]（要走 checkout 订阅流程） |
| 2 | "Ensure that you are using **a valid payment method before** changing your plan type or **enabling subscriptions**." | <https://developers.cloudflare.com/billing/understand/billing-policy/>，Last updated **May 29, 2026** | [官方明确] |
| 3 | "**A primary payment method is required to purchase Cloudflare products and services.**" | <https://developers.cloudflare.com/billing/get-started/create-billing-profile/>，Last updated **May 29, 2026** | [官方明确] |
| 4 | "**Account Payment Method Preauthorization** — For services subject to usage-based billing, Cloudflare **may preauthorize your credit card** at any point in a billing period to confirm the payment method on file can cover accrued fees. ... If your payment method fails, we may suspend your access to the usage-based billing services ... **In the case of R2, you will not be able to access your R2 buckets and requests will return errors**, but your data will remain secure. If you do not update your payment method within 30 days, the data ... may be deleted." | 同 #2（billing-policy 页） | **[官方明确]**（R2 属 usage-based 且需「payment method on file」） |
| 5 | "Complete your purchase — Navigate to **R2 > Overview** on the left-hand side of the screen and **input your payment details**. Don't worry, you will only be charged if you exceed the monthly limits." | <https://www.cloudflare.com/pg-lp/r2>（Cloudflare 官方营销落地页；**页面不显示 Last updated**） | [官方明确]（官方一手域名的直白表述） |
| 6 | "R2 Storage and operations — Free tier: **10 GB storage, 1M Class A operations, and 10M Class B operations**" | <https://developers.cloudflare.com/support/account-management-billing/billing-add-on-service/>（Usage-based billing，通过站点搜索命中） | [官方明确] |

**⚠️ 一处官方内部的表述张力（一并记录，不抹掉）**：`www.cloudflare.com/products/r2/` 与 `/pg-lp/r2` 同时写有 "**Start building for free — no credit card required.**" / "Complete your purchase ... **input your payment details**"。两句同页并存，前者泛指 Cloudflare 开发者平台账号注册，后者针对 R2 订阅 checkout。**官方未澄清二者关系** → 记为张力（§8-3）。

### 6.3 二手旁证（**不得作为结论依据**）

Cloudflare Community 帖 `Why using R2 free tier involves giving card info?`（<https://community.cloudflare.com/t/why-using-r2-free-tier-involves-giving-card-info/945179>，帖子日期 2026-08）中，用户实测描述 "R2 requires billing info for the free tier ... a mandatory billing card information dialog appears ... the dialog cannot be bypassed"，论坛回复称 "The usage is not capped, if you exceed the free allocation on R2 you will be charged so a payment method is needed."。**属社区来源，仅作行为层旁证，本清单不作为结论依据。**

### 6.4 R2 免费额度（**只要官方数字，不做容量估算**）

**[官方明确]** 来源：<https://developers.cloudflare.com/r2/pricing/>，Last updated **Aug 7, 2026**，Free tier 表逐字：

| Free | 数字 |
|---|---|
| Storage | **10 GB-month / month** |
| Class A Operations | **1 million requests / month** |
| Class B Operations | **10 million requests / month** |
| Egress (data transfer to Internet) | **Free** |

> 附加逐字："**The free tier only applies to Standard storage**, and does not apply to Infrequent Access storage."
> 计费粒度逐字："**Billable unit rounding** — Cloudflare rounds up your usage to the next billing unit. For example: If you have performed one million and one operations, you will be billed for two million operations."
> Class A 操作清单逐字含 `PutObject`、`ListObjects`、`CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload` 等；Class B 含 `GetObject`、`HeadObject` 等；免费操作含 `DeleteObject`、`DeleteBucket`、`AbortMultipartUpload`。

**[官方明确]** R2 相关硬限额（<https://developers.cloudflare.com/r2/platform/limits/>，Last updated **Jun 8, 2026**）：
> `Object size | 5 TiB per object`；`Maximum upload size | 5 GiB (single-part) / 4.995 TiB (multi-part)`；`Maximum number of buckets per account | 1,000,000`；`Maximum upload parts | 10,000`
> `Cloudflare REST API — rate limited to 1,200 requests per five minutes across all R2 REST API operations on your account.`
> `r2.dev` 端点："not intended for production usage and has a **variable rate limit** applied to it"（超过「hundreds of requests/second」返回 `429`）。

### 6.5 不绑卡还能放小文件的官方通道

| 通道 | 是否需单独订阅 / 绑卡 | 官方额度（Free） | 来源 + 日期 | 标注 |
|---|---|---|---|---|
| **Workers KV** | **随 Workers Free 计划提供，无独立订阅** → 推断不需绑卡。逐字："Workers KV is included in both the **Free and Paid Workers plans**." | Reads **100,000 / day**；Writes to different keys **1,000 / day**；Writes to same key **1 per second**；List requests **1,000 / day**；Storage/account **1 GB**；Storage/namespace **1 GB**；Keys/namespace unlimited；**Key size 512 bytes**；**Key metadata 1024 bytes**；**Value size 25 MiB**；Operations/Worker invocation **1000** | 定价：<https://developers.cloudflare.com/kv/platform/pricing/>（**Apr 21, 2026**）；限额：<https://developers.cloudflare.com/kv/platform/limits/>（**Apr 21, 2026**） | [官方明确]（数字）；**[官方间接]**（「不需绑卡」——官方**未**用一句逐字说明 KV 不需付款方式） |
| **D1 自身**（当作存放 dump 的地方） | 包含在 Workers Free 内（"Available on Free and Paid plans"） | Databases per account **10**（Free）；Max DB size **500 MB**（Free）；Storage per account **5 GB**（Free）；**Max row size 2 MB**；**Max SQL statement length 100 KB** | <https://developers.cloudflare.com/d1/platform/limits/>（**Apr 21, 2026**）；<https://developers.cloudflare.com/d1/>（**Apr 30, 2026**） | [官方明确] |
| **R2** | **需订阅 checkout**（§6.2） | 10 GB-month / 1M Class A / 10M Class B | <https://developers.cloudflare.com/r2/pricing/>（**Aug 7, 2026**） | [官方明确] |
| Workers Free 本身 | 免费、无需绑卡（官方营销页 "no credit card required" 泛指开发平台） | 100,000 requests/day、10ms CPU、等（沿用 `cloudflare-free-tier-constraints.md`） | 既有报告已核实，本文不重复 | [官方明确]（沿用） |

**⚠️ 关于「KV 是否也需要绑卡」的准确回答**：**未找到任何官方文档逐字说明「KV 不需要付款方式」或「KV 需要付款方式」**。可确证的只是 KV 属于 Workers Free 计划内含能力、**没有独立的订阅/checkout 步骤**（对比 R2 明写 "Complete the checkout flow to add an R2 subscription"）→ 因此 **「KV 不需绑卡」是 [官方间接] 推断，不是官方承诺**，列入 §7 实测。
**⚠️ 关于「用 KV 放 dump 的容量是否够」**：本清单**只给官方数字**（Value size **25 MiB** / Storage **1 GB** / Writes **1,000/day**），**不做容量换算**（按要求）。
**⚠️ 关于「用 D1 自身放 dump」**：官方数字给了 **Max row size 2 MB** 与 **Max SQL statement length 100 KB**，两者都是硬约束，直接决定「以单行文本存一整份 dump」的做法在多大尺寸上失效 —— 本清单只陈述数字，不做方案判断。

---

## 7. 未找到 / 未证实 / 需实测（缺口全清单）

### A. 未找到一手来源（官方文档/官方仓库未给出该表述、数字或端点）

| # | 缺口 | 已核对的页面范围 | 可执行实测方法 |
|---|---|---|---|
| A1 | **dashboard 上的 Time Travel 恢复入口** | 逐页核对 time-travel / limits / faq / backups(Legacy) / release-notes，均无 dashboard 步骤 | 登录 dashboard → **Workers & Pages → D1 → 选库**，找是否存在 Time Travel / Backups 面板与"restore"按钮；截图存档 |
| A2 | **`wrangler d1 export` 的导出大小/时长上限** | D1 Limits 页限额表只有 import 5 GB，无 export 条目 | `npx wrangler d1 export <DB> --remote --output=./big.sql` 对一个刻意造大的库测量；同时观察是否出现大小/时长错误码 |
| A3 | **导出是否消耗 rows read 日配额** | Pricing/FAQ 只给「任何查询都算 reads/writes」，未提 REST export 作业 | 导出前后记录 dashboard 的 **Metrics > Row Metrics**（Rows Read），比对增量；或记录 `meta.rows_read`（`d1 execute --json`） |
| A4 | **`--remote` 导出 SQL 的确切文本形态**（是否含 `PRAGMA defer_foreign_keys=TRUE;` 首行、索引/触发器语句是否出现、日期/时间如何写、表顺序） | 官方文档无样例；wrangler 源码只下载 `signed_url`，不在客户端生成 | `npx wrangler d1 export family-finance --remote --output=./dump.sql`，然后 `head -50 dump.sql` + `grep -nE "^(PRAGMA|BEGIN|COMMIT|CREATE INDEX|CREATE TRIGGER|-)" dump.sql` |
| A5 | **`d1 export` 是否导出索引 / 触发器 / 视图 / `d1_migrations` 表** | 官方文档未说明；wrangler 源码不含生成逻辑 | 同上，对 `dump.sql` 执行 `grep -c "CREATE INDEX"`，与 `PRAGMA index_list` 结果数（**12 个显式索引**）比对 |
| A6 | **`wrangler d1 execute --file` 的语句数上限** | Limits 页只有单条语句 100 KB / 100 绑定参数 | 构造 5,000 / 50,000 条小 INSERT 的 .sql，`wrangler d1 execute <DB> --remote --file=...`，观察是否报错及 `num_queries` |
| A7 | **`wrangler d1 execute --file` 的事务语义**（整文件一个事务？失败是否部分落库？） | 命令页、Import/Export 页均无该表述（只有 CLI 源码的一句用户提示） | 构造 `CREATE TABLE t(...); INSERT INTO t VALUES(1); INSERT INTO t VALUES('故意类型错误');` 的 .sql，`--remote` 执行后查 `SELECT COUNT(*) FROM t`：若为 0 则整体回滚，否则部分落库 |
| A8 | **`wrangler d1 migrations apply` 的 "a backup will be captured" 落在哪个载体**（Time Travel bookmark？已下线的快照 API？） | `d1` 命令页有此句；alpha 快照备份已于 2025-07-01 下线，两者矛盾 | 对一个测试库执行 `wrangler d1 migrations apply <DB> --remote`，立即 `wrangler d1 time-travel info <DB>` 并观察输出/日志中是否出现 backup id |
| A9 | **`d1_migrations` 表随 dump 回导是否影响后续 `migrations list/apply`** | Migrations 页只说「会记录在 `d1_migrations`」 | 在测试库：`export` → 删库/新库 → `execute --file` 回导 → 跑 `wrangler d1 migrations list <DB> --remote`，看是否把所有迁移判为「已应用」 |
| A10 | **官方对「不做备份的风险」的表态** | D1 概览 / FAQ / Limits / Pricing / Migrations / Storage options / Time Travel / Backups 八页均无免责声明 | 检索 Cloudflare **Self-Serve Subscription Agreement** 与 D1 SLA 文本（本轮**未检索法律/合同文件**，属明确缺口） |
| A11 | **KV 是否真的不需要绑卡** | KV Pricing / Limits 页均无付款方式表述 | 用一个未绑卡的 Cloudflare 账号（或用 `wrangler kv namespace create`）实测能否直接创建 namespace 并写入 |
| A12 | **官方是否有 CU / CSV / JSON 导出** | D1 全部文档 + API 参考（export 端点只有 `dump_options { no_data, no_schema, tables }`） | 无需实测；已在本文判定为「官方只有 `.sql`」 |
| A13 | **R2 是否**必须**绑信用卡（非 PayPal 等）** | R2 Get started / Pricing / Limits / Billing policy / create-billing-profile；官方未逐字写「R2 需信用卡」 | 用一个未绑卡账号走 R2 Overview 的 checkout，记录被要求的最低条件（是否 PayPal / Apple Pay 亦可） |
| A14 | **`--remote` import 作业是否整体事务性** | import API 参考只有 `status: error` + `error` 消息，无事务边界说明 | 见 A7 的实测（同一实验即可覆盖 CLI 与 API 两条通道） |

### B. 未证实（无官方原文且无法推导，只能实测的行为性结论）

| # | 待证实命题 | 为什么无法从官方文本闭合 | 实测方法 |
|---|---|---|---|
| B1 | **Time Travel 是否真能精确到「秒」** | 官方只承诺 "any minute"；API 接受到毫秒的 ISO 8601 | 同一分钟内制造两次写（间隔 20s，写入可区分的标记），分别按两个时间戳 restore，看落到哪个状态 |
| B2 | **`PRAGMA defer_foreign_keys=TRUE;`（dump 首行）在 import 时是否真能覆盖全文件的 15 张表** | 官方说 "D1 PRAGMA statements only apply to the current transaction"，但未说 import 作业的事务边界 | 对一个**故意逆序排列 INSERT**（子表在前）的 dump 执行 `--remote --file`，看是否通过；再删掉首行 PRAGMA 重跑对照 |
| B3 | **`PRAGMA foreign_keys = OFF` 在 D1 上是否实际生效**（官方两页冲突，§8-1） | 两页口径互斥 | `wrangler d1 execute <DB> --remote --command "PRAGMA foreign_keys=off; INSERT INTO <子表> VALUES(<不存在的父键>);"` → 用 `PRAGMA foreign_key_check` 看是否留下违规行 |
| B4 | **`--remote` import 的**失败**是否留下部分数据** | 官方文档无表述（CLI 只有一句用户提示） | 同 A7 |
| B5 | **Time Travel 恢复在「库被删掉」时是否可用** | 官方只讨论对**存在**的库 restore；未提被删除的库 | **不要在生产库上测**；如需了解，用测试库 `DELETE` 库后观察 `time-travel restore` 的返回 |
| B6 | **REST API export/import 作业是否与正常查询争用同一「单线程队列」** | 官方只说 "will be unavailable to serve queries" / "block the D1 for their duration"，未说排队语义 | 导出进行中并发发起一个 `SELECT`，观察是排队、超时还是 `overloaded` |
| B7 | **导出期间 Pages Functions 的记账请求会不会被计为失败请求** | 官方无表述 | 边导出边打应用接口，看 HTTP 状态码与 D1 error list（<https://developers.cloudflare.com/d1/observability/debug-d1/#error-list>） |

### C. 需实测（本项目落地前必须自测）

```powershell
# C1 基线：确认库在 production 后端（Time Travel 可用）
npx wrangler d1 info family-finance        # 期望 version: production

# C2 当前 bookmark（记下来，便于任何破坏性操作前留后路）
npx wrangler d1 time-travel info family-finance

# C3 全量导出 + 形态核对（回答 A4/A5）
npx wrangler d1 export family-finance --remote --output=./backup\full.sql
(Get-Content .\backup\full.sql -TotalCount 20)
Select-String -Path .\backup\full.sql -Pattern '^(PRAGMA|BEGIN|COMMIT|CREATE INDEX|CREATE TRIGGER)'

# C4 只导 schema 与只导单表（验证 --no-data / --table 的行为）
npx wrangler d1 export family-finance --remote --no-data --output=./backup\schema.sql
npx wrangler d1 export family-finance --remote --table=quote_daily --output=./backup\quotes.sql

# C5 回导到**新建的测试库**（绝不在生产库上做破坏性验证）
npx wrangler d1 create family-finance-restore-test
npx wrangler d1 execute family-finance-restore-test --remote --file=./backup\full.sql
npx wrangler d1 execute family-finance-restore-test --remote --command "PRAGMA foreign_key_check;"
npx wrangler d1 execute family-finance-restore-test --remote --command "PRAGMA index_list('transactions');"

# C6 记账写行数（回答「回导吃多少 rows written」）
#    注意 --json 输出里读 meta.rows_written
npx wrangler d1 execute family-finance-restore-test --remote --file=./backup\full.sql --json
```

---

## 8. 互相矛盾 / 口径不一致之处（**保留双方，不抹掉**）

| # | 冲突点 | 说法 A（逐字 + 日期） | 说法 B（逐字 + 日期） | 处理建议 |
|---|---|---|---|---|
| 1 | **`PRAGMA foreign_keys` 在 D1 能否被用户关闭** | "Because D1 runs every query inside an implicit transaction, **user queries cannot change this** during a query or migration."（<https://developers.cloudflare.com/d1/sql-api/foreign-keys/>，**Apr 21, 2026**） | `### PRAGMA foreign_keys = (on\|off)` 被列为 Compatible，正文："**`OFF`: allows operations which violate foreign key constraints**"；且该页示例 SQL 首行为 `PRAGMA foreign_keys=off;`（<https://developers.cloudflare.com/d1/sql-api/sql-statements/>，**Apr 21, 2026**） | **同一天的两页互斥**。上游报告引用的 A 说法**仍然成立**，但不能据此断言 B 为错。**落地只用官方在导入章节指定的 `PRAGMA defer_foreign_keys`**，并用 §7-B3 实测 |
| 2 | **Free 计划的 Time Travel 窗口** | Time Travel 页**首句**只写 "within the last 30 days"（<https://developers.cloudflare.com/d1/reference/time-travel/>，Apr 21, 2026） | 同页 **Notes** 与 Limits 页写 "30 days (Workers Paid) / **7 days (Free)**"（同页末；<https://developers.cloudflare.com/d1/platform/limits/>，Apr 21, 2026） | **不冲突但极易误读**（首句未标计划）。**以 Limits 表 + Notes = Free 7 天 为准** |
| 3 | **R2 是否「无需信用卡」** | "**Start building for free — no credit card required.**"（<https://www.cloudflare.com/products/r2/>，无日期） | "Complete your purchase — ... **input your payment details**"（<https://www.cloudflare.com/pg-lp/r2>，无日期）；"You need a Cloudflare account **with an R2 subscription** ... Complete the **checkout flow**"（<https://developers.cloudflare.com/r2/get-started/>，Apr 21, 2026） | 前者泛指平台注册，后者针对 R2 订阅 checkout。**官方未澄清**。按 checkout 口径规划（= 需要付款方式），并做 §7-A13 实测 |
| 4 | **`wrangler d1 export` —— 客户端拼 SQL 还是服务端生成** | 本地路径：`PRAGMA miniflare_d1_export(?,?,?)` 由 Miniflare 生成 dump（workers-sdk `d1/export.ts`） | 远程路径：调 `POST .../export` + 轮询 + 下载 `signed_url`，**客户端不生成 SQL**（同文件） | **不是冲突，是两个目标的不同实现**。**但会造成「本地导出的 dump 形态 ≠ 远程导出的 dump 形态」的风险**；若以本地 dump 作为格式依据，必须用远程 dump 复核（§7-A4） |
| 5 | **`wrangler d1 backup` 是否仍可用** | `d1` 命令参考页仍有 `d1 migrations apply` 段落写 "a backup will be captured"（<https://developers.cloudflare.com/workers/wrangler/commands/d1/>，**无日期**） | "**D1 alpha database backups can no longer be accessed or created with `wrangler d1 backup`**"（<https://developers.cloudflare.com/d1/platform/release-notes/>，**2025-07-01**）；Backups (Legacy) 页标 "**Planned removal** ... 2025-07-01" | **以 release notes（有明确日期）为准 = alpha 快照备份已下线**；`migrations apply` 那句 "backup" 的载体不明（§7-A8） |
| 6 | **导出是否「受 50 次查询/调用」约束** | D1 Limits 页仍写 `Queries per Worker invocation ... 1000 (Workers Paid) / 50 (Free)`（Apr 21, 2026） | Workers Limits 页 + **2026-02-11 Changelog**：Free = **50 external subrequests and 1,000 subrequests to Cloudflare services**（沿用 `cloudflare-pages-deploy-and-quota-facts.md` §3.4/§8-1 已记录） | 该冲突**已在既有报告中保留**；本文补充结论：**`wrangler d1 export --remote` 与 REST export/import 走的是 API 而非 Worker invocation，故这两条限额都不约束它们**（[官方间接]，依据是源码里的请求路径） |

---

## 9. 附：本文全部来源 URL 与文档日期（便于复核）

| 来源 | URL | Last updated / 日期 |
|---|---|---|
| D1 · Time Travel and backups | <https://developers.cloudflare.com/d1/reference/time-travel/> | Apr 21, 2026 |
| D1 · Limits | <https://developers.cloudflare.com/d1/platform/limits/> | Apr 21, 2026 |
| D1 · Pricing | <https://developers.cloudflare.com/d1/platform/pricing/> | Apr 21, 2026 |
| D1 · FAQs | <https://developers.cloudflare.com/d1/reference/faq/> | Apr 21, 2026 |
| D1 · Import and export data | <https://developers.cloudflare.com/d1/best-practices/import-export-data/> | Apr 21, 2026 |
| D1 · Define foreign keys | <https://developers.cloudflare.com/d1/sql-api/foreign-keys/> | Apr 21, 2026 |
| D1 · SQL statements（Compatible PRAGMA） | <https://developers.cloudflare.com/d1/sql-api/sql-statements/> | Apr 21, 2026 |
| D1 · Backups (Legacy) | <https://developers.cloudflare.com/d1/reference/backups/> | Apr 21, 2026 |
| D1 · Release notes | <https://developers.cloudflare.com/d1/platform/release-notes/> | Apr 21, 2026 |
| D1 · Migrations | <https://developers.cloudflare.com/d1/reference/migrations/> | Jun 8, 2026 |
| D1 · Overview | <https://developers.cloudflare.com/d1/> | Apr 30, 2026 |
| D1 · Getting started | <https://developers.cloudflare.com/d1/get-started/> | Aug 25, 2026 |
| Wrangler · `d1` commands（export / execute / migrations / time-travel） | <https://developers.cloudflare.com/workers/wrangler/commands/d1/> | — （不显示） |
| D1 API · Export D1 Database as SQL | <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/> | — （不显示） |
| D1 API · Import SQL into your D1 Database | <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/> | — （不显示） |
| D1 API · 资源总览（含 time_travel 端点） | <https://developers.cloudflare.com/api/resources/d1/> | — （不显示） |
| D1 API · Restore to bookmark or point in time | <https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/restore/> | — （不显示） |
| Workflows · Export and save D1 database | <https://developers.cloudflare.com/workflows/examples/backup-d1/> | Jun 2, 2026 |
| Workers · Choose a data or storage product | <https://developers.cloudflare.com/workers/platform/storage-options/> | Apr 23, 2026 |
| KV · Pricing | <https://developers.cloudflare.com/kv/platform/pricing/> | Apr 21, 2026 |
| KV · Limits | <https://developers.cloudflare.com/kv/platform/limits/> | Apr 21, 2026 |
| R2 · Pricing | <https://developers.cloudflare.com/r2/pricing/> | Aug 7, 2026 |
| R2 · Limits | <https://developers.cloudflare.com/r2/platform/limits/> | Jun 8, 2026 |
| R2 · Get started | <https://developers.cloudflare.com/r2/get-started/> | Apr 21, 2026 |
| Billing · Billing policy（preauthorization / R2） | <https://developers.cloudflare.com/billing/understand/billing-policy/> | May 29, 2026 |
| Billing · Create billing profile | <https://developers.cloudflare.com/billing/get-started/create-billing-profile/> | May 29, 2026 |
| Cloudflare 产品页 · R2 落地页（"input your payment details"） | <https://www.cloudflare.com/pg-lp/r2> | — （不显示） |
| Cloudflare 产品页 · R2 | <https://www.cloudflare.com/products/r2/> | — （不显示） |
| workers-sdk 源码 · `packages/wrangler/src/d1/export.ts` | <https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/export.ts> | `main` 分支，采集于 2026-09-17 |
| workers-sdk 源码 · `packages/wrangler/src/d1/execute.ts` | <https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/execute.ts> | `main` 分支，采集于 2026-09-17 |
| workers-sdk 测试 · `packages/wrangler/src/__tests__/d1/export.test.ts` | <https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/d1/export.test.ts> | `main` 分支，采集于 2026-09-17 |

---

*本文件为可审计事实清单：所有 [官方明确] 结论均附 `developers.cloudflare.com` / Cloudflare API 参考 / `github.com/cloudflare/workers-sdk` / `cloudflare.com` 官方页来源 URL 与文档 Last updated 日期，采集日期均为 **2026-09-17**。[官方间接] / [未找到一手来源] / [未证实] 已逐条单独标注，请勿当作官方承诺；§8 的冲突项已保留双方，不做单方面删改。*
