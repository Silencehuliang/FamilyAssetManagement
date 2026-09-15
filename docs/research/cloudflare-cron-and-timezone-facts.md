# 家庭财务系统 · Cloudflare Cron 与 SQLite/D1 时区 — 一手事实清单

> 研究性质：联网检索 **developers.cloudflare.com 官方文档** + **sqlite.org 官方文档**，逐条核对一手来源。
> 检索口径日期：**2026-09-15**。每条结论附「来源 URL + 文档 Last updated 日期」。
> 标注规则（沿用 `cloudflare-free-tier-constraints.md`）：
> - **[官方明确]** = 官方文档原文写明；
> - **[官方间接]** = 官方文档可逻辑推导（如 D1 用 SQLite 引擎、边缘运行时本地时区为 UTC）；
> - **[社区经验]** = 社区/博客，非官方权威来源，仅供参考；
> - **[未找到权威来源]** = 官方文档未给出明确数字/说法。
>
> 适用范围说明：本项目为「Pages（前端 + Pages Functions）+ 独立 Cron Worker + D1」双部署单元，共享同一 D1 `database_id`（已在前文核实）。本文件只核实 Cron 编排与时区相关的一手事实，不含设计方案。

---

## 0. 结论速览（先给判断）

| # | 问题 | 结论 |
|---|---|---|
| 1 | Cron 配额是每 Worker 还是每账户 | **每账户**：Free 5 个 / Paid 250 个 |
| 2 | 失败是否自动重试 | **官方未写明「自动重试」**；仅见 `controller.noRetry()`（可抑制重试）存在于官方文档 → 平台侧**存在**重试抑制机制，但**次数/退避/是否必重试均未文档化** |
| 3 | 失败可观测性 | Dashboard **Cron Events 存最近 100 条**；Workers Logs 更长留存；`wrangler tail` 覆盖 cron 属**间接**；专用失败告警 **官方未明确** |
| 4 | scheduled 事件对象 | `cron` / `type`(恒 "scheduled") / `scheduledTime`(ms,UTC)；多 cron 用 `switch(controller.cron)` 分派 |
| 5 | cron 表达式 | Quartz 风格，支持 `1-5`/`*/n`/`L`/`W`/`#`；最小粒度 **1 分钟**；**时区恒为 UTC** |
| 6 | SQLite/D1 时区 | SQLite **不支持命名时区**；D1 运行于 **UTC**，`datetime('now','localtime')` ≈ UTC；可用 `'+8 hours'` 等偏移修饰符 |
| 7 | 延迟/补发 | Queues 免费可用（每账户 10,000 队列、消息 128KB、重试 100 次、保留 24h、`delaySeconds` 上限 24h）；`ctx.waitUntil()` 在 cron 内受 **15 分钟墙钟**约束 |
| 8 | 同 Worker 多 cron 并发 | **官方未说明** 并发/串行语义 |

---

## 1. Cron 配额：每账户，而非每 Worker

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

官方 Limits 表「Account plan limits」原文：

| Feature | Workers Free | Workers Paid |
|---|---|---|
| Number of Cron Triggers **per account** | **5** | **250** |

