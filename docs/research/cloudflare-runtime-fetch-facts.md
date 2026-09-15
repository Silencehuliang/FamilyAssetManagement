# 家庭财务系统 · Cloudflare 运行时抓取相关 — 一手事实清单

> 研究性质：联网检索 **developers.cloudflare.com 官方文档 + Changelog** 等一手来源，逐条核对。
> 检索口径日期：**2026-09-15**。每条结论附「来源 URL + 文档 Last updated 日期 / Changelog 条目日期」。
> 标注规则（沿用 `cloudflare-cron-and-timezone-facts.md`）：
> - **[官方明确]** = 官方文档/Changelog 原文写明；
> - **[官方间接]** = 官方文档可逻辑推导；
> - **[社区经验]** = 社区/博客（含 Cloudflare 官方博客），非文档一手来源，仅供参考、已降级标注；
> - **[未找到权威来源]** = 官方文档未给出明确数字/说法。
>
> 适用范围说明：本项目为「Pages（前端 + Pages Functions）+ 独立 Cron Worker + D1」双部署单元。本清单核实的是**独立 Cron Worker 运行时**（scheduled() 定时任务）在抓取行情、写 D1 时涉及的运行时事实。Pages Functions 与 Cron Worker 共用同一 **Workers 运行时**，故 `TextDecoder`/`fetch`/`AbortSignal` 等运行时 API 语义二者一致；但**限额指标**（子请求、CPU、请求数）以 Workers 官方 Limits 为准，Pages Functions 属独立产品、不在本清单逐项核实范围内（仅在相关处点出差异）。

---

## 0. 结论速览（先给判断）

| # | 问题 | 结论 | 标注 |
|---|---|---|---|
| 1 | Workers `TextDecoder` 是否支持 GBK/GB18030/GB2312 | **支持**（WHATWG Encoding Standard 全量编码，含 gbk/gb18030；CJK decoder 自 2026-03-03 默认开）。`new TextDecoder("gbk")` 可用 | [官方明确] |
| 2 | `fetch()` 默认超时 / 能否自管超时降级 | **无默认超时**；`AbortController` + `AbortSignal.timeout()` 官方支持（2021 起），可 `signal: AbortSignal.timeout(ms)` 实现超时即降级 | [官方明确] |
| 3 | 子请求上限是否适用于 Cron 的 scheduled() | **适用**。`Subrequests per invocation` = 50（Free，外部）/ 内部服务（D1/KV/R2）= 1,000；按 invocation 计，cron 同口径，无单独放宽 | [官方明确] |
| 4 | D1 `batch()` 单次最多几条语句 / 参数上限 / 语句长度 | 单条语句：绑定参数 ≤ 100、语句长度 ≤ 100 KB；**batch 内"最大语句条数"官方未给显式数字** | [官方明确]（单条限制）+ [未找到权威来源]（批量条数上限） |
| 5 | 同一 host 并发连接数限制 | **每 invocation 同时等待响应头的连接最多 6 个**（响应头到达后不再计入） | [官方明确] |
| 6 | `ctx.waitUntil()` 在 cron 内的时限 | 受 **Cron 墙钟 15 分钟**约束；`waitUntil` 本身对 HTTP 仅延长 30 秒，cron 无"响应/断连"概念，直接受 15 min 上限 | [官方明确] |
| 7 | D1 写入配额 / batch 是否按单条语句计数 | 日配额按**行**计：Free **10 万行/天**；batch 内 20 条 INSERT 按实际写入行数（如 20 行）计，非按"次/批"计；D1 调用计入"内部服务子请求"（1,000/invocation） | [官方明确]（行计日配额）+ [未找到权威来源]（batch 的 subrequest 精确计数） |
| 8 | 出站 `fetch` 是否被 Cloudflare WAF/Bot 管理拦截 | **未找到权威来源**；WAF/Bot Management 为「入站到 zone」能力，官方文档未声明会过滤 Workers 出站请求 | [未找到权威来源] |

---

## 1. （最关键）Workers `TextDecoder` 对 GBK / GB18030 / GB2312 的支持

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/changelog/>（2022-02-25 条目）；<https://developers.cloudflare.com/workers/configuration/compatibility-flags/>（`text_decoder_cjk_decoder`，Default as of **2026-03-03**）

