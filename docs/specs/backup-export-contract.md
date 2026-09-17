# 备份与导出实现契约

> **产出票**：«备份与导出策略»（GitHub Issue #15）
> **状态**：冻结 —— 本契约是备份 / 导出 / 回导的**唯一实现约定**。实现期发现本契约与迁移文件冲突时，**以迁移文件为准并回本票复议**。
> **上下游关系**：本票**消费** schema 与各子系统已冻结的口径；**不定义**任何表结构、字段语义或周期算法。凡涉及表结构的改动，须回 «D1 schema 与索引定稿» 复议。
> **配套实测**：`docs/verification/backup-export-probe.py`（sqlite3 / 104 断言）、`docs/verification/backup-export-cpu-probe.js`（Node-V8 / 34 断言）
> **事实来源**：`docs/research/cloudflare-d1-backup-restore-facts.md`、`docs/research/cloudflare-export-channel-facts.md`

---

## 1. 本票的边界

**做什么**：定死「怎么备份、怎么导出、要不要自动备份、能不能回导」四件事。

**不做什么**：不实现备份代码（本票是决策票，交付契约）；不改任何表结构；不做数据归档 / 冷存（已由 «持仓快照与历史收益表设计» 定为不裁剪不归档）。

**数据边界（前置已冻结）**：全新开始、不导入历史；提供 CSV / JSON 导出备份。

---

## 2. 决议摘要

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 导出格式与粒度 | **JSON = 权威备份**（保 `null`、保整数分、带元数据头）；**CSV = 单文件流水宽表**（便利报表，不承诺回导）。粒度**只做全量**，不做按时间段 / 标签切片 |
| Q2 | 导出入口 | **按表 + 按页游标分片**：`GET /api/export`，每请求一页（默认 2000 行），响应带 `next`；前端循环拼成一个文件。**不做流式** |
| Q3 | 自动备份 | **不做、不新增 cron**。三层覆盖：Time Travel（7 天内）/ 手动导出（长期）/ runbook（变更前） |
| Q4 | 回导与 schema 版本 | **站内不做导入**；回导 = 本地脚本读 JSON 生成 SQL → `wrangler d1 execute --file`。**schema 版本不需要加列 / 加表**（用 `d1_migrations` + `migrations/` 目录表达） |
| Q5 | 内容范围与隐私 | **13 表全导**（15 − `session` − `login_attempt`）；`quote_daily` / `corporate_action` 必须导；四条隐私约束 |

---

## 3. 备份的职责分层（本契约的核心结构）

**关键前提**：D1 **自带 Time Travel**，官方页面标题即 *"Time Travel and backups"*，原文认定它 *"is D1's approach to backups and point-in-time-recovery"*，并明确其存在价值是 *"By not having to rely on scheduled backups and/or manually initiated backups…"*。它**默认开启、无需配置、无额外费用**。