- 限额是 **per account（每账户）**，不是 per Worker。一个账户下所有 Worker 的 Cron Trigger 加起来 ≤ 5（Free）。
- **一处口径不一致（已在两页原文中核对）**：Cron Triggers 配置页 Limits 一节写的是 "Refer to Limits to track the maximum number of Cron Triggers **per Worker**"（**指路句，措辞按 Worker**），而 Limits 页 Account plan limits 表的实际行名是 "Number of Cron Triggers **per account** 5 / 250"。**以 Limits 页的表为准 = 每账户 5 个**；两页都指向同一张表，Cron Triggers 页的 "per Worker" 属措辞松散。
- 结论印证前文 `cloudflare-free-tier-constraints.md` 第 2.2 节的「每账户 5 个」说法。
- **Cron CPU（同页 CPU time 表，一手原文）**：Free **10 ms / Cron Trigger**；Paid **30 秒（触发间隔 < 1 小时）/ 15 分钟（间隔 ≥ 1 小时）**。（HTTP 请求：Free 10 ms / Paid 5 分钟。）注意 **SQL 查询属 I/O 等待，不计入 CPU**；吃 CPU 的是 JS 循环、`JSON.parse`/序列化、正则、crypto。
- 细微约束：每次 Cron 触发计 1 次请求，计入 Free 每日 100,000 请求额度；Cron 触发本身不单独收费，但消耗 Workers 请求额度与 CPU。
- 对「周报/月报」场景：3 个以内的 Cron（或 1 个每日 Cron 内部按日期分派）远低于 5 个上限。

---

## 2. 失败语义：官方未写明重试；仅存在「抑制重试」的 API

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated **Sep 4, 2026**）；<https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>（页面未显示精确日期，属 Workers runtime-apis 体系）

> **本节的修正说明（2026-09-15，经原文复核）**：先前草稿曾写「失败默认重试（以 `noRetry()` 的存在为证）」，并把社区「不重试」说法判为旧结论。复核两个官方页面后，**更准确的表述是**：官方**从未在一手文档中写明 Cron 失败会被重试，也未给出次数或退避**。唯一的一手线索是 `noRetry()` 本身。以下按一手原文陈述。

- 官方 Cron Triggers 页在「Test Cron Triggers locally」一节给出本地测试返回结构：
  ```json
  { "outcome": "ok", "noRetry": false }
  ```
  并原文说明：「The `noRetry` field is `true` when the scheduled handler calls `controller.noRetry()`.」
- 由上可推出两件事（**[官方间接]**，非官方承诺）：
  1. 运行时里**存在** `controller.noRetry()` 这一入口，语义是「抑制重试」；
  2. 一个方法被命名为 `noRetry` 且默认值为 `false`，**逻辑上暗示平台侧默认存在重试行为**——否则无需提供「选择不重试」的开关。
- **[未找到权威来源]** 以下三点在官方文档中**均无明确表述**：
  - Cron 调用失败（抛异常 / 超时 / CPU 超限）后**是否一定被重试**；
  - **重试次数**；
  - **重试退避间隔**。
- **Scheduled Handler 页的 Methods 一节只列了 `ctx.waitUntil()`**，未把 `noRetry()` 列入 Methods（`noRetry()` 只在 Cron Triggers 页的本地测试 JSON 说明中被提及）——即该 API 的**正式文档覆盖是不完整的**。
- **[社区经验 / 存疑]** 多个第三方博客声称「Cloudflare 不自动重试」。该说法无法从一手文档证实或证伪，本清单**不作判定**。
- **设计含义（本节唯一可靠的推论）**：既然「是否重试、重试几次」都不可依赖，`scheduled()` 的每个分支都**必须写成幂等**——以 `controller.scheduledTime`（同一次计划触发的 UTC 毫秒值，重试间不变）作为天然幂等键，落库记录「已处理到哪个 scheduledTime / 哪个周期键」，重跑时判重跳过。**不要**设计成「靠平台重试来保证最终成功」。


---

## 3. 失败可观测性

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated **Sep 4, 2026**）；<https://developers.cloudflare.com/workers/observability/>（Last updated **Aug 3, 2026**）