- Changelog 2022-02-25 原文：
  > "The TextDecoder class now supports the full range of text encodings defined by the **WHATWG Encoding Standard**."
- WHATWG Encoding Standard 的规范编码集合包含 `gbk`、`gb18030`、`gb2312`（其中 `gb2312` 在标准中作为 GBK 的别名映射）。因此 `new TextDecoder("gbk")` / `new TextDecoder("gb18030")` 在 Workers 运行时可用。
- 兼容性标志 `text_decoder_cjk_decoder`（专用于 CJK 解码）：
  > "When `text_decoder_cjk_decoder` is enabled, a dedicated CJK `TextDecoder` implementation is used for **CJK encoding overrides and Big5 lead-byte handling**, instead of the legacy ICU-only code path. This improves spec compliance for CJK text decoding."
  - **Default as of 2026-03-03** —— 即 2026-03-03 之后创建的 Worker（compat date ≥ 该日）默认开启，无需手动加 flag。它能进一步提升 GBK/GB 系等 CJK 解码的规范符合度（尤其 Big5 前导字节处理）。
- **文档口径不一致（需提示）**：`https://developers.cloudflare.com/workers/runtime-apis/encoding/`（Last updated **Apr 23, 2026**）仍把 `TextDecoder` 描述为 "The `TextDecoder` interface represents a **UTF-8 decoder**." 此为文档页的简化/遗留措辞，与 Changelog 的「全量 WHATWG 编码」及 2026-03-03 的 CJK decoder 默认开启事实矛盾。**以 Changelog + 兼容性标志页为准**：运行时实际支持 GBK 全量解码。
- **Pages Functions 一致性 [官方间接]**：Pages Functions 基于同一 Workers 运行时，TextDecoder 行为一致；在 Pages Functions 内同样可用 `new TextDecoder("gbk")`。

**[社区经验 / 降级]** 来源：<https://blog.cloudflare.com/standards-compliant-workers-api>（Cloudflare 官方博客，非文档）。该博客以示例展示 `new TextDecoder("windows-1251")` 等多编码解码，佐证「全量编码」能力；属一手公司的博客而非文档，仅作旁证、不单独作为承诺。

**对主源/备源选型的影响（仅事实）**：腾讯（`qt.gtimg.cn`，GBK）、新浪（`hq.sinajs.cn`，GBK）返回的文本，可用 `new TextDecoder("gbk").decode(bytes)` 解码；东财回填源为 UTF-8 JSON，直接 `response.json()`。无需为 GBK 另起转换服务。**前提**：Cron Worker 的 `compatibility_date` ≥ 2026-03-03（或显式加 `text_decoder_cjk_decoder` flag）以获得最佳 CJK 解码；任意 `compatibility_date` ≥ 2022-02-25 即具备基础 GBK 解码能力。

---

## 2. Workers `fetch()` 超时行为 / 自管超时降级

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）；<https://developers.cloudflare.com/workers/platform/changelog/>（2021-09-24、2021-12-10 条目）

- Limits 页「Subrequests」一节原文：
  > "**There is no set time limit on individual subrequests.** As long as the client remains connected, the Worker can continue making subrequests."
  - 即 `fetch()` 对单个子请求**没有默认连接/响应超时**；若源站挂起，Worker 会一直等到自身墙钟上限（cron 为 15 分钟）或被显式中止。
- Changelog 2021-09-24："`The AbortController and AbortSignal objects are now available.`"
- Changelog 2021-12-10："`AbortSignal.timeout(delay) returns an AbortSignal that will be triggered after the given number of milliseconds.`"
- 因此「超时即降级」的官方支持方式：
  ```js
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }); // 5s 超时
  } catch (e) {
    if (e.name === "AbortError") { /* 降级到备源/回填源 */ }
  }
  ```
  `AbortController` 与 `AbortSignal.timeout()` 均在 Workers 运行时可用，无需兼容 flag。