```
┌─ 第 1 层：7 天内的任意误操作 ────────────────────────────────────────┐
│  D1 Time Travel（官方机制，零成本）                                  │
│  · Free 回溯窗口 7 天 —— 7 天只写在 Limits 表与页末 Notes，           │
│    页面**首句只写 30 天**，只读首句会误判                             │
│  · 粒度「any minute」；恢复**原地覆盖**，但返回 previous_bookmark 可撤销 │
│  · 恢复速率上限 10 次 / 10 分钟 / 库                                 │
│  · 前置：wrangler ≥ 3.4.0；库须在 production 后端                    │
│  · 覆盖场景（官方列举）：失败迁移 / 大 schema 变更 / 无 WHERE 的      │
│    DELETE 或 UPDATE                                                  │
└──────────────────────────────────────────────────────────────────────┘
┌─ 第 2 层：长期留存（> 7 天）────────────────────────────────────────┐
│  手动导出，两条通道：                                                │
│  · 站内 JSON 导出 —— 手机可用，不依赖电脑（§5 / §6）                 │
│  · 本地 wrangler d1 export 的 SQL dump —— 更权威，含 schema 与官方回导通道 │
│    （§8）                                                            │
└──────────────────────────────────────────────────────────────────────┘
┌─ 第 3 层：变更前 ───────────────────────────────────────────────────┐
│  runbook 硬性规定：**每次 `migrations apply` 之前先导出一份**（§12）  │
│  依据：官方原文 "Creating a manual backup ... before making large    │
│  schema changes ... is a good practice to get into."                │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 为什么**不**做自动备份（被否选项逐条点名）

| 被否方案 | 否掉它的依据 |
|---|---|
| **Cron 定期导出 → R2** | 官方要求先走 **checkout 开通 R2 订阅**；Billing 文档把 R2 列为 usage-based subscription ⇒ 与「尽量零绑卡」冲突。**这是唯一技术上成立的自动化去向，但它要求先改前提。** |
| **Cron 定期导出 → KV** | KV 在 Workers Free 内、无需单独订阅，但：① 单值**硬上限 25 MiB**、写仅 **1,000/天**；② **备份与主库在同一个 Cloudflare 账户下 ⇒ 账户级事故一同覆灭，不构成异地备份**。 |
| **Cron 定期导出 → 邮箱** | 官方对 Free 能否主动发信**自相矛盾**（定价表 `Outbound emails = Not available` vs 三处正文「发往已验证 destination 地址在任何 plan 都免费」）。但更硬的一条是 *"You can only send from your routing domains."* —— 本项目**只有 `*.pages.dev`、没有自有域名** ⇒ Email Routing 无域可挂，**事实上不可用**。 |
| **Cron 定期导出 → 推 git 仓库** | ① 仓库是 **public**，而导出物含 `member_credential` 的 PHC 哈希（**等同密码哈希**）；② 需在 Worker 里存一枚**可写仓库的 PAT**（Contents API，rate limit 5,000/h），凭空多一处高权限凭据。 |
| **自己写定时导出到别处** | 上述四条已穷尽可去处；且**官方明确说 Time Travel 的设计目的就是「不必依赖定时备份」** ⇒ 为「最近 7 天」这个场景再造一套，是与官方机制重复。 |

> ⚠️ 若日后愿意绑卡，本节的结论可逆：届时把 R2 作为第 2 层的目的地即可，第 1 / 3 层不变。

### 3.2 一条容易误用的官方机制

`wrangler d1 backup` 系列（`list` / `create` / `download` / `restore`）属于 **D1 alpha 旧后端的快照备份**，官方 Release notes 已于 **2025-07-01** 明确下线：

> "D1 alpha database backups **can no longer be accessed or created** with `wrangler d1 backup`"

本项目 2026 年新建的库走 production 后端 ⇒ **该命令组不可用**。另有一处未结的口径：`wrangler d1` 命令参考页仍写 `migrations apply` 「a backup will be captured」，而 alpha 快照已下线，**该 backup 的确切载体官方未说明** ⇒ **不可依赖它**，故 runbook 要求自己先导出（§12）。

---

## 4. 导出内容范围：13 张表

**15 表 − `session` − `login_attempt` = 13 表。**

```
member              tag                 entry                entry_object
budget              budget_alert_state  report_delivery      cron_run
position_version    member_idle_cash    quote_daily          corporate_action
member_credential
```

| 表 | 纳入 | 判据 |
|---|---|---|
| `member` / `tag` / `entry` / `entry_object` | ✅ | 领域实体，不可由其他表重算 |
| `budget` / `budget_alert_state` | ✅ | 预算数值**不可由 id 重建**；提醒状态是**事件记录**（«预算模型» 定），漏了会在 Cron 漏跑时永久丢失档位 |
| `report_delivery` | ✅ | 推送幂等锚（`UNIQUE(report_type, period_key, channel)`）—— 丢了会**重复推送** |
| `cron_run` | ✅ | 心跳表；前端「上次成功运行」的唯一来源，且是行情缺口自愈的输入 |
| `position_version` | ✅ | 持仓版本序列，任意日期持仓由它推导，**无存量可重算** |
| `member_idle_cash` | ✅ | 成员级手填单值，无来源 |
| **`quote_daily`** | ✅ **必须** | 🔴 **它不是可重抓的缓存，而是唯一副本** —— 历史昨收三条取数通路实测**全部失效**（«行情抓取与落库架构»），丢了则历史收益曲线**永久不可复原** |
| **`corporate_action`** | ✅ **必须** | 除权事件与**人工确认状态**，状态不可重算 |
| `member_credential` | ✅ | 🔴 不备份则**恢复后没人能登录** —— 系统完全不开放注册，且无法从 `phc` 反推密码 |
| `session` | ❌ | 会话可重建（重新登录即可）；不备份还少一份敏感面 |
| `login_attempt` | ✅ 排除 | 纯运行态计数，过期即清 |

### 4.1 CSV 报表的列（**只此一张表**）

CSV **不是** 13 个文件，而是**单文件「流水宽表」** —— 13 个 CSV 在手机端要点 13 次下载，且逐表 CSV 不能承载 §5.2 指出的 NULL 语义。

| 列 | 来源 | 说明 |
|---|---|---|
| `entry_id` | `entry.id` | |
| `biz_date` | `entry.biz_date` | 东八区 `YYYY-MM-DD` |
| `occurred_at` | `entry.occurred_at` | UTC 整数秒（**原样**） |
| `occurred_at_cst` | 应用层由 `occurred_at + 8h` 格式化 | 便利列，**仅供人读** |
| `member_name` | JOIN `member.name` | |
| `category_path` | JOIN `tag` | `组名›叶名`；组可被打时只有 `组名` |
| `object_tags` | `entry_object` ⋈ `tag`，顿号连接 | 无对象时为空 |
| **`amount_cents`** | `entry.amount_cents` | 🔴 **权威整数分，原样、不转换** |
| `amount_yuan` | 由 `amount_cents` 精确除 100 | 便利列，**2 位小数**（分 → 元是**精确**变换，不丢口径） |
| `client_ref` | `entry.client_ref` | 幂等键；历史行为 `NULL`（设计使然，见 «PWA 与移动端离线策略»） |

> ⚠️ **本表没有「备注」列** —— `entry` 表就没有该列。本系统的 Entry 只承载「谁花的 / 花在哪 / 何时 / 多少钱」，不要凭直觉补一个字段。

---

## 5. 导出协议

### 5.1 端点

全部挂在 `/api/*` 下 ⇒ **走已有鉴权**（«鉴权与访问控制方案»），未认证 401 JSON。

```
GET /api/export/meta
    → 导出清单（一次）
GET /api/export?format=json&table=<t>&cursor=<k>&limit=<n>
    → 一页数据（多次，逐表逐页）
GET /api/export?format=csv&cursor=<k>&limit=<n>
    → 流水宽表的一页 CSV 文本（多次）
```

**`/api/export/meta` 响应**：

```json
{
  "format": "hujia-ledger-backup",
  "format_version": 1,
  "export_started_at": 1789000000,
  "page_size": 2000,
  "schema_migrations": ["0001_init.sql", "0002_auth.sql", "0003_offline.sql"],
  "tables": [
    { "name": "member", "rows": 2,   "max_rowid": 2 },
    { "name": "entry",  "rows": 1825, "max_rowid": 1825 }
  ]
}
```

- `schema_migrations` 读自 **D1 自带的 `d1_migrations` 表** —— 这就是本票对 schema 版本的表达方式（§9），**零 schema 变更**。
- `max_rowid` 是每表在 `export_started_at` 时刻的 `MAX(rowid)`，用作该次导出的**上界**（§5.3）。

**数据页响应**：

```json
{
  "table": "entry",
  "rows": [ { "rowid": 1, "id": 1, "member_id": 1, "...": "..." } ],
  "next": 2001,
  "done": false
}
```

### 5.2 游标：为什么必须是 rowid 而非 offset（探针实测）

- **按 `rowid` 升序 + `rowid > cursor` + `rowid <= max_rowid`**，`ORDER BY rowid ASC`。
- 采用 rowid 的**统一性**理由：15 张表里有 4 张是**复合主键**（`entry_object(entry_id,tag_id)`、`quote_daily(code,trade_date)`、`corporate_action(member_id,code,ex_date)`、`budget_alert_state(period_key,budget_id,tier)`），逐表定义复合游标属不必要的复杂度；而 **13 张表全部有 rowid**（无 `WITHOUT ROWID`），`INTEGER PRIMARY KEY` 表的 rowid 即其主键。

实测（`backup-export-cpu-probe.js` §D）：

| 场景 | 结果 |
|---|---|
| 按 rowid 升序游标 + 期间新增行 | **无重叠、无漏行**（间隙恒为 1） |
| **反例**：offset-only 分页 + 插队写入 | **重叠 100 行** ⇒ 必须锚在稳定排序键上 |

### 5.3 导出物**不是事务性快照**（如实标注，不试图消除）

即便用 rowid 游标：

- 跨页期间的 **UPDATE** 仍会漏（某行在第 1 页读出、第 3 页前被改，导出物保留的是旧值）。
- 跨页期间的 **DELETE + rowid 复用** 可能漏行。

⇒ 导出物元数据里**必须**带 `non_transactional: true`、`export_started_at` / `export_finished_at`、每表 `rows` 与 `max_rowid`，并在导出说明里写明此性质。**本契约不试图消除它** —— 消除它需要一条跨 N 个请求的一致性快照通道，而官方无此通道（D1 的 REST export 作业能给出快照，但它阻塞库且要账户级 Token，见 §8.3 的否决理由）。

> ⚠️ 对本系统（2 人自用、每日几十笔写）的**实际影响可忽略**：导出全程数秒，期间有写入的概率低且后果是「某一行的某个字段是几秒前的值」。**但不得因此不标注** —— 下游若拿它做审计就会踩到。

### 5.4 页大小（由 CPU 预算反推，**实测得出**）

Cloudflare Free 的 CPU 是 **10 ms/请求**，该预算还要先覆盖路由、鉴权会话查表、SQL 解析与结果集反序列化。

实测（`backup-export-cpu-probe.js` §A，本机 Node/V8，**非 workerd 计费口径**）：

| 行数 | `JSON.stringify` | 占 10 ms 预算 |
|---|---|---|
| 1,000 | 0.85 ms | 8.5% |
| **2,000（默认页）** | **2.46 ms** | **24.6%** |
| 5,000 | 3.95 ms | 39.5% |
| 10,000 | 6.99 ms | 69.9% |
| 30,000 | 26.86 ms | 268.6% |

⇒ **页大小默认 2,000 行、硬上限 4,000 行。**

**为什么不能「一次请求全量」**（外推，同一线性成本）：

| 第 N 年 | 全量行数 | 序列化 CPU | 占预算 |
|---|---|---|---|
| 1 | 5,725 | 4.00 ms | 40.0% |
| 2 | 11,450 | 8.00 ms | 80.0% |
| **3** | **17,175** | **12.00 ms** | **120.0% ← 越线** |

行数按 `entry` 1,825/年（每天 5 笔）+ `quote_daily` 3,900/年（20 只 × ~195 交易日）计，**两者都单调增长**，而 10 ms 是固定预算 ⇒ **分片是必需而非优化**。

> ⚠️ 15000 行实测在 **9.91 ~ 12.06 ms** 之间抖动 —— **恰好跨在 10 ms 上**。故本探针**不对该点断言**：在边界上做单点断言本身不可靠。这正是把页大小定在 2000 行（≈25% 预算）而**不是贴着上限定**的理由。

### 5.5 为什么不做流式（`ReadableStream`）

官方支持流式，但**流式只降内存、不降 CPU** —— 总 CPU 不变，§5.4 的账一分不减。而「流式期间不计 CPU」官方**无逐字明文**（只有 *"CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests ... does not count"* 与 *"A Worker that is still streaming a response body remains active."* 两句可拼）⇒ **拿一个未证实的假设换复杂度，不划算**。

同理否决「服务端经 REST API 生成 SQL 备份」：D1 REST API 的 `export` 端点确实存在（异步 + `signed_url`），且能给出快照，代价是 ① 服务端须持有一枚**有 D1 导出权限的账户级 Token**；② **导出期间库不可用**（官方原文 *"during which your D1 will be unavailable to serve queries"*）；③ 作业**不持续轮询会自动取消**。为 2 人家庭应用引入高权限凭据 + 全站阻塞，性价比为负。

---

## 6. 格式规范

### 6.1 JSON 备份（权威）

```json
{
  "format": "hujia-ledger-backup",
  "format_version": 1,
  "schema_migrations": ["0001_init.sql", "0002_auth.sql", "0003_offline.sql"],
  "export_started_at": 1789000000,
  "export_finished_at": 1789000011,
  "non_transactional": true,
  "page_size": 2000,
  "tables": {
    "member": [ { "rowid": 1, "id": 1, "name": "…", "sort_order": 0, "created_at": 1789000000 } ],
    "entry":  [ { "rowid": 1, "id": 1, "member_id": 1, "category_tag_id": 101,
                  "amount_cents": 3250, "occurred_at": 1788990000, "biz_date": "2026-09-15",
                  "created_at": 1788990000, "client_ref": null } ]
  },
  "row_counts": { "member": 2, "entry": 1825 }
}
```

**四条硬规则**：

1. **行对象 = 表的列名原样**，逐列直出，**不做重命名、不做单位换算、不做格式化**。单位由列名后缀表达：`_cents`（分）、`_micro`（微元/股）、`_ppm`（万分比）、`_at`（UTC 秒，`cron_run.scheduled_at` 例外为**毫秒**）。
2. **金额一律整数分**，不转元（«D1 schema 与索引定稿» 的派生要求）。`amount_yuan` 这类便利列**只出现在 CSV**，不进 JSON。
3. **`null` 就是 `null`**，不写成 `""`、不写成 `0`。特别是 `quote_daily.prev_close_cents`（回填白名单不过即置 NULL，schema 明确允许）与 `tag.archived_at` / `merged_into_id`。
4. **整数字面量，不加引号**（判据见 §6.3）。

### 6.2 CSV 报表（便利）

- **RFC 4180 合规**：CRLF 行终止；字段含 `,` / `"` / CR / LF 时整体用双引号包裹、内部 `"` 写成 `""`。实测正反例见 `backup-export-cpu-probe.js` §B。
- 首行是表头；分页拼接时**后续页不带表头**。
- **编码 UTF-8 无 BOM**（JSON 亦同）。RFC 8259 要求跨系统交换的 JSON **MUST be UTF-8** 且禁止 BOM。
- ⚠️ **CSV 不承诺可回导**，且**无法承载 NULL**（见下）。

### 6.3 为什么 JSON 用数字字面量而不是字符串（RFC 7493 的适用性判断）

RFC 7493 明文 RECOMMENDED 用 JSON 字符串承载 64 位整数，理由是接收方**不能假定**超过 `9007199254740991`（2⁵³−1）的整数会被精确处理。**本库不触发该建议** —— 实测（`backup-export-cpu-probe.js` §C）：

| 语义类 | 上界 | 依据 |
|---|---|---|
| 行号 / 外键 / `sort_order` | 2³¹ | 行数在 2 人家庭场景不可能触及 |
| UTC 秒 | 2³³ | ≈ 公元 2242 年 |
| UTC 毫秒（`cron_run.scheduled_at`） | 2⁴² | ≈ 公元 2109 年 |
| 耗时 ms | 2²⁰ | cron 墙钟上限 15 min = 900,000 ms |
| 金额分 / 微元 / 股数 | 2⁴⁰ | 2⁴⁰ 分 ≈ 1.1×10¹⁰ 元 |
| 万分比 | 2³⁰ | ≈ 107,374% |

**最大上界 2⁴²，距 2⁵³−1 有 2048 倍余量** ⇒ 数字字面量恒精确。
对照：V8 上 `JSON.parse("9007199254740993")` 得 `9007199254740992`（**失真**）—— **边界真实存在，只是不在本库的取值域内**。

> ⚠️ **本结论依赖「不引入外部 64 位 ID」这个前提**（如雪花 ID 可达 2⁶³）。日后若有任何表引入外部系统的 64 位标识，本判断**失效**，须回本票复议。（已记入 §15 已知局限。）

### 6.4 为什么 JSON 是权威、CSV 只是报表

| 维度 | JSON | CSV（RFC 4180） |
|---|---|---|
| NULL 表示 | 有 `null` 字面量 | 🔴 **规范完全未定义 NULL**；W3C 表格模型默认「空串 = null」⇒ **NULL 与空串不可区分** |
| 类型信息 | 有（object / array / number / string / `null`） | **无** |
| 往返能力 | 可回导（§8） | 不承诺 |

**实测**（两个探针均已断言）：`quote_daily.prev_close_cents` 为 `NULL` 与为空串 `""` 的两行，**产出完全相同的 CSV 字节**。本库确实存在该列（回填白名单不过即置 NULL）⇒ CSV 承载不了它的语义。

---

## 7. 前端落地：三条降级路径（iOS PWA 是主场景）

🔴 **这是本票最大的实测风险点。** 主用场景是 **iPhone 上的 PWA（standalone）**，而 `<a download>` 在该环境下的行为**不可靠**：

| WebKit bug | 现象 | 官方处置 |
|---|---|---|
| 209407 | 主屏应用里 `download` **静默失败**（iOS 14.3 前） | `RESOLVED FIXED` |
| **236943** | 下载后**卡在下载页、连侧滑返回都失效** | **`RESOLVED MOVED`** —— WebKit 判定「属 Apple 内部、非 WebKit 项目」 |
| **275288** | 装到主屏后**变成预览而非下载**，与 Safari 行为不同 | 关闭为「Apple 内部处理」，WebKit 侧**无法跟踪** |

另：`Content-Disposition: attachment` 在 iOS Safari 的可靠性 Apple / WebKit **无任何专门文档**（MDN 只写通用行为，并注明 Safari **不解码** filename 里的 percent escape）。`<a download>` 本身自 **iOS 13.0** 起支持（WebKit bug 167341）。

⇒ **契约要求三条路径按序降级**，且**必须实测签字**（记入上线前门禁）：

```
① navigator.share({ files: [file] })
   · iOS 上的**原生分享面板** —— 可「存储到文件」或「发给自己」
   · MDN 把 .csv / text/csv 列入 usually shareable
   · 前置：secure context + transient activation（必须在用户手势里调用）
   · 前置：navigator.canShare({files}) 返回 true，否则跳过本档

② <a download> + Blob URL
   · 桌面浏览器可靠路径
   · 用完必须 URL.revokeObjectURL()（MDN：blob URL 存活期间底层对象无法被 GC）

③ 兜底：展示页 + 「复制到剪贴板」
   · 前两档都失败时的最后手段；**不得省略**
   · 只适用于文本（JSON / CSV 都是文本 ⇒ 成立）
```

> ⚠️ 兜底 ③ 的必要性来自官方 bug 记录：bug 236943 的失效模式是**用户彻底卡住、只能强杀应用**。没有兜底就等于在 iOS 上赌运气。

---

## 8. 回导

### 8.1 决议：站内不做导入

回导路径 = **本地脚本读 JSON → 生成 SQL → 官方 `wrangler d1 execute --file`**。

**官方已规定三件事**（照做即可，无需自创）：

1. `PRAGMA defer_foreign_keys = true` —— 官方逐字：*"When importing data, you may need to temporarily disable foreign key constraints. To do so, call `PRAGMA defer_foreign_keys = true` before making changes that would violate foreign keys."*
2. **按正确表顺序导入** —— 官方逐字：*"ensure you are importing the tables in the right order. You cannot refer to a table that does not yet exist."*
3. **去掉事务包裹** —— 官方逐字：*"make sure you have removed `BEGIN TRANSACTION` and `COMMIT` from your dumped SQL statements."*（`wrangler d1 export` 的产物本身就不含事务包裹，§8.2）

**表依赖序**（由 `REFERENCES` 推出，共 14 处外键）：

```
member ─┬─ member_credential
        ├─ entry ── entry_object
        ├─ member_idle_cash
        ├─ position_version ──┐
        └─ corporate_action ──┘  (applied_version_id 是**软指针**，无硬外键)
tag ─┬─ tag (parent_id / merged_into_id 自引用)
     ├─ entry (category_tag_id) / entry_object (tag_id)
     └─ budget ── budget_alert_state
（无外键依赖：report_delivery / cron_run / quote_daily）
```

**实测已证明这条不是「可选项」而是必需品**（`backup-export-probe.py` §6）：

| 实验 | 结果 |
|---|---|
| 逆序 INSERT、不开 defer | **被外键拒绝** |
| 按依赖序 INSERT | 成功 |
| 开 defer + **同事务内**修复 | 逆序也成功 |
| defer 后 **COMMIT 时仍未修复** | **失败** |
| defer 写成独立一条语句、违规写在**下一条** | **失效**（defer 只作用于当前事务） |

### 8.2 为什么站内自建导入被否决

上表最后一行就是理由：**`PRAGMA defer_foreign_keys` 只作用于当前事务，而 D1 每个查询是隐式事务** ⇒ 自建多语句导入必须把全部语句挤进**一个 `batch()`**。而 **`batch()` 的语句数上限官方未给数字**（D1 Limits 页只有单条语句 100 KB / 100 个绑定参数）。把恢复能力押在一条无明文的上限上，是拿最不该出错的路径去承担不确定性。

此外还需自建：15 表的依赖序编排、部分失败的定位与续跑、幂等语义（导入到非空库怎么办）。**而它解决的问题已有官方通道。**

### 8.3 官方 SQL dump 通道（`wrangler d1 export`）

官方**唯一的导出通道是 `.sql`** —— **官方没有 CSV / JSON 导出**。

```powershell
# 全量（schema + data）
npx wrangler d1 export <DB> --remote --output=./exports/full.sql
# 只导 schema / 只导 data
npx wrangler d1 export <DB> --remote --no-data   --output=./exports/schema.sql
npx wrangler d1 export <DB> --remote --no-schema --output=./exports/data.sql
# 单表（--table 可重复）
npx wrangler d1 export <DB> --remote --table=quote_daily --output=./exports/quotes.sql
```

| 事实 | 值 |
|---|---|
| 格式 | **只有 `.sql`**（`--output` 必填；`--local` / `--remote` 互斥） |
| dump 形态 | 首行 `PRAGMA defer_foreign_keys=TRUE;`，随后 `CREATE TABLE …;` 与逐行 `INSERT INTO "t" ("c") VALUES(…);`，`\n` 分隔，**无 `BEGIN TRANSACTION` / `COMMIT`** |
| 阻塞 | 🔴 *"A running export will block other database requests."* |
| 导入上限 | **5 GiB**（`d1 execute --file`）；超了官方建议拆成多个文件 |
| 单条语句上限 | 100 KB（超了报 `Statement too long`，官方给的修法是把大 `INSERT` 拆小） |
| 是否吃 Worker 的 50 次查询额度 | **不吃** —— 走 REST API 而非 Worker invocation |
| 是否吃 D1 读行额度 | 官方 FAQ：*"any queries you run against your database … count as either reads or writes"* ⇒ **应计 rows read**（官方未逐字说 REST export 作业如何折算） |
| 凭据 | `--remote` 强制鉴权（`CLOUDFLARE_API_TOKEN` 或 `wrangler login`）；`--local` 不联网，走 `.wrangler/state` |

> ⚠️ **`wrangler d1 export` 的 `--remote` 形态与 `--local` 形态可能不同**（`--local` 走 Miniflare 的私有 PRAGMA 在客户端生成 dump；`--remote` 是服务端生成后下载，客户端不拼 SQL）⇒ **本契约里 dump 的形态描述来自官方仓库测试快照，适用边界是 `--local`**。`--remote` 的确切文本须**实测核对**（§13 门禁）。未证实项：**dump 是否含 `CREATE INDEX` / `CREATE TRIGGER`** —— 官方文档与源码均未说明。

---

## 9. schema 版本标注（对 «D1 schema 与索引定稿» 遗留开口的答复）

上游原话：

> 本 schema **没有 schema 版本号列**。若你的方案需要「备份文件里标注 schema 版本」，那会给所有表加一列或引入一张 `schema_meta` 表 —— 属结构变更，请在本票说清，由 #14 追加迁移。

### 答复：**不需要加列、也不需要 `schema_meta` 表。**

版本信息由**两处已存在的事实**表达：

1. **D1 自带的 `d1_migrations` 表** —— 官方逐字：*"Creating migrations will keep a record of applied migrations in the `d1_migrations` table found in your database."* 它记录已应用的迁移文件名 ⇒ **这就是精确的 schema 版本**。导出时读出，写进备份文件的 `schema_migrations` 字段。
2. **`migrations/` 目录** —— «D1 schema 与索引定稿» 已要求它进备份清单；«部署拓扑定稿» 已定「`migrations/` 留在仓库根、**只有 `cron-worker/` 声明 `migrations_dir: "../migrations"`** ⇒ 它是**唯一迁移入口**」。

**为什么这是对的而不是省事**：给 13 张表加列、或新增一张表，都会**凭空制造一次迁移**，而迁移会触发官方 `migrations apply` 的备份抓取 —— 为一件已由现有表表达的事，在**恢复路径**上多加一次结构变更风险。这与上游自己「未决缝明确不闭合 —— 过早锁死＝凭空制造一次迁移」的纪律同向。

> ⚠️ 一条**未证实的边界**（§13 门禁）：`d1_migrations` 若被回导进一个新库，`wrangler d1 migrations list` 会把它判为「已应用」还是「未应用」，**官方未说明**。这影响的是「回导后能否继续 `migrations apply`」，须实测。

---

## 10. 隐私与凭据约束

🔴 **四条硬约束，任何一条被违反都是事故。**

1. **导出物默认落 `exports/`**，该目录已在 `.gitignore`（与 `.secrets/` / `seeds/` 并列）。
2. **导出物含 `member_credential.phc` —— 它是单列 PHC 字符串，形如 `pbkdf2-sha256$20000$<salt_b64url>$<hash_b64url>`。** 它是**密码哈希**：
   - **绝不入库**（仓库 public）；
   - **不分享、不贴聊天、不发邮件**；
   - 导出说明与 UI 上必须有一句显著的告知。
   - 「不可分享」这一条**不是保守估计** —— `phc` 里的盐与迭代次数都是明文，拿到它等于拿到一份离线爆破的起点。
3. **导出物可能含全部家庭财务数据** ⇒ 与凭据同级的保管要求。
4. **`phc` 必须按文本原样往返**，不做任何解析或重排 —— 任何「格式化」都会让哈希验不回来（其内部的 `$` 在 CSV 里不构成威胁）。

**两条来自 «PWA 与移动端离线策略» 的告知义务**（必须出现在导出说明里）：

- **设备侧数据不在备份范围内**：IndexedDB 里的离线队列与本地模板**丢了不可恢复** —— 备份 / 导出**只覆盖服务端数据**，服务端根本看不到它们。
- **导出若用于「迁移到新设备」，未同步的队列项会丢失** ⇒ 导出说明须提示「**先同步再导出**」。

---

## 11. 上游派生要求落点（逐条核验）

本票共接收 **13 条**派生要求 / 硬输入，逐条落点如下。

| 来源 | # | 要求 | 落点 |
|---|---|---|---|
| **#14** | 1 | 备份必须「表级完整」；`quote_daily` 等不可由其他表重算 | **§4**（13 表逐表判据；`quote_daily` 标🔴） |
| | 2 | 导出格式必须能表达 NULL 与整数分，**不得在导出时转成元** | **§6.1 规则 2/3**（JSON 数字分原样、`null` 即 `null`）；CSV 的 `amount_yuan` 是**额外便利列**，`amount_cents` 权威列同在 ⇒ 不违 |
| | 3 | 备份清单里应包含 `migrations/` 目录 | **§9**（版本表达 + §12 runbook） |
| | 4 | 回导必须按依赖序，且 `PRAGMA defer_foreign_keys` 是必需品 | **§8.1**（14 处外键依赖序 + 探针 §6 五条实测） |
| | 5 | schema 版本号列未提供，若需要请回 #14 复议 | **§9 答复「不需要」** |
| **#9** | 6 | 表清单由 12 变 15 | **§4**（15 − 2 = 13） |
| | 7 | `member_credential` 必须纳入且**敏感** | **§4** + **§10.2** |
| | 8 | `session` / `login_attempt` 不必纳入 | **§4**（排除清单 + 判据） |
| | 9 | `phc` 按文本原样往返，不做解析或重排 | **§10.4** |
| **#10** | 10 | 本地队列与本地模板不在备份范围内，须在导出说明写明 | **§10**（告知义务 1） |
| | 11 | 导出用于迁移新设备时未同步队列会丢，须提示先同步再导出 | **§10**（告知义务 2） |
| | 12 | `entry.client_ref` 只是幂等键，不构成备份必需项；历史行为 NULL | **§4.1**（CSV 含该列但注明可缺）+ **§6.1**（NULL 直出） |
| **#12** | 13 | `migrations/` 路径即唯一迁移入口，回导时须一并恢复 | **§9** + **§12** |

> 计数口径：**#14 五条 + #9 四条 + #10 三条 + #12 一条 = 13 条**。（#9 的「表清单 12→15」与其两条逐表取舍是同源输入的三个面，此处按三条计。）

---

## 12. 运维 runbook

```powershell
# ── 前置：确认库在 production 后端（Time Travel 可用）──────────────
npx wrangler d1 info <DB>              # 期望 version: production

# ── 每次 migrations apply 之前（硬性）──────────────────────────────
npx wrangler d1 time-travel info <DB>  # 记下当前 bookmark，留后路
npx wrangler d1 export <DB> --remote --output=./exports/pre-migrate-<日期>.sql

# ── 长期留存（本地通道，比站内导出更权威：含 schema）────────────────
npx wrangler d1 export <DB> --remote --output=./exports/full-<日期>.sql

# ── 误操作恢复（7 天内）────────────────────────────────────────────
npx wrangler d1 time-travel info <DB>                     # 查 bookmark
npx wrangler d1 time-travel restore <DB> --timestamp=<unix 秒>
# 输出会给出 previous_bookmark ⇒ 恢复错了可以撤销

# ── 回导（灾难恢复）────────────────────────────────────────────────
# 1) 本地脚本把站内导出的 JSON 转成 SQL（含 PRAGMA defer_foreign_keys=TRUE; 与依赖序）
# 2) 在**新建的测试库**上先验一次，绝不在生产库上首跑
npx wrangler d1 create <DB>-restore-test
npx wrangler d1 execute <DB>-restore-test --remote --file=./exports/restore.sql
npx wrangler d1 execute <DB>-restore-test --remote --command "PRAGMA foreign_key_check;"
npx wrangler d1 execute <DB>-restore-test --remote --command "PRAGMA quick_check;"
npx wrangler d1 execute <DB>-restore-test --remote --json --file=./exports/restore.sql
#    ↑ 读 meta.rows_written，核对是否在日额度内（§15 已知局限）
```

**恢复后必查三件事**（官方 Compatible PRAGMA，可直接用于核验）：

```
PRAGMA foreign_key_check;     -- 外键违规 0 行
PRAGMA quick_check;           -- 结构完整性 ok
PRAGMA index_list('entry');   -- entry 上 4 个（3 个 B-tree + client_ref 唯一）；全库 12 个须逐表核
```

---

## 13. 上线前门禁（本票新增 4 项）

| # | 门禁 | 判据 | 为什么是本票引入的 |
|---|---|---|---|
| G1 | **iPhone PWA 下载实测** | 真机、**装到主屏后**执行 §7 的三条路径，逐条记录实际行为 | WebKit 三个 bug 均判为「Apple 内部」，**无规范可依** |
| G2 | **导出页大小的 workerd 实测** | 生产环境导 2,000 行，确认无 Error 1102 | §5.4 的数字来自本机 Node，**非 workerd 计费口径** |
| G3 | **`wrangler d1 export --remote` 的 dump 形态核对** | 导出后 `grep -cE "^CREATE (INDEX\|TRIGGER)"`，与 12 个显式索引核对 | 官方无 dump 样例；形态证据来自 `--local` 路径 |
| G4 | **回导到测试库后 `migrations list` 的行为** | 核对 `d1_migrations` 被回导后是否被判定为已应用 | 官方未说明（§9 的未证实边界） |

---

## 14. 禁用清单

| # | 禁用 | 依据 |
|---|---|---|
| 1 | **不把导出物提交进 git** | 仓库 public；含 `member_credential.phc`（= 密码哈希） |
| 2 | **不在导出时把整数分转成元** | «D1 schema 与索引定稿»；转了就丢口径 |
| 3 | **不把 JSON 的 `null` 写成 `""` 或 `0`** | `quote_daily.prev_close_cents` 的 NULL 有语义（回填校验不过） |
| 4 | **不给 schema 加版本列 / 不加 `schema_meta` 表** | §9；凭空制造一次迁移 |
| 5 | **不用 offset-only 分页** | 实测：插队写入会造成重叠 / 漏读（探针 §D.3） |
| 6 | **不在导出响应里做流式** | §5.5；只降内存不降 CPU，且换一个未证实假设 |
| 7 | **不在服务端存账户级 D1 API Token 做导出** | §5.5；高权限凭据 + 阻塞库 + 需持续轮询 |
| 8 | **不依赖 `wrangler d1 backup` 系列** | 官方 2025-07-01 已下线（alpha 旧后端） |
| 9 | **不依赖 `d1 migrations apply` 的「自动备份」** | 官方措辞的载体未说明（§3.2） |
| 10 | **不把 `PRAGMA defer_foreign_keys` 写成独立一条语句** | 实测失效：它只作用于当前事务（探针 §6.5） |
| 11 | **不在 import 的 SQL 里保留 `BEGIN TRANSACTION` / `COMMIT`** | 官方 Troubleshooting 逐字要求移除 |
| 12 | **不省略「复制到剪贴板」兜底** | WebKit bug 236943 的失效模式是用户彻底卡住（§7） |
| 13 | **不把 `member_credential` 排除出导出** | #9：不备份则恢复后没人能登录 |
| 14 | **不把 `quote_daily` 当作「可重抓的缓存」** | #13：历史昨收三条通路实测全部失效，它是唯一副本 |

---

## 15. 已知局限

1. **CPU 数字来自本机 Node/V8，不是 workerd 计费口径。** 二者同引擎但计时方式不同 ⇒ 页大小 2,000 是**设计参数**，须由门禁 G2 在生产环境确认。**本契约不断言「一定不超 10 ms」。**
2. **导出物不是事务性快照**（§5.3）。跨页期间的 UPDATE 会漏、DELETE + rowid 复用可能漏行。已通过元数据如实标注，但**未消除**。
3. **`wrangler d1 export --remote` 的 dump 确切形态未证实** —— 官方无样例，形态证据来自 `--local` 路径。dump **是否含 `CREATE INDEX` / `CREATE TRIGGER` 官方未说明**，须由门禁 G3 核对。
4. **单次全量回导在第 8 年将超过 Free 的 10 万写行/日**（探针 §7 外推：第 5 年 65,125 行、第 7 年 91,175 行、**第 8 年 104,200 行**）⇒ 届时应**按表分批、跨日执行**。这是容量边界而非当前问题，但须先记下。
   - 口径：`entry` 每行命中 **4** 个**显式**索引（`+4`：`ix_entry_cat_date` / `ix_entry_member_date` / `ix_entry_biz_date` / `ux_entry_client_ref` —— 最后一个由 «PWA 与移动端离线策略» 的非空触发器保证必命中），`quote_daily` 无显式二级索引。行数按「每天 5 笔 / 20 只 × 195 交易日」推。
   - ⚠️ **这个数字是下界，不是上界**：SQLite 还为 UNIQUE 表约束与复合主键自动建立 **10 个** `sqlite_autoindex_*`（探针 §7.1c 实测），它们同样要维护、同样计入 D1 的索引写行。**真实值更高 ⇒ 须跨日分批的时刻只会更早。**
   - ⚠️ **是估算，非实测。**
5. **「JSON 数字字面量安全」依赖「不引入外部 64 位 ID」这个前提**（§6.3）。若有任何表引入外部系统的 64 位标识，该判断失效。
6. **只有手机、没有电脑时无法自行完成回导**（回导走本地脚本 + wrangler）。本项目 owner 本就有本地工具链，故接受此取舍；但它是一条**真实的单点**。
7. **7 天是 Time Travel 的硬窗口。** 超过 7 天的错误操作**无法**用官方机制回滚，只能靠第 2 层的手动导出 —— 而第 2 层是手动的，**它能否生效取决于是否真的做了**。这是本方案最脆弱的一环，由 runbook 而非代码保证。
8. **`d1_migrations` 回导后的行为未证实**（§9；门禁 G4）。
9. **本契约未做 iOS 真机验证**（门禁 G1 是上线前项，不是本票已完成项）。

---

## 16. 未决缝

- **第三方推送渠道的选型** 与备份无关（«时间口径与汇报生成机制» 已定「尽力而为、不重试」）—— 不在本票范围。
- **导出物的大小告警阈值**：本契约给了页大小，但没给「一次导出总量多大算异常」的判据。数据量极小，暂不需要；若日后需要，回本票复议。
- **`d1_migrations` 之外的 schema 演进痕迹**（如手工执行的 DDL）：系统约定「迁移是唯一入口」，故不表达。若违反该约定，备份文件无法察觉 —— 属**流程性未决缝**。
- **CSV 的分页分片对用户是否可见**：本契约只规定协议，未规定 UI 是否显示进度。留实现期。
- **导出是否计入审计 / 操作日志**：本系统无操作审计（已出范围），故不做。