- **Dashboard Cron Events**：路径 Workers & Pages → 你的 Worker → Settings → Trigger Events → View events。「**Cron Events stores the 100 most recent invocations of the Cron scheduled event.**」即仅保留最近 100 条调用记录（成功/失败状态可见）。
- **Workers Logs**：「Workers Logs also records invocation logs for the Cron Trigger with a longer retention period and a filter & query interface.」即 Cron 的调用日志也被 Workers Logs 记录，留存更长、可过滤查询。Workers Logs 是 Dashboard 原生能力，Free 亦可访问（具体保留天数官方未在本页列出）。
- **`wrangler tail` / Real-time logs**：Observability 页列出 Real-time logs 与 Tail Workers 作为日志获取方式；Cron 调用属于 Worker invocation，Workers Logs 会记录其日志，故 `wrangler tail` 可覆盖 cron 日志。**[官方间接]** 因官方未单句写明「wrangler tail 覆盖 cron」，但「Cron = Worker invocation + Workers Logs 记录」逻辑可推导。
- **失败告警（邮件/Webhook）**：**[未找到权威来源]** 在已查官方文档中**未找到**专用于「Cron 触发失败」的官方邮件/Webhook 告警机制。Cloudflare 有通用 Notifications/Alerts，但本清单未在官方文档中核实到「Cron 失败」专用告警类型。可行做法（非官方承诺）：在 `scheduled()` 内捕获异常后自行向外部 Webhook/邮件发送告警，或用 Tail Worker 兜底。
- GraphQL Analytics API：官方指出可用 Cloudflare GraphQL Analytics API 以编程方式访问 Cron Events。

---

## 4. scheduled 事件对象与多 cron 分派

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>（2026，属 Workers runtime-apis 体系）

`scheduled(controller, env, ctx)` 中 `controller`（即 ScheduledEvent）的字段：

| 字段 | 类型 | 含义（官方定义） |
|---|---|---|
| `controller.cron` | string | The value of the Cron Trigger that started the `ScheduledEvent`（触发本次的 cron 表达式原文） |
| `controller.type` | string | The type of controller. This will always return `"scheduled"` |
| `controller.scheduledTime` | number | The time the `ScheduledEvent` was scheduled to be executed in milliseconds since January 1, 1970, **UTC**；可 `new Date(controller.scheduledTime)` 解析 |

- 注意：社区示例常写作 `scheduled(event, env, ctx)`，官方 ES modules 示例写作 `scheduled(controller, env, ctx)`；两者指同一对象（event/controller 同义）。
- **`env`**：绑定对象（D1/KV 等）；**`ctx`**：目前仅含 `waitUntil` 函数。

### 多 Cron 分派（官方推荐方式）

**[官方明确]** 同一 Worker 配多条 cron 时，每条都调用同一个 `scheduled()` handler。官方明确推荐用 `controller.cron` 区分：

```js
export default {
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case "*/5 * * * *":   await fetch("https://example.com/api/sync"); break;
      case "0 0 * * *":      await env.MY_KV.put("last-cleanup", new Date().toISOString()); break;
    }
  },
};
```

- 官方强调：`The value of controller.cron is the exact cron expression string from your configuration. It must match character-for-character, including spacing.`（需逐字符严格匹配，含空格）。
- `ctx.waitUntil(promise)`：「The first `ctx.waitUntil` to fail will be observed and recorded as the status in the Cron Trigger Past Events table. Otherwise, it will be reported as a success.」即可用 `waitUntil` 把某个异步任务的结果登记为本次 Cron 的成败状态。

---

## 5. cron 表达式：Quartz 风格、最小 1 分钟、恒 UTC

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated **Sep 4, 2026**）

- 官方原文：「Cloudflare supports cron expressions with **five fields**, along with most **Quartz scheduler**-like cron syntax extensions」。
- 字段与字符支持：

| 字段 | 取值 | 支持字符 |
|---|---|---|
| Minute | 0-59 | `* , - /` |
| Hours | 0-23 | `* , - /` |
| Days of Month | 1-31 | `* , - / L W` |
| Months | 1-12（或 JAN..DEC 缩写，大小写不敏感） | `* , - /` |
| Weekdays | 1-7（或 MON..SUN 缩写，大小写不敏感） | `* , - / L #` |