- 兼容性标志 `request_signal_passthrough`（见 compatibility-flags 页）仅控制「入站请求的 AbortSignal 是否透传到子请求」，与本任务「主动给 fetch 设超时信号」无关。

**[官方间接]** 因官方明确「无默认超时」且 `AbortSignal.timeout()` 可用，超时降级必须由业务代码自行实现——平台不提供「fetch 失败自动切换源」机制。

---

## 3. 子请求（subrequest）上限是否适用于 Cron 的 scheduled()

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

- Limits「Account plan limits」表：
  | Feature | Workers Free | Workers Paid |
  |---|---|---|
  | Subrequests | **50/request** | 10,000/request |
  | Subrequests to internal services | **1,000** | Matches configured limit (default 10,000) |
- 「Subrequests」小节原文：
  > "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1."
  > "**Subrequests per invocation** 50 / 10,000 ... Each subrequest in a redirect chain counts against this limit."
- **关键口径：限额按「per invocation」计，而非「per HTTP request」**。Cron 的 `scheduled()` 是一次 invocation，与普通 `fetch()` handler 同属 invocation，故同样受 50（Free）外部子请求约束；官方 Limits 页**无任何针对 Cron / Queue consumer 单独放宽子请求上限的行**。
- **外部 vs 内部服务分离**：外部 `fetch()`（腾讯/新浪/东财等公网源）计入 **50/invocation**；对 D1/KV/R2 的调用计入 **「internal services」1,000/invocation**。即 D1 写入走的是 1,000 的内部服务预算，不是 50 的外部预算。
- 关于「有资料称 Cron / Queue consumer 子请求上限与普通 fetch handler 不同」：**在本清单核实的官方 Limits 文档（2026-09-15 口径）中未找到该说法的支撑**；当前官方口径为「per invocation 统一 50（外部）/ 1,000（内部）」，对所有 invocation 类型一致。[未找到权威来源] 支撑「Cron 子请求上限不同」的传闻。
- 可在 `wrangler.toml` 用 `limits` 配置调高单 Worker 子请求上限（Paid）；Free 固定 50。

**[官方间接]** 重定向链中每一跳均计入子请求；若某行情源发生 3xx 跳转，实际消耗 > 1 次。

---

## 4. D1 `batch()` / 预处理语句的限额

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/limits/>（Last updated **Apr 21, 2026**）；<https://developers.cloudflare.com/d1/worker-api/d1-database/>（batch 语义）

- D1 Limits 表（单条查询维度）：
  | 项 | 限额 |
  |---|---|
  | Maximum bound parameters per query | **100** |
  | Maximum SQL statement length | **100,000 bytes (100 KB)** |
  | Maximum columns per table | 100 |
  | Maximum string/BLOB/row size | 2,000,000 bytes (2 MB) |
  | Maximum SQL query duration | 30 seconds |
- 「Batch limits」原文：
  > "Limits for individual queries (listed above) apply to each individual statement contained within a batch statement. For example, the maximum SQL statement length of 100 KB applies to **each statement inside the `db.batch()`**."
  - 即 `batch()` 内**每条**语句各自受「100 KB 语句长度 / 100 绑定参数」约束。
- `d1-database` 页关于 `batch()`：batched statements 作为 SQL 事务**顺序、原子**执行；任一条失败则整体回滚（返回该语句错误）。返回数组与传入语句顺序一一对应。
- **「一次 batch() 最多能放多少条语句」官方未给显式数字** → **[未找到权威来源]**。官方仅以「单条语句限制」约束 batch 内每条，未列 batch 的硬上限条数。社区第三方驱动（如 Laravel D1 driver）称「D1 batch 上限 100 条语句」并自动分块，但属[社区经验]，非官方文档，本清单不作承诺。

**[官方间接]** 结合 Q3：D1 调用计入「internal services」子请求（1,000/invocation，Free）；若 batch 内每条语句单独计一次 subrequest，则单 batch 写入 20–50 条仍远低于 1,000。但「batch() 整体算 1 次还是 N 次 subrequest」官方未明确（见 Q7）。

---

## 5. 对同一 host 的并发连接数限制

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）「Simultaneous open connections」