- **特殊字符可用**：`*` 任意、`/` 步长（`*/30`、`*/3`）、`,` 列表、`-` 范围、`L`（月末/月末星期几，如 `6L` 最后一个周五）、`W`（最近工作日）、`#`（第 N 个星期几，如 `MON#1`）。**即 `1-5`、`*/n`、`L`、`W`、`#` 均受支持**。
- **星期编号差异（重要）**：官方明确「Days of the week go from **1 = Sunday to 7 = Saturday**, which is different on some other cron systems (where 0 = Sunday and 6 = Saturday).」建议用三字母缩写（`MON`）避免歧义。
- **最小粒度 = 1 分钟**：`* * * * *` 为最频繁（每分钟一次）。官方示例与社区均确认**不支持亚分钟级**触发。
- **执行时区 = UTC（恒为 UTC）**：官方首句「**Cron Triggers execute on UTC time.**」无时区配置项；需用「本地时间对应的 UTC 表达式」表达（如北京时间 00:00 = UTC 前一天 16:00）。
- 官方示例：`0 17 * * sun` 或 `0 17 * * 1` = 周日 17:00 UTC；`0 18 * * 6L` = 最后一个周五 18:00 UTC；`59 23 LW * *` = 最后一个工作日 23:59 UTC。
- 改动传播：新增/修改/删除 Cron 可能需数分钟（最多 15 分钟）在全球网络生效。

### 同一时刻多 cron 并发

**[未找到权威来源]** 官方文档**未说明**同 Worker 多条 cron 在同一分钟触发时是并发还是串行、有无并发上限。已知事实：每条 trigger 各自调用同一 handler，Cron Events 分别记录。具体调度（并发/串行）官方未给语义，设计时不应假设串行——应以「幂等 + 各自独立」为前提。

---

## 6. D1 / SQLite 的时区能力

**[官方明确]** SQLite 来源：<https://sqlite.org/lang_datefunc.html>（Last updated **2026-07-11 15:07:16Z**）
**[官方间接]** D1 来源：<https://developers.cloudflare.com/d1/reference/time-travel/>（D1 时间戳「always in UTC」）；D1 兼容 SQLite 引擎（`D1 leverages SQLite's query engine`）

### 6.1 SQLite 不支持命名时区

- SQLite 日期时间函数（`date/time/datetime/juliandate/unixepoch/strftime`）**没有**任何命名时区（如 `'Asia/Shanghai'`）参数。
- 时区处理仅通过两种方式：
  1. **修饰符 `localtime` / `utc`**：`localtime` 假定左侧时间为 UTC 并换算到「本地时区」；`utc` 反之。官方明确它依赖 C 库 `localtime_r()`，「The computation of local time depends heavily on the whim of politicians…」且 `localtime_r()` 通常只对 **1970–2037** 年可靠。
  2. **time-value 后缀 `[+-]HH:MM` 或 `Z`**：如 `'2025-01-01 08:00:00+08:00'`；内部以 UTC 计算，`Z` 为无操作，`+08:00` 会被减去以得 UTC。
- **结论**：无法在 SQLite 内做「按 IANA 时区自动夏令时换算」。

### 6.2 D1 运行于 UTC，`datetime('now','localtime')` ≈ UTC

- D1 是 Cloudflare 边缘 SQLite，**运行时本地时区为 UTC**。因此：
  - `datetime('now')` 与 `datetime('now','localtime')` 在 D1 中都返回 **UTC** 时间（`localtime` 修饰符在 UTC 环境下是空操作）。
  - `CURRENT_TIMESTAMP` / `unixepoch('now')` 均返回 UTC。
- 官方 D1 Time Travel 文档确认 D1 时间戳「Unix timestamps … This is always in UTC」，佐证 D1 全栈以 UTC 为基准。
- **设计含义**：上报/存储一律以 UTC 存（`TEXT` ISO-8601 或 `INTEGER` unix 秒），展示层按用户时区换算；不要在 DB 层依赖 `localtime` 做「上海时间」。