- 原文：
  > "**Each Worker invocation can have up to six connections simultaneously waiting for response headers.**"
  > "The following API calls count toward this limit while the initial connection is being established and the server has not yet responded: `fetch()` method of the Fetch API ... Once response headers arrive for a connection, it no longer counts toward the six-connection limit. This means a Worker can have many connections open simultaneously, as long as no more than six are in the initial 'waiting for headers' phase at the same time. If a seventh connection is attempted while six are already waiting for headers, it is queued until one of the existing connections receives its response headers."
- 即**每 invocation 对同一（或任意）host 同时「等待响应头」的连接最多 6 个**；响应头到达后该连接不再占用名额，故实际可保持更多已建立连接。第 7 个并发会在前 6 个收到响应头前被排队。
- 注意：该 6 连接限制针对「等待响应头」阶段，与 Q3 的「子请求 50 次/invocation」是**两个不同维度**的约束（一个是并发度，一个是总次数）。

---

## 6. `ctx.waitUntil()` 在 Cron `scheduled()` handler 内的时限

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）「Duration」与「Wall time limits by invocation type」

- Duration 表：
  | Trigger type | Duration limit |
  |---|---|
  | HTTP request | No limit（客户端保持连接时） |
  | **Cron Trigger** | **15 min** |
  | Queue Consumer / Durable Object alarm | 15 min |
- 「Duration」小节原文：
  > "Use `ctx.waitUntil()` to perform work after returning a response. `waitUntil()` can extend execution for up to **30 seconds** after the response is sent or the client disconnects."
  - 该 30 秒延长是针对 **HTTP 触发**（有响应/断连概念）。
- **Cron 触发无「响应/断连」概念**：运行时直接等待 `scheduled()` 返回的 promise，整体受 **Cron 墙钟 15 分钟**约束。即 `waitUntil` 在 cron 内最远延伸到本次 invocation 的 15 分钟墙钟内，不另享 30 秒延长。
- 与 `cloudflare-cron-and-timezone-facts.md` 第 7.2 节结论一致（已交叉核实）。

---

## 7. D1 写入配额与 `batch()` 的计数口径

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/pricing/>（Last updated **Apr 21, 2026**）；<https://developers.cloudflare.com/d1/platform/limits/>（Last updated **Apr 21, 2026**）

### 7.1 日写入配额按「行」计，非按「次/批」计
- Pricing「Billing metrics」表：
  | | Workers Free | Workers Paid |
  |---|---|---|
  | Rows read | 5 million / day | 首 25 billion / 月 |
  | **Rows written** | **100,000 / day** | 首 50 million / 月 |
  | Storage | 5 GB (total) | 首 5 GB |
- Definitions #02 原文：
  > "Rows written measure how many rows were written to D1 database. Write operations include `INSERT`, `UPDATE`, and `DELETE`. ... **A query that `INSERT` 10 rows into a `users` table would count as 10 rows written.**"
- Definitions #08："Free limits reset daily at **00:00 UTC**."
- **结论（一手明确）**：日配额按**实际写入行数**计。一次 `batch()` 内含 20 条各插入 1 行的 `INSERT`，计 **20 行 written**（而非「20 次写操作」或「1 次批」）。本任务每日 20–50 只持仓股 ≈ 20–50 行/天，远低于 Free 10 万行/天。
  - 若改用单条多值 `INSERT INTO t VALUES (...),(...)`（1 语句插 N 行），同样按 N 行计；两种写法对日配额等价。
- 注意 Definitions #06：建有索引的列写入时，**每行额外产生 1 行索引写入**（表 1 行 + 索引 1 行），行数会翻倍计入。

### 7.2 `batch()` 是否按单条语句计入 subrequest —— 官方未明确
- D1 Limits 表：
  | 项 | 限额 |
  |---|---|
  | Queries per Worker invocation (read subrequest limits) | **50 (Free) / 1000 (Paid)** |
  | Subrequests to internal services | 1,000 |