### 6.3 可用偏移修饰符（含 `'+8 hours'`）

官方列出的修饰符（部分相关项）：
- 数值偏移：`NNN days/hours/minutes/seconds/months/years`（如 `'+8 hours'`、`'+1 day'`、`'-1 month'`；`s` 可省；NNN 可为浮点，可带 `+/-`）。
- 时间段偏移：`±HH:MM`、`±HH:MM:SS`、`±HH:MM:SS.SSS`、`±YYYY-MM-DD [HH:MM[:SS.SSS]]`。
- 锚点：`start of month` / `start of year` / `start of day`、`weekday N`。
- 时区/格式：`localtime`、`utc`、`subsec`（亚秒）、`julianday`、`unixepoch`、`auto`、`ceiling`、`floor`。
- 示例：`datetime('now','+8 hours')` 得「UTC+8 的墙上时间字符串」；`datetime('now','start of month','+1 month','-1 day')` 得月末。

### 6.4 D1 额外日期扩展

**[未找到权威来源 / 官方间接]** 官方未在 D1 文档中列出「额外日期/时区扩展」。D1 启用 SQLite 的 FTS5、JSON、Math 扩展；日期函数即标准 SQLite 集合。Cloudflare 的 **R2 SQL** 有 `date_trunc`、`to_local_time` 等函数，但那是 R2 SQL 而非 D1，**不适用于 D1**。D1 时区处理无超出 SQLite 标准的能力。

---

## 7. 延迟任务 / 补发机制

**[官方明确]** 来源：<https://developers.cloudflare.com/queues/platform/limits/>（Last updated **Apr 21, 2026**）；<https://developers.cloudflare.com/workers/runtime-apis/context/>（Last updated **Sep 10, 2026**）；<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

### 7.1 Queues 免费套餐额度

| 项 | 限额（Free 与 Paid 同，除保留期） |
|---|---|
| 每账户可建 Queue 数 | **10,000** |
| 单消息大小 | 128 KB |
| 消息重试次数 | 100 |
| 每 `sendBatch` 消息数 | 100（或 256KB 总计） |
| 单队列吞吐 | 5,000 消息/秒 |
| **消息保留期** | **Free 固定 24 小时，不可配置**；Paid 默认 3 天、可配至 14 天 |
| `delaySeconds`（发送/重试延迟） | **上限 24 小时** |
| Consumer 墙钟 / CPU | 15 分钟 / 可配至 5 分钟 |
| `visibilityTimeout`（拉取式） | 12 小时 |

- **Queues 在 Free 套餐可用**，且 `delaySeconds` 最高 24 小时 —— 可作为「延迟重试 / 补发」的原生手段（把失败任务作为消息重新入队并设 `delaySeconds`）。
- **[未找到权威来源]** 官方 Limits 页未列「每月消息总量」配额（该数字在 Pricing 页，本次未核实）；以上为 Limits 页明确项。

### 7.2 `ctx.waitUntil()` 在 cron 内的时限

- `ctx.waitUntil(promise)` 注册异步任务，使 Worker 在返回后继续完成。官方：`waitUntil` 对 HTTP 触发可「extend execution for up to **30 seconds** after the response is sent or the client disconnects」。
- 对 **cron（scheduled）触发**：没有「响应/断连」概念，运行时直接等待 `scheduled()` 返回的 promise，受 **Cron 墙钟上限 15 分钟**约束（见 Limits 表：Cron Trigger Duration = 15 min）。即 `waitUntil` 在 cron 内最远延伸到本次调用 15 分钟墙钟内。
- 若工作无法在时限内完成，官方明确建议：「send messages to a **Queue** and process them in a separate consumer Worker. Queues provide reliable delivery and automatic retries.」

### 7.3 官方推荐的「Cron 失败后重试」模式

**[官方间接]** Cron 本身**无内置「失败后延迟重试」开关**（仅有 `noRetry()` 退出平台重试）。官方推荐路径：
- 轻量重试：在 `scheduled()` 内自行 `withRetry()` 等逻辑；
- 延迟/可靠重试：将失败任务发往 **Queues**（利用 `delaySeconds` 最多 24h + 最多 100 次消息重试），由独立 Consumer Worker 处理；
- 长任务 + 步骤化重试：用 **Workflows**（`env.MY_WORKFLOW.create()` 由 cron 拉起，Workflow 内部 `step.do` 持久化并自动重试）—— 官方称这是「定时触发 + 长任务」的推荐组合（Cron Triggers 页面 Note 提及）。

---

## 8. Cron 并发（同 Worker 多条 cron）

**[未找到权威来源]** 来源：已查 <https://developers.cloudflare.com/workers/configuration/cron-triggers/>、<https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/>、<https://developers.cloudflare.com/workers/platform/limits/>，**均无**关于「同一 Worker 多条 cron 在同一分钟触发时是否并发/串行、有无并发上限」的官方表述。
- 已知：每条 trigger 独立调用同一 `scheduled()` handler，Cron Events 分别记录每次调用。
- 推论（非官方保证）：不应假设它们串行执行；设计上应保证各 cron 分支**相互独立、幂等**，避免相互依赖同一行/同一状态导致竞态。

---

## 9. 对设计的影响（约束，非方案）

1. **Cron 编排预算宽松但珍贵**：每账户仅 5 个 Cron（Free），每次触发消耗 1 次请求 + CPU；最小粒度 1 分钟、恒 UTC。周报/月报建议用「1 个每日 Cron + 在 handler 内按 `scheduledTime`/本地日期判断是否执行周/月分支」，以节省配额并避免多 cron 并发不确定性。
2. **重试不可依赖（官方未写明）**：官方一手文档从未写「Cron 失败会自动重试」，也未给次数/退避；只有 `controller.noRetry()` 的存在暗示平台侧有重试抑制开关。因此**不能**把「至少一次」或「至多一次」当保证 —— 每个 `scheduled()` 分支必须写成**幂等**，并用自建的心跳/状态表记录「已处理到哪个周期」，而不是指望平台兜底。
3. **幂等键取自 `scheduledTime` + 周期键**：`controller.scheduledTime`（UTC 毫秒，对同一次计划 fire 稳定，重试间不变）可作技术层幂等键；但业务正确性更该锚在**周期键**（如 `2026-W38` / `2026-09`）上——重跑同一周期的任务必须被判定为已处理。两者结合：唯一索引 `(task, period_key)`。
4. **时区一律存 UTC、边界在应用层算**：D1/SQLite 不支持命名时区，且 D1 运行时本地时区即 UTC（`datetime('now','localtime')` ≈ UTC，是空操作）。所有时间存 UTC（`INTEGER` unix 秒或 `TEXT` ISO-8601+Z），**周期边界（周/月/年的起止）由应用层按 Asia/Shanghai 计算成 UTC 区间后传入 SQL**，不要在 SQL 里靠 `localtime` 猜。若需按「业务日」分组（时间趋势轴），另存一个冗余的本地日期列，别让 `date()` 在 UTC 上分组。
5. **补数走 Queues 而非长尾 `waitUntil`**：`ctx.waitUntil` 在 cron 内受 15 分钟墙钟约束，只适合收尾/登记状态；跨小时延迟重试应用 Queues（`delaySeconds` ≤ 24h、消息重试 100 次、Free 24h 保留）。另需注意：**官方无「Cron 失败」专用告警**，静默失败要在 `scheduled()` 内自行捕获并落库/发 Webhook 才能被发现。

---

*本文件为可审计事实清单，所有 [官方明确]/[官方间接] 结论均附 developers.cloudflare.com 或 sqlite.org 来源 URL 与文档日期；[社区经验]/[未找到权威来源] 已单独标注，请勿当作官方承诺。*