- 该表把 D1 查询数与 subrequest 限额挂钩，并注明 D1 属「internal services」（1,000/invocation）。
- **但「一次 batch()（含 N 条语句）整体算 1 次还是 N 次 internal-service subrequest」官方文档未给出明确口径** → **[未找到权威来源]**。实践中 batch 为单次事务调用（1 次 D1 往返），但官方未白纸黑字写「batch = 1 subrequest」。本任务即便按「每条语句 1 subrequest」计（20–50 条），也远低于 1,000 的内部服务预算，不构成约束。

---

## 8. 出站 `fetch` 是否被 Cloudflare WAF / Bot Management 拦截

**[未找到权威来源]** 来源：已查 <https://developers.cloudflare.com/workers/platform/limits/>、<https://developers.cloudflare.com/workers/runtime-apis/fetch/>、<https://developers.cloudflare.com/workers/configuration/compatibility-flags/>，**均无**任何关于「Cloudflare 对自身 Worker 出站 fetch 请求施加 WAF / Bot Management 过滤/拦截」的官方声明。

- **逻辑说明（非官方承诺）**：Cloudflare WAF 与 Bot Management 是保护**入站到 Cloudflare zone** 流量的能力，作用在「请求抵达你的域名/zone」时；Worker 用 `fetch()` 主动访问公网第三方源（腾讯/新浪/东财）属于**出站 egress**，不在 WAF/Bot Management 的拦截路径上。官方文档未声明会过滤自身运行时出站流量。
- 实际可能遇到的阻碍**来自源站侧、非 Cloudflare**：
  - 新浪 `hq.sinajs.cn` 要求 `Referer: https://finance.sina.com.cn`（源站校验，需在代码里带 header）；
  - 部分源站可能对数据中心出口 IP 限流/封禁（源站策略，与 Cloudflare 无关）。
- **结论**：不要假设「Cloudflare 会拦出站请求」；也不要假设「Cloudflare 保证出站一定成功」。失败判定应在代码内以 HTTP 状态码 + 解码校验 + 超时降级实现，并落库心跳。

---

## 9. 对设计的影响（约束，非方案，≤5 条）

1. **GBK 主/备源可用，无需放弃或另起转换服务**：`new TextDecoder("gbk")` 在 Workers 运行时可用（WHATWG 全量编码，2022-02-25 起；CJK decoder 自 2026-03-03 默认开）。腾讯/新浪 GBK 文本可解码，东财 UTF-8 JSON 直接 `json()`；Cron Worker `compatibility_date` 设 ≥ 2026-03-03 即可获最佳 CJK 解码。Pages Functions 同运行时、同语义。
2. **`fetch` 无默认超时，超时降级必须自管**：用 `signal: AbortSignal.timeout(ms)`（官方支持，2021 起）包裹每次抓取；`catch` 到 `AbortError` 即降级到备源/回填源。平台不提供「自动换源」。
3. **子请求预算要合并抓取**：外部子请求 **50/invocation（Free）**，内部服务（D1）**1,000/invocation**；cron 同口径、无放宽。腾讯/新浪支持多代码合并 URL（`q=sh600519,sz000001`），**必须一次 fetch 拉全部持仓（1–3 个调用）**，禁止把 20–50 只股票拆成 20–50 次 fetch 逼近 50 上限。
4. **D1 写入按「行」计日配额，batch 一次写完当天持仓**：Free **10 万行/天**，20–50 行/天远低于上限；单 `batch()` 写全部持仓（<50 行）一次性完成，单条语句受 100 KB / 100 绑定参数约束。注意 D1 调用计入「内部服务子请求」，以及建索引会使写入行数翻倍。
5. **`waitUntil` 在 cron 受 15 分钟墙钟约束**：抓取+写入应在 `scheduled()` 主流程内同步完成并落库心跳；`waitUntil` 仅用于收尾/登记。官方无「Cron 失败」专用告警，静默失败须由代码自行捕获并落库/发 Webhook 才能被发现。

---

*本文件为可审计事实清单，所有 [官方明确]/[官方间接] 结论均附 developers.cloudflare.com（或 Changelog）来源 URL 与文档日期；[社区经验] 已降级标注，[未找到权威来源] 如实写明，请勿当作官方承诺。与 `cloudflare-cron-and-timezone-facts.md` 互为补充（本文件专攻运行时抓取/D1 写入事实）。*
