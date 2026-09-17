# 家庭财务系统 · «备份与导出策略» — 导出通道一手事实清单

> **调研范围**：Cloudflare 免费套餐（Free plan，不绑卡）下，「CSV / JSON 导出备份」走什么通道的**技术事实**核对。覆盖 5 组问题：
> ① Functions/Workers 生成大响应与流式能力；② D1 单次查询返回行数上限；③ 从 Worker 把文件推出去的各条通道（R2 / GitHub / Email / 第三方网盘 / KV）；④ 浏览器侧下载实现事实（重点：iOS Safari 与 iOS PWA）；⑤ CSV / JSON 的一手规范。
>
> **采集日期**：**2026-09-17**（所有「Last updated / Last modified」为抓取时页面自报值；文档会变动，复跑时请重新核对）。RFC / W3C 规范标注其发布日期。
>
> **来源口径（硬性）**：只采 `developers.cloudflare.com`（含 Changelog）、Cloudflare 官方博客、`cloudflare/workers-sdk`、**GitHub 官方文档**、**IETF RFC**、**MDN**、**WebKit 官方（bugs.webkit.org / webkit.org）**、**WHATWG / W3C 规范**。
> 二手博客 / 知乎 / 掘金 / CSDN / Medium **一律不作为结论依据**；本次检索未使用任何二手来源作为结论。
>
> **标注规则**（沿用 `cloudflare-free-tier-constraints.md` / `cloudflare-pages-static-layer-facts.md`）：
> - **[官方明确]** = 官方/规范原文写明，可逐字引用；
> - **[官方间接]** = 由官方原文可推导，官方未逐字写出这一步；
> - **[未找到一手来源]** = 官方/规范未给出说明，只有二手来源或完全无来源；
> - **[未证实 / 需实测]** = 官方无明文，且必须实测才能定论（附实测方法）。
>
> **输入前提（不重复调研，仅作已知事实）**：Free 版 CPU **10 ms/请求**（I/O 等待不计入，超限 Error 1102）、内存 **128 MB**、请求 **10 万/天**；Cron 同口径、墙钟 15 分钟；响应体无强制大小上限；D1 Free 单库 500 MB、读 500 万行/天、写 10 万行/天、**每调用 50 次查询**；cron 免费账户上限 5 个、**已占 4 个**（本文件第 3.4 / §6 处只在必要处引用）。
>
> **本文件不做产品判断**，只回答「技术上是否存在 + 代价 + 官方原文」。

---

## 0. 结论速览

| # | 问题 | 结论 | 依据等级 |
|---|---|---|---|
| 1.1 | 响应体大小官方限制 | **无强制上限**：`Response body size: No enforced limit`；`Cloudflare does not enforce response body size limits.` CDN 缓存上限 Free 512 MB | [官方明确] |
| 1.2 | 流式能力 | 官方有专页（`runtime-apis/streams`）；`Workers do not need to prepare an entire response body before returning a Response.` 用 `ReadableStream` / `TransformStream` | [官方明确] |
| 1.2b | 流式期间的 CPU 计费 | 官方**没有**逐字写「流式期间不计 CPU」；但 `CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests ... does not count` + `A Worker that is still streaming a response body remains active.` → 推导成立 | [官方间接] |
| 1.3 | 响应体编码 | `TextEncoder` 恒 UTF-8（`encoding` 属性 `always utf-8`）；Workers 文本响应默认 UTF-8；JSON 规范强制 UTF-8 | [官方明确] |
| 1.4 | 128 MB 是每 isolate 还是每请求 | **每 isolate**：`Memory per isolate 128 MB ... This limit is per-isolate, not per-invocation.` | [官方明确] |
| 1.4b | D1 结果集在内存里的形态 | 官方只写 `including query execution and result serialization, run within the Workers platform CPU and memory limits`；**没有**「一次查询最多返回 N 行」的硬上限 | [官方明确]（前者）+ [未找到一手来源]（行数上限） |
| 1.5 | CPU 时间算什么 | 只在 JS 执行时计；**fetch / KV 读 / DB 查询等待不计**；`JSON.parse` / 序列化 / 正则 / 循环 / 加密按常理计（官方只有「parse large payloads typically use 10-20 ms」这类描述，**无逐项清单、无耗时估算表**） | [官方明确] + [官方间接] |
| 2.1 | D1 单次查询返回行数上限 | **官方正面无明文**（无「最多返回 X 行」）；相关约束是 `Maximum SQL query duration 30 seconds` + 结果序列化受 Workers 128 MB 内存约束 + `Maximum number of rows per table: Unlimited` | [未找到一手来源] |
| 2.2 | 超出行数时是报错还是截断 | **无对应明文**；能查到的是「单次查询试图改动几十万行/几百 MB 会超过执行限制」，须分批 | [官方明确]（改动场景）+ [未找到一手来源]（查询返回场景） |
| 2.3 | `wrangler d1 execute` 与 Worker `.all()` 是否同口径 | **同口径**：CLI `use REST APIs` 打到同一 D1；官方 FAQ 明确 CLI/仪表盘查询同样计入 reads/writes 与日配额 | [官方明确] |
| 2.4 | SQL 长度 / batch 条数 | 单条语句 **100,000 bytes (100 KB)**；绑定参数 **100**；`batch()` 内**每条**各受此限；**batch 总条数上限官方未给数字** | [官方明确] + [未找到一手来源] |
| 3.1 | R2 是否要绑卡 | 官方只写要「an R2 subscription」+「Complete the checkout flow」；**未找到**「Free plan 免绑卡」的逐字表述 → 见 §3.1 与 §6-G3 | [官方间接] / [未找到一手来源] |
| 3.2 | GitHub Contents API 文件上限 | **不是 1 MB**。创建/更新端点官方**未写**具体大小上限；相邻的约束是：仓库层面 `GitHub blocks files larger than 100 MiB.`、浏览器上传 `no larger than 25 MiB`、`>50 MiB` 有 warning；`content` 字段 `using Base64 encoding`；Get 端点：`>100 MB: This endpoint is not supported.` | [官方明确] |
| 3.2b | GitHub rate limit | 未认证 **60/hr**；PAT / OAuth / App user token **5,000/hr**；App installation token **5,000/hr** 起，最多 **12,500/hr**；`GITHUB_TOKEN` in Actions **1,000/hr/repo** | [官方明确] |
| 3.2c | fine-grained PAT vs GitHub App | PAT：`Each token is limited to access resources owned by a single user or organization.`，可按仓库收窄；fine-grained **不支持**「对非成员 public repo 贡献 / outside collaborator / 跨多组织」。App：installation token 限额按仓库数与用户数缩放 | [官方明确] |
| 3.3 | 免费套餐能否从 Worker 发信 | **可以，但只能发往账户内已验证的 destination address**；发往任意收件人需 **Workers Paid**。定价表却把 Free 的 `Outbound emails (Email Sending)` 列为 `Not available` —— **官方两处表述冲突，两个都保留**（§3.3） | [官方明确]（两处互斥表述） |
| 3.3b | 邮件大小 | 正文+附件 **5 MiB**；发往 verified destination 可到 **25 MiB**；收件人合计 **50/封**；附件 ≤ **32** 个 | [官方明确] |
| 3.4 | 从 Worker 调第三方 HTTP API 是否被禁止 | **无官方明文禁止**。Cloudflare 侧唯一相关条款是 Self-Serve 协议 2.2.1(c)「不得绕过 service-specific 用量/配额限制」与 (j)「不得用服务提供 VPN 或类似代理服务」 | [官方明确]（条款原文）+ [未找到一手来源]（针对「备份到第三方网盘」的专门条款） |
| 3.5 | KV 免费额度 / 是否绑卡 | 读 100,000/天、写 1,000/天（**不同 key**）、删 1,000/天、list 1,000/天、存储 1 GB/账户、**单值上限 25 MiB**；`Writes to same key: 1 per second`。KV 属 Workers Free plan 内容；**未找到**「KV 需绑卡」的官方表述。**注意：单值 25 MiB 是硬上限** | [官方明确] + [未找到一手来源]（绑卡） |
| 4.1 | `<a download>` + Blob URL | `download` **只在 same-origin 或 `blob:` / `data:` 下生效**；header 的 `filename` 优先于 download 属性；`Content-Disposition: inline` 时 Chrome / Firefox 82+ 仍按 download 处理 | [官方明确]（MDN） |
| 4.1b | `navigator.share` | 需 **secure context + transient activation + web-share Permissions Policy**；传 files 时若实现不支持会抛 `TypeError`；MDN 把 `.csv` / `text/csv` 列入「usually shareable file types」 | [官方明确]（MDN） |
| 4.2 | iOS Safari 下载 | `download` 属性 **iOS 13.0 起支持**（WebKit 官方 bug 167341）；安装到主屏（standalone PWA）的下载行为**多次被 WebKit 判为「非 WebKit 问题 / Safari UI 问题」**，存在多个长期开放/已 MOVED 的 bug | [官方明确]（WebKit bugzilla） |
| 4.2b | iOS PWA 能否下载 | **能触发，但体验不可靠且不可控**：bug 209407（iOS 14.3 前静默失败，已 FIXED）、bug 236943（下载后**无法返回 App**，RESOLVED MOVED 给 Apple）、bug 275288（装到主屏后行为与 Safari 不同，2024-06 关闭为「Apple 内部处理」） | [官方明确]（WebKit bugzilla） |
| 4.3 | Blob URL 在 iOS 的限制 | WKWebView（含 iOS 上的 Chrome / Firefox）曾不支持 `blob:` 作为 `<a download>` 的 href，**bug 216918 于 iOS 17.3 前后 RESOLVED**；MDN：blob URL 会阻止底层对象被 GC，须 `revokeObjectURL()` | [官方明确] |
| 5.1 | CSV / RFC 4180 | 定义了 CRLF、可选 header、逗号分隔、双引号转义（`""`）；**完全没有定义 NULL**，也**没有** null / 空值的任何表示法 | [官方明确]（RFC 原文） |
| 5.2 | JSON 数字精度 | RFC 8259：实现可就 range/precision 设限；整数在 `[-(2**53)+1, (2**53)-1]` 内可精确互操作。RFC 7493：`cannot expect a receiver to treat an integer whose absolute value is greater than 9007199254740991 ... as an exact value`，并 **RECOMMENDED** 用 **JSON 字符串**承载 64 位整数 | [官方明确]（RFC 原文） |
| 5.2b | JSON 能否无损表达 SQLite 64 位整数 | SQLite INTEGER 是 **8-byte signed**；**JSON 数字不能**保证无损（超 2^53-1 即越界）→ 需以字符串编码。**这是规范明文级别的结论** | [官方明确] |
| 5.3 | CSV 无法区分 NULL 与空串 | **RFC 4180 未定义 NULL**（故无法区分）；W3C「Model for Tabular Data」是**唯一**定义 null 语义的一手规范，且其默认规则正是「空字符串 ⇒ 语义值为 null」（即二者默认**不可区分**） | [官方明确] |

---

## 1. Functions / Workers 生成「大响应」的官方限制与流式能力

> Pages Functions 跑在同一 Workers 运行时上（见 `cloudflare-free-tier-constraints.md` §1.3），故下列 Workers 侧原文对 `/api/*` 同样适用。**[官方间接]**（Pages 文档未逐字重复这些限制，而是「Requests to Pages functions count towards your quota for Workers plans」）。

### 1.1 Response body 大小：官方明文「无强制上限」

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**，采集 2026-09-17）

「Request and response limits」表逐字：

> ```
> Limit                             Value
> URL size                          16 KB
> Request header size               128 KB (total)
> Response header size              128 KB (total)
> Response body size                No enforced limit
> ```

紧随其后的段落逐字：

> "Cloudflare does not enforce response body size limits. **CDN cache limits apply: 512 MB for Free, Pro, and Business plans, and 5 GB for Enterprise.**"

同时该页明确请求体（上传）有上限：Free / Pro **100 MB**，Business 200 MB，Enterprise 最高 5 GB。

**对本票含义（事实层面）**：同步响应体本身**没有**大小闸门；真正的闸门是生成响应时的 **CPU 10 ms** 与 **内存 128 MB**，以及（若走缓存）**512 MB CDN 缓存上限**。

补充（内存超限时的原文报错）：同页「Error: exceeded memory limit」段逐字：

> "You may also see the runtime error **`Memory limit would be exceeded before EOF`** when attempting to buffer a response body that exceeds the limit."

以及官方给的第一条缓解建议逐字：

> "**Stream request and response bodies** — Use `TransformStream` or `node:stream` instead of buffering entire payloads in memory."

### 1.2 Streaming：有专页，`ReadableStream` / `TransformStream` 均为官方支持

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/runtime-apis/streams/>（页面未显示 Last updated；采集 2026-09-17）

逐字原文：

> "Use the Streams API to avoid buffering large requests or responses in memory. This enables you to parse extremely large request or response bodies **within a Worker's 128 MB memory limit**. This is faster than buffering the entire payload into memory, as your Worker can start processing data incrementally, and allows your Worker to handle **multi-gigabyte payloads or files** within its memory limits."

> "**Workers do not need to prepare an entire response body before returning a `Response`.** You can use a `ReadableStream` to stream a response body **after sending the response status line and headers**."

> "By default, Cloudflare Workers is capable of streaming responses using the Streams APIs."（注：此句在初次抓取中未出现，于同页第二次抓取出现；以原文为准）

> "The worker can create a `Response` object using a `ReadableStream` as the body. **Any data provided through the `ReadableStream` will be streamed to the client as it becomes available.**"

**官方给的 `TransformStream` 变换示例**（逐字复制，含关键注释）：

```js
export default {
	async fetch(request, env, ctx) {
		// Fetch from origin server.
		const response = await fetch(request);

		const { readable, writable } = new TransformStream({
			transform(chunk, controller) {
				controller.enqueue(modifyChunkSomehow(chunk));
			},
		});

		// Start pumping the body. NOTE: No await!
		response.body.pipeTo(writable);

		// ... and deliver our Response while that's running.
		return new Response(readable, response);
	},
};
```

官方对该模式的说明逐字：

> "This example calls `response.body.pipeTo(writable)` but **does not `await`** it. This is so it does not block the forward progress of the remainder of the function. It continues to run asynchronously until the response is complete or the client disconnects."
> "**The runtime can continue running a function (`response.body.pipeTo(writable)`) after a response is returned to the client.**"

官方「Common issues」逐字（**重要限制**）：

> "**The Streams API is only available inside of the Request context, inside the `fetch` event listener callback.**"

**是否专页**：是。Workers 文档存在 `workers/runtime-apis/streams/` 家族页（`readablestream` / `readablestreamdefaultreader` / `readablestreambyobreader` / `writablestream` / `writablestreamdefaultwriter` / `transformstream`），另有实例专页 `workers/examples/streaming-json/`。
- 来源：<https://developers.cloudflare.com/workers/examples/streaming-json/>（Last updated **Apr 23, 2026**，采集 2026-09-17），逐字：`"Use the Streams API to process JSON payloads that would exceed a Worker's 128 MB memory limit if fully buffered."`

### 1.2b 流式响应的 CPU 计费：**官方无逐字专述**，但可推导

**[官方间接]** 两条原文拼起来可推导「流式等待期间不计 CPU」：

1. CPU 定义（Workers Limits 页，Last updated Sep 5, 2026）逐字：
   > "**CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time.**"
2. 墙钟表（同页 + <https://developers.cloudflare.com/workflows/reference/limits> 同段文字）逐字：
   > "**Incoming HTTP request — Unlimited. No hard limit while the client remains connected. A Worker that is still streaming a response body remains active.** `waitUntil()` extends execution for up to 30 seconds after the response or disconnect."

**缺口（须明确写出）**：在 `developers.cloudflare.com` 的 Limits / Streams / Best Practices / How Workers works / Metrics 各页中，**未找到**「时间花在向客户端写 chunk 上（背压等待)不计入 CPU」的**逐字**句子，也**未找到**「流式响应按什么计费」的专段。
- → 结论标注 **[官方间接]**：按「CPU = JS 执行、I/O 等待不计」的定义，流式的等待属 I/O；但**若你生成的每一块都要跑 JS 序列化，那部分照样吃 CPU**。
- → 另有 **[未证实 / 需实测]** 项：见 §6-G1。

### 1.3 `TextEncoder` / 响应体编码

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/runtime-apis/encoding/>（页面未显示 Last updated；采集 2026-09-17）

逐字：

> "The `TextEncoder` takes a stream of code points as input and emits a stream of bytes. **Encoding types passed to the constructor are ignored and a UTF-8 `TextEncoder` is created.**"

> "`TextEncoder()` returns a newly constructed `TextEncoder` that generates a byte stream with **UTF-8** encoding."

> "`encoder.encoding` DOMString read-only — The name of the encoder as a string describing the method the `TextEncoder` uses (**always `utf-8`**)."

> "The `TextDecoder` interface represents a UTF-8 decoder."

（注意：`TextDecoder` 该句是文档的简化措辞，与 2026-03-03 起的 CJK decoder 事实矛盾 —— 该矛盾已由既有笔记 `cloudflare-runtime-fetch-facts.md` §1 记录，本文件不重复。**对本票而言只关心编码输出：`TextEncoder` 恒 UTF-8。**）

**规范侧一致**：
- **[官方明确]** RFC 8259 §8.1（December 2017）逐字：`"JSON text exchanged between systems that are not part of a closed ecosystem MUST be encoded using UTF-8."` 且 `"Implementations MUST NOT add a byte order mark (U+FEFF) to the beginning of a networked-transmitted JSON text."`
- **[官方明确]** RFC 4180 §3（October 2005）逐字：`"Common usage of CSV is US-ASCII, but other character sets defined by IANA for the 'text' tree may be used in conjunction with the 'charset' parameter."`

### 1.4 内存 128 MB：**每 isolate**，不是每请求

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

逐字：

> ```
> Limit                 Value
> Memory per isolate    128 MB
> ```
> "Each isolate can consume up to 128 MB of memory, **including the JavaScript heap and WebAssembly allocations**. **This limit is per-isolate, not per-invocation. A single isolate can handle many concurrent requests.**"
> "When an isolate exceeds 128 MB, the Workers runtime lets in-flight requests complete and creates a new isolate for subsequent requests. During extremely high load, the runtime may cancel some incoming requests to maintain stability."

**对导出场景的事实含义（非建议）**：128 MB 是**同一 isolate 内所有并发请求共享**的堆上限；「一次请求把全表读进内存 + 拼成字符串」的峰值要落在这个共享预算内。

### 1.4b D1 结果集在内存里的形态

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/limits/>（Last updated **Apr 21, 2026**）「CPU and memory」段逐字：

> "**Operations on a D1 database, including query execution and result serialization, run within the Workers platform CPU and memory limits.** Exceeding these limits, or hitting other platform limits, will generate errors."

**文档口径张力（两处都保留）**：D1 页说「query execution ... run within the Workers platform **CPU** and memory limits」，而 Workers Limits 页说「Waiting on ... **database queries** does not count toward CPU time」。两页口径不完全一致；实践上应理解为：**DB 查询的 I/O 等待不计 CPU，但结果在 JS 侧的序列化/加工计 CPU**（D1 FAQ 佐证见 §1.5）。

**是否有「一次查询最多返回 N 行」的硬上限？** → **未找到官方明文**。D1 Limits 页的相关行只有：

> `Maximum number of rows per table  Unlimited (excluding per-database storage limits)`

以及 `Maximum string, BLOB or table row size  2,000,000 bytes (2 MB)`（**单行** 2 MB，不是结果集总量）。

### 1.5 CPU 时间到底算什么

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

逐字原文（全部的 CPU 说明就这些，**没有更细的逐项清单**）：

> "CPU time measures how long the CPU spends executing your Worker code. **Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time.**"
>
> ```
> Limit                        Workers Free   Workers Paid
> CPU time per HTTP request    10 ms          5 min (default: 30 seconds)
> CPU time per Cron Trigger    10 ms          30 seconds (< 1 hour interval) / 15 min (>= 1 hour interval)
> ```
>
> "**Most Workers consume very little CPU time. The average Worker uses approximately 2.2 ms per request. Heavier workloads that handle authentication, server-side rendering, or parse large payloads typically use 10-20 ms.**"
>
> "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit. **If your Worker starts hitting the limit consistently, its execution will be terminated** according to the limit configured."
>
> "When a Worker exceeds its CPU time limit, Cloudflare returns **Error 1102** to the client with the message `Worker exceeded resource limits`."

**逐项回答用户的问题（JSON 序列化 / 字符串拼接 / 加密 / SQL 解析是否算）**：

| 操作 | 官方是否逐字说明 | 结论 |
|---|---|---|
| `fetch` / KV 读 / DB 查询**等待** | **写明不计** | 不计入 CPU（原文如上） |
| `JSON.parse` / JSON 序列化 | **无逐字清单**；但官方给「workloads that ... **parse large payloads** typically use 10-20 ms」 | [官方间接] 计入（在 JS 里跑的就是 JS 执行） |
| 字符串拼接 / 大字符串构造 | **无逐字说明** | [官方间接] 计入 |
| 加密（crypto） | **无逐字说明**；官方 changelog 举例「take the cryptographic hash of a large file from R2」是 CPU 密集场景 | [官方间接] 计入 |
| SQL 解析 | **无逐字说明**。**注意**：SQL 在 D1 引擎侧执行，按 Workers 原文「database queries」属不计入的那一类；但 D1 页又称 query execution 受 Workers CPU 限制（§1.4b 的张力） | [未找到一手来源]（明确口径）|
| 是否有「CPU 时间估算 / 常见操作耗时表」 | **没有**。全站只有一句 `The average Worker uses approximately 2.2 ms per request` 与 `10-20 ms` 的粗描述 | **[未找到一手来源]** |

**旁证（D1 FAQ，[官方明确]）** 来源：<https://developers.cloudflare.com/d1/reference/faq/>（页面未显示 Last updated；采集 2026-09-17）逐字：

> "Does D1 charge additional for additional compute? D1 itself does not charge for additional compute. **Workers querying D1 and computing results: for example, serializing results into JSON and/or running queries, are billed per Workers pricing**, in addition to your D1 specific usage."

→ 官方把「把结果序列化成 JSON」明确归到 **Workers 计算**一侧。

---

## 2. D1 单次查询的返回行数上限（能否「一次性读全表」）

### 2.1 官方**没有**写「查询最多返回 X 行」

**[未找到一手来源]** 已核 `https://developers.cloudflare.com/d1/platform/limits/`（Last updated **Apr 21, 2026**）、`https://developers.cloudflare.com/d1/reference/faq/`、`https://developers.cloudflare.com/d1/worker-api/prepared-statements/`（Last updated **Jun 22, 2026**）、`https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/`（采集 2026-09-17）。

**逐字可引的相邻限制（全表如下）**：

> ```
> Databases per account                          50,000 (Workers Paid) / 10 (Free)
> Maximum database size                          10 GB (Workers Paid) / 500 MB (Free)
> Maximum storage per account                    1 TB (Workers Paid) / 5 GB (Free)
> Time Travel duration                           30 days (Paid) / 7 days (Free)
> Maximum Time Travel restore operations         10 restores per 10 minutes (per database)
> Queries per Worker invocation                  1000 (Paid) / 50 (Free)
> Maximum number of columns per table            100
> Maximum number of rows per table               Unlimited (excluding per-database storage limits)
> Maximum string, BLOB or table row size         2,000,000 bytes (2 MB)
> Maximum SQL statement length                   100,000 bytes (100 KB)
> Maximum bound parameters per query             100
> Maximum arguments per SQL function             32
> Maximum characters (bytes) in a LIKE/GLOB      50 bytes
> Maximum bindings per Workers script            Approximately 5,000
> Maximum SQL query duration                     30 seconds
> Maximum file import (d1 execute) size          5 GB
> ```

**结论（事实层面）**：官方**从未**给出「单次查询结果集行数上限」这一条，也**从未**给出「建议分页」的通用告诫（分页建议只出现在「改动海量行」的场景，见 §2.2）。能确定的约束是间接三件套：
1. **`Maximum SQL query duration` 30 秒**（超时即失败）；
2. 结果在 Workers 侧要落进 **128 MB 共享 isolate 内存**（§1.4b）；
3. **`Queries per Worker invocation` = 50（Free）**（要分多次查询时，每次 invoke 只有 50 次预算）。

**方法论注记（非官方）**：D1 API 的 `meta` 字段会返回 `rows_read` / `rows_written`（逐字：`"rows_read: Number of rows read during the SQL query execution, including indices (not all rows are necessarily returned)."`），可用于实测核对；来源：<https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/>（采集 2026-09-17）。

### 2.2 超出时是报错还是截断

**[官方明确]**（仅覆盖「改动大量行」场景）D1 Limits 页「Query performance」逐字：

> "Data migrations like a large `UPDATE` or `DELETE` affecting millions of rows **must be run in batches**. **A single query that attempts to modify hundreds of thousands of rows or hundreds of MBs of data at once will exceed execution limits. Break the work into smaller chunks (e.g., processing 1,000 rows at a time) to stay within platform limits.**"

**[未找到一手来源]**：对「**SELECT 返回**巨量行时会报错还是悄悄截断」，官方**无任何明文**。→ 必须实测（§7 步骤 D2）。

其它相关错误行为（[官方明确]）：超出日读/写配额时逐字为
> "When your account hits the daily read and/or write limits, you will not be able to run queries against D1. D1 API will return errors to your client indicating that your daily limits have been exceeded."
（来源：D1 FAQ）

### 2.3 `wrangler d1 execute`（CLI）与 Worker 内 `env.DB.prepare().all()` 是否同口径

**[官方明确]** 同口径。三条原文：

1. `https://developers.cloudflare.com/d1/wrangler-commands/`（Last updated **Apr 21, 2026**）开篇逐字：
   > "**D1 Wrangler commands use REST APIs to interact with the control plane.**"
   `d1 execute` 的参数包含 `--command` / `--file` / `--local` / `--remote` / `--preview` / `--json`。
2. D1 FAQ 逐字：
   > "**Do queries I run from the dashboard or Wrangler (the CLI) count as billable usage? Yes, any queries you run against your database, including inserting (INSERT) existing data into a new database, table scans (SELECT * FROM table), or creating indexes count as either reads or writes.**"
3. D1 Limits 表把 `Maximum file import (d1 execute) size` 单列为 **5 GB**——即 CLI 有自己的**导入**通道上限，但**没有**为 CLI 单独放宽/收紧「查询返回行数」的说明。

→ **结论**：CLI 与 Worker 打到的是**同一个 D1**，`maximum SQL statement length 100 KB` / `max bound params 100` / `50 queries per invocation`（后者是 Worker 侧概念）等限制对二者一致；**没有任何官方文字说 CLI 可以绕过结果集内存/时长约束**。
→ **[未证实]**：CLI 侧的「单次 execute 结果集行数」是否有独立阈值 —— 官方无明文。

注意区分：`wrangler d1 export` 是**另一条命令**（导出 .sql 文件），参数逐字为 `--output`（required）、`--local` / `--remote`、`--table`、`--no-schema`、`--no-data`；官方**未给出**该命令的大小/行数上限说明。来源同上（`d1/wrangler-commands/`，Apr 21, 2026）。

### 2.4 单条 SQL 语句长度上限 / `batch()` 语句数上限

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/platform/limits/>（Last updated **Apr 21, 2026**）

> `Maximum SQL statement length  100,000 bytes (100 KB)`
> `Maximum bound parameters per query  100`

「Batch limits」段逐字：

> "**Limits for individual queries (listed above) apply to each individual statement contained within a batch statement.** For example, the maximum SQL statement length of 100 KB applies to **each statement inside the `db.batch()`**."

**[未找到一手来源]**：`db.batch()` **一次最多能放多少条语句** → 官方**未给数字**（此结论与既有笔记 `cloudflare-runtime-fetch-facts.md` §4 一致，本文件交叉确认）。

`batch()` 语义（[官方明确]，来源 `d1/worker-api/d1-database/`）：批内语句作为事务**顺序、原子**执行，任一条失败则整体回滚，返回数组与传入顺序一一对应；可复用同一 prepared statement 多次 bind。

---

## 3. 从 Worker / Functions 把文件「推出去」的各条通道（候选 C 的技术事实）

> 本节只判「技术上是否存在 + 代价 + 官方原文」，**不做产品判断**。

### 3.1 R2

**[官方明确]** 来源：<https://developers.cloudflare.com/r2/get-started/>（Last updated **Apr 21, 2026**）逐字：

> "**You need a Cloudflare account with an R2 subscription.** If you do not have one:
> 1. Go to the Cloudflare Dashboard.
> 2. Select **Storage & databases > R2 > Overview**
> 3. **Complete the checkout flow to add an R2 subscription to your account.**
> R2 is free to get started with included free monthly usage."

**[官方明确]** 免费额度（<https://developers.cloudflare.com/r2/pricing/>，Last updated **Aug 7, 2026**）：

> ```
> Free tier (Standard storage only)
> Storage              10 GB-month / month
> Class A Operations   1 million requests / month
> Class B Operations   10 million requests / month
> Egress               Free
> ```
> "The free tier only applies to Standard storage, and does not apply to Infrequent Access storage."

**[官方明确]** R2 Limits（<https://developers.cloudflare.com/r2/platform/limits/>，Last updated **Jun 8, 2026**）：`Object size 5 TiB per object`、`Maximum upload size 5 GiB (single-part) / 4.995 TiB (multi-part)`、`Maximum concurrent writes to the same object name 1 per second`。**单对象 5 TiB ⇒ 对本项目数据集而言等于无上限。**

**Worker 绑定 R2 的官方方式**（[官方明确] 路径）：`r2/get-started/workers-api/` ——「Use R2 from Cloudflare Workers」，在 wrangler 里声明 `r2_buckets` 绑定，代码用 `env.MY_BUCKET.put(...)` / `.get(...)`。访问方式官方列了 4 种：Workers API / S3 兼容 API / CLI / Dashboard。R2 调用计入「Subrequests to internal services」。

**是否需绑卡？**
- **[官方间接]** 官方只写「需要 an R2 subscription」+「Complete the **checkout flow**」；`r2/pricing` 的 Free tier 表本身不提支付方式。
- 旁证（[官方明确] 原文，指向「R2 是一个会挂在支付方式上的 usage-based 订阅」）：<https://developers.cloudflare.com/billing/resolve-cannot-remove-payment-method/> 逐字把 R2 列在「usage-based products」表里（`R2 | Storage and operations | 10 GB storage, 1M Class A operations, and 10M Class B operations`），并说明 `"You can only remove a payment method after all paid subscriptions are canceled and outstanding charges are settled."`；<https://developers.cloudflare.com/billing/understand/faq> 逐字：`"A subscription (also called an add-on) is a product you enable at the account or domain level, such as Workers, R2, Load Balancing, or Cache Reserve."`
- → **[未找到一手来源]** 一句逐字的「R2 免费额度也必须先绑卡」。**结论：官方要求先走 checkout 开通 R2 订阅；是否强制填卡未见逐字明文 → 见 §6-G3。**

### 3.2 GitHub API（Contents API）

#### 3.2.1 单文件大小：**不是 1 MB**

**[官方明确]** 来源：<https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>（页面未显示 Last updated；采集 2026-09-17）逐字：

> "**GitHub limits the size of files allowed in repositories.** If you attempt to add or update a file that is larger than **50 MiB**, you will receive a warning from Git. The changes will still successfully push to your repository, but you can consider removing the commit to minimize performance impact."
>
> "Note: **If you add a file to a repository via a browser, the file can be no larger than 25 MiB.**"
>
> "**GitHub blocks files larger than 100 MiB.** To track files beyond this limit, you must use Git Large File Storage (Git LFS)."
>
> "We recommend repositories remain small, ideally less than 1 GB, and less than 5 GB is strongly recommended."

#### 3.2.2 创建/更新文件端点（`PUT /repos/{owner}/{repo}/contents/{path}`）

**[官方明确]** 来源：<https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10#create-or-update-file-contents>（API version **2026-03-10**；采集 2026-09-17）逐字：

> "**Create or update file contents** — Creates a new file or replaces an existing file in a repository."
>
> Body parameters：
> - `message` (string, **Required**) — "The commit message."
> - `content` (string, **Required**) — "**The new file content, using Base64 encoding.**"
> - `sha` (string) — "**Required if you are updating a file.** The blob SHA of the file being replaced."
> - `branch` (string) — "The branch name. Default: the repository's default branch."
>
> Note: "If you use this endpoint and the 'Delete a file' endpoint in parallel, the concurrent requests will conflict and you will receive errors. **You must use these endpoints serially instead.**"

**[未找到一手来源]**：该端点**自身**的**逐字**最大文件大小。文档里唯一出现数字的大小说明在 **Get repository content** 一节（逐字）：

> "If the requested file's size is:
> - **1 MB or smaller**: All features of this endpoint are supported.
> - **Between 1-100 MB**: Only the `raw` or `object` custom media types are supported. ... when using the `object` media type, the `content` field will be an empty string and the `encoding` field will be `"none"`.
> - **Greater than 100 MB**: **This endpoint is not supported.**"

**→ 对「100 MB 还是 1 MB」的直接回答（事实层面）**：
- 那个 **1 MB** 是 **GET 端点「全部特性可用」的分界**，不是写入上限；
- **写入侧**能引的一手数字是仓库层面的 **50 MiB warning / 100 MiB block / 浏览器上传 25 MiB**；
- **Contents API 创建/更新端点自己的逐字上限：未找到官方明文。**
- base64 编码要求：**有明文**（`content` 字段 `using Base64 encoding`；页面概述 `Use the REST API to create, modify, and delete Base64 encoded content in a repository.`）→ base64 会把体积放大约 **4/3**，这是工程上必须先算的账（事实陈述）。

#### 3.2.3 Rate limit

**[官方明确]** 来源：<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10>（API version **2026-03-10**；采集 2026-09-17）逐字：

> "The primary rate limit for unauthenticated requests is **60 requests per hour**."
>
> "All of these requests count towards your personal rate limit of **5,000 requests per hour**. Requests made on your behalf by a GitHub App that is owned by a GitHub Enterprise Cloud organization have a higher rate limit of **15,000 requests per hour**."
>
> "**GitHub Apps authenticating with an installation access token use the installation's minimum rate limit of 5,000 requests per hour.** ... Installations that have more than 20 repositories receive another 50 requests per hour for each repository. Installations that are on an organization that have more than 20 users receive another 50 requests per hour for each user. **The rate limit cannot increase beyond 12,500 requests per hour.**"
>
> "**The rate limit for `GITHUB_TOKEN` is 1,000 requests per hour per repository.**"

Secondary rate limits 逐字（对本用途最相关的一条）：

> "**Create too much content on GitHub in a short amount of time.** In general, **no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour** are allowed. Some endpoints have lower content creation limits."

**对「public 仓库」的注意**：官方明确 authenticated fine-grained PAT 的缺口中含
> "**Using fine-grained personal access token to contribute to public repos where the user is not a member.**"
（来源：`/authentication/.../managing-your-personal-access-tokens`）

→ 即：**若目标仓库是你自己账号下的 public 仓库**，fine-grained PAT 可用；**若是别人的 public 仓库**，fine-grained PAT 这条路被官方列为不支持，只能回到 classic PAT 或 GitHub App。

#### 3.2.4 fine-grained PAT vs GitHub App 的差异

**[官方明确]** 来源：<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>（页面未显示 Last updated；采集 2026-09-17）逐字：

> "GitHub recommends that you use fine-grained personal access tokens instead of personal access tokens (classic) whenever possible."
>
> "**Each token is limited to access resources owned by a single user or organization.**"
> "**Each token can be further limited to only access specific repositories for that user or organization.**"
> "Each token is granted specific, fine-grained permissions, which offer more control than the scopes granted to personal access tokens (classic)."
>
> 权限名逐字（仓库权限表中一行）：`contents  Contents  read, write`
>
> 有效期逐字：`"Under Expiration, select an expiration for the token. Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy set by your organization or enterprise owner."` 与 `"If not provided, the default is 30 days..."`
>
> 缺口逐字：
> - "Using fine-grained personal access token to contribute to public repos where the user is not a member."
> - "Using fine-grained personal access token to contribute to repositories where the user is an outside or repository collaborator."
> - "**Using fine-grained personal access token to access multiple organizations at once.**"
> - "Using fine-grained personal access token to access Packages." / "... to call the Checks API." / "... to access Projects owned by a user account."

**GitHub App 侧的差异（[官方明确]，rate limits 页）**：installation access token **5,000/hr 起、最多 12,500/hr**，按仓库数/用户数缩放；GitHub App **不绑定到单个用户**（这是它与 PAT 的结构性差异），且 App 的 token 由 GitHub 签发、短时有效。
- **[未找到一手来源]**：GitHub 官方没有一页「PAT vs GitHub App 该怎么选」的决策表（本次检索未命中）；上述差异是从两份官方文档（PAT 页 + Rate limits 页）并列得到的。
- **注意**：fine-grained PAT 页明确 `"Each token is limited to access resources owned by a single user or organization."` —— 即 PAT 天然**绑定到一个 owner**。对「个人自用的 public 备份仓库」这条路，PAT 已足够；换成 App 主要是为了脱离个人账号与获得可缩放限额。

### 3.3 Email（从 Worker 发到邮箱）——**本票最需要留意的矛盾**

**关键结论（先给）**：
- **免费套餐能发，但只能发往账户内「已验证的 destination address」（也就是你自己的邮箱）**；
- **发往任意收件人 = 需要 Workers Paid**；
- 但**定价表把 Free 的 outbound 列为 `Not available`**，与上述文字**互斥** → 两边都保留。

**[官方明确] 表述 A（文字）** 来源：<https://developers.cloudflare.com/email-service/platform/pricing/>（Last updated **Jun 9, 2026**）逐字：

> "Email Routing is available on both the Workers Free and Workers Paid plans. **Sending to arbitrary recipients requires the Workers Paid plan. Sending to verified destination addresses in your account is free on all plans, including when only Email Routing is configured.**"

> ```
>                            Workers Free    Workers Paid
> Outbound emails (Email Sending)   Not available   3,000 included per month, then $0.35 per 1,000 emails
> Inbound emails (Email Routing)    Unlimited       Unlimited
> ```
>
> "Sends to verified destination addresses are free and do not count toward the included quota."

**[官方明确] 表述 B（destination address 页）** 来源：<https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/>（Last updated **Jun 9, 2026**）逐字：

> "**You can also send to verified destination addresses directly through the REST API or the Workers binding, free of charge on any plan — including when only Email Routing is configured.** Sends to verified destination addresses do not count toward your monthly quota or daily sending limits."

**[官方明确] 表述 C（Limits 页）** 来源：<https://developers.cloudflare.com/email-service/platform/limits/>（Last updated **Sep 16, 2026**）逐字：

> "**Before you onboard a sending domain, you can send emails only to verified destination addresses in your account. After you onboard a sending domain, you can send to any recipient immediately.**"
> "**Sends to verified destination addresses are always free: they do not count toward your monthly quota or your daily sending limits, on any plan, including when only Email Routing is configured. You can only send from your routing domains.**"

**→ 官方文件内部冲突（两个都保留）**：
| 位置 | 表述 | 隐含结论 |
|---|---|---|
| pricing 表（Free 列） | `Outbound emails (Email Sending) = Not available` | Free 完全不能主动发信 |
| pricing 正文 / destination 页 / limits 页 | 「发往 verified destination address 在任何 plan 都免费，不占配额」 | Free **可以**发（仅限已验证地址） |
**冲突日期**：三页分别 Last updated Jun 9, 2026 / Jun 9, 2026 / Sep 16, 2026，采集 2026-09-17。**无法在文档层面消解 → 必须实测**（§7 步骤 E1）。

**能力归属**：是 `send_email` binding（Workers 侧）与 REST API / SMTP 三条并列通道。**[官方明确]** 来源：<https://developers.cloudflare.com/email-service/api/send-emails/workers-api/>（Last updated **Sep 16, 2026**）逐字：

> "Configure a `send_email` binding in your Wrangler configuration file to enable email sending: `{ "send_email": [{ "name": "EMAIL" }], }`"
> "`send()` Send a single email using the `send()` method on your email binding."

**限制（[官方明确]，同上 + limits 页）**：

| 项 | 值（逐字） |
|---|---|
| 收件人（to + cc + bcc 合计） | `50 per email` |
| 附件个数 | `attachments array exceeds 32 entries` → `E_TOO_MANY_ATTACHMENTS` |
| 总邮件大小 | `5 MiB (Including attachments)` |
| 总邮件大小（仅 verified destination） | `25 MiB` |
| 主题 | `998 characters` |
| Header 总量 | `16 KB` |
| 发件域 | `You can only send from your routing domains.`（发送方地址必须属于已 onboard 到 Email Service 的域） |
| 错误码 | `E_SENDER_NOT_VERIFIED` / `E_RECIPIENT_NOT_ALLOWED`（`Recipient address not in allowed_destination_addresses`）/ `E_DAILY_LIMIT_EXCEEDED` / `E_CONTENT_TOO_LARGE` 等 |

**绑定可收紧到什么程度（[官方明确]，send-bindings 页，Jun 9, 2026）** 逐字：
> "**No restriction attribute**: The binding can send to any verified destination address in your account."
> "**`destination_address`**: The binding can only send to the single destination address configured here."
> "**`allowed_destination_addresses`**: The binding can only send to addresses listed in this allowlist."
> "**`allowed_sender_addresses`**: The binding can only send from the addresses listed in this allowlist."

**与 Cron 的耦合（[官方明确]，limits 页）** 逐字：
> "Routing to Workers on the Workers Free plan — **Workers that handle incoming emails count toward the standard Workers CPU and memory limits. On the Workers Free plan, complex handlers may exceed these limits and fail to process a message.** Failed invocations appear in Workers logs with the `EXCEEDED_CPU` error."

以及一条容易误判的观测陷阱，逐字：
> "**Emails sent from a Worker using the `send_email` binding appear in the Email Routing summary as dropped, even when they were delivered successfully.** To track outbound send success, use Email sending metrics and logs instead."

**前置条件（[官方明确]）**：destination address 必须**先验证**（Cloudflare 发验证邮件，点 Verify），未验证前「any routing rule that points to it stays disabled」；账号级共享，`Destination addresses per account: 200`。且需要你自己的域启用 Email Routing（`You can only send from your routing domains`）。

**"如果免费套餐根本不能主动发信，请明确说出来。"** → **不能这样断言。** 官方文字（3 处）说 Free 可以发往已验证 destination；只有定价表一行写 `Not available`。**结论：官方表述冲突，需实测**（§6-G2）。

### 3.4 第三方网盘 / 推送服务：从 Worker 调第三方 HTTP API 有无额外限制

**[未找到一手来源]**（针对「备份到第三方存储」这一具体用途）：在 `developers.cloudflare.com` 的 Workers Limits / Fetch / Best Practices / 常见问题中，**未找到**任何「禁止或限制用 Worker 调用第三方 HTTP API」的说明。官方唯一相关的量纲是 **Subrequests**（Free `50/request` 外部 + `1,000/request` 内部服务）。

**[官方明确]（合同条款原文，非产品文档）** 来源：<https://www.cloudflare.com/terms/>（Cloudflare Self-Serve Subscription Agreement，「2.2.1 Restrictions」；抓取页面未显示更新日期，采集 2026-09-17）逐字摘录与本用途可能相关的两条：

> "Unless otherwise expressly permitted in writing by Cloudflare, you will not and you have no right to: ...
> **(c) access or use the Services in a manner that violates or is intended to circumvent Service-specific usage limits, quotas, or other restrictions set forth in the Agreement;** ...
> **(j) use the Services to provide a virtual private network or other similar proxy services.**"

**对候选 C 的事实性提示（不作判断）**：
- **(c)** 的语义是「不得绕过各服务自己的配额/限制」——如果第三方网盘的写入量会绕过某个 Cloudflare 配额，这属于被禁之列；纯粹「把生成的备份文件 POST 给第三方 API」本身**没有**出现在任何禁止清单里。
- **(j)** 禁止的是「用本服务提供 VPN 或类似代理服务」；「定时把自家备份推到自己选择的目的地」与「对外提供代理服务」在文本上是两件事，但**(j)** 的边界官方未进一步解释。
- **→ 结论：无官方明文专门禁止或允许「从 Worker 把备份推给第三方网盘/推送服务」；只受 Subrequests 额度与上述通用条款约束。** 标注 **[未找到一手来源]**（针对该用途的专门条款）。

### 3.5 KV

**[官方明确]** 来源：<https://developers.cloudflare.com/kv/platform/limits/>（Last updated **Apr 21, 2026**）逐字全表：

> ```
> Feature                    Free                 Paid
> Reads                      100,000 reads/day    Unlimited
> Writes to different keys   1,000 writes/day     Unlimited
> Writes to same key         1 per second         1 per second
> Operations/Worker invocation  1000              1000
> Namespaces per account     1,000                1,000
> Storage/account            1 GB                 Unlimited
> Storage/namespace          1 GB                 Unlimited
> Keys/namespace             Unlimited            Unlimited
> Key size                   512 bytes            512 bytes
> Key metadata               1024 bytes           1024 bytes
> Value size                 25 MiB               25 MiB
> Minimum cacheTtl           30 seconds           30 seconds
> ```
>
> "Need a higher limit? ... complete the Limit Increase Request Form."

**[官方明确]** 来源：<https://developers.cloudflare.com/kv/platform/pricing/>（Last updated **Apr 21, 2026**）逐字：

> ```
>                       Free plan        Paid plan
> Keys read             100,000 / day    10 million/month, + $0.50/million
> Keys written          1,000 / day      1 million/month, + $5.00/million
> Keys deleted          1,000 / day      1 million/month, + $5.00/million
> List requests         1,000 / day      1 million/month, + $5.00/million
> Stored data           1 GB             1 GB, + $0.50/ GB-month
> ```
> "**The Workers Free plan includes limited Workers KV usage. All limits reset daily at 00:00 UTC. If you exceed any one of these limits, further operations of that type will fail with an error.**"
> "**Do queries I issue from the dashboard or wrangler (the CLI) count as billable usage? Yes**, any operations via the Cloudflare dashboard or wrangler, including updating (writing) keys, deleting keys, and listing the keys in a namespace count as billable KV usage."
> "Does Workers KV charge for data transfer / egress? **No.**"

**「能不能把备份塞进 KV」的事实性硬门**：
1. **单值上限 25 MiB**（`Value size 25 MiB`）—— **这是硬上限，不是建议值**；
2. **写入 1,000 次/天，其中「同一 key 每秒钟只能写 1 次」**；
3. **KV 是最终一致的（eventual consistency）**，本文件未逐字核到该句 → 见 §6-G6（[未证实]）。
4. 单账户存储 1 GB。

**KV 是否需要绑卡？** → **[未找到一手来源]**。可引的两条相关原文：
- `https://developers.cloudflare.com/workers/platform/pricing/` 逐字：`"The Workers Free plan includes limited usage of Workers, Pages Functions, Workers KV and Hyperdrive."` → **KV 是 Workers Free plan 的一部分**（而 Workers Free plan 是注册即有）；
- 同一页逐字：`"By default, users have access to the Workers Free plan."`
→ 但**没有**任何一句逐字说「Workers / KV 无需绑卡」，也**没有**任何一句说「需绑卡」。**KV 恰好是唯一一条不属于「需要单独 checkout 的订阅」的存储**（对比 R2 明确要 checkout）。标注 **[未找到一手来源]**（绑卡问题）。

---

## 4. 浏览器侧下载的实现事实（候选 A / B）

### 4.1 `<a download>` + Blob URL / `Content-Disposition` / `navigator.share`

**[官方明确]（MDN）** 来源：<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a>（页面未显示 Last modified；Baseline「widely available ... since July 2015」；采集 2026-09-17）

`download` 属性逐字：

> "Causes the browser to treat the linked URL as a download. Can be used with or without a `filename` value."
> "Without a value, the browser will suggest a filename/extension, generated from various sources: The `Content-Disposition` HTTP header; The final segment in the URL path; The media type (from the `Content-Type` header, the start of a `data:` URL, or `Blob.type` for a `blob:` URL)."
> "`filename`: defining a value suggests it as the filename. **`/` and `\` characters are converted to underscores (`_`).** Filesystems may forbid other characters in filenames, so browsers will adjust the suggested name if necessary."

**关键限制（逐字）**：

> "**Note:** `download` **only works for same-origin URLs, or the `blob:` and `data:` schemes.**"
> "How browsers treat downloads varies by browser, user settings, and other factors. The user may be prompted before a download starts, or the file may be saved automatically, or it may open automatically, either in an external application or in the browser itself."
> "If the `Content-Disposition` header has different information from the `download` attribute, resulting behavior may differ:
> - **If the header specifies a `filename`, it takes priority over a filename specified in the `download` attribute.**
> - **If the header specifies a disposition of `inline`, Chrome and Firefox prioritize the attribute and treat it as a download.** Old Firefox versions (before 82) prioritize the header and will display the content inline."

**[官方明确]（MDN）** 来源：<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition>（Baseline widely available since July 2015；采集 2026-09-17）逐字：

> "The first parameter in the HTTP context is either `inline` (default value, indicating it can be displayed inside the Web page, or as the Web page) or **`attachment` (indicating it should be downloaded; most browsers presenting a 'Save as' dialog, prefilled with the value of the `filename` parameters if present)**."
> "The parameters `filename` and `filename*` differ only in that `filename*` uses the encoding defined in RFC 5987 ... **When both `filename` and `filename*` are present in a single header field value, `filename*` is preferred over `filename`.** It's recommended to include both for maximum compatibility ... **You may want to avoid percent escape sequences in `filename`, because they are handled inconsistently across browsers. (Firefox and Chrome decode them, while Safari does not.)**"
> "Browsers may apply transformations to conform to the file system requirements, such as converting path separators (`/` and `\`) to underscores (`_`)."
> "**Note:** Chrome, and Firefox 82 and later, prioritize the HTML `<a>` element's `download` attribute over the `Content-Disposition: inline` parameter (for same-origin URLs). Earlier Firefox versions prioritize the header and will display the content inline."

**规范出处**：Content-Disposition 的 HTTP 定义在 RFC 6266（MDN 的 Specifications 段指向 `httpwg.org/specs/rfc6266.html#header.field.definition`）。

**[官方明确]（MDN）** `URL.createObjectURL` / blob URL：<https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static> 逐字：

> "The **`createObjectURL()`** static method of the `URL` interface creates a string containing a **blob URL** pointing to the object given in the parameter."
> "**Note:** This feature is *not* available in Service Workers due to its potential to create memory leaks."

**[官方明确]（MDN）** blob URL 内存语义：<https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob> 逐字：

> "Blob URLs can also be used to navigate to as well as to **trigger downloads of locally generated data**. ... the difference [vs data URLs] is that data URLs embed resources in themselves and **have severe size limitations**, whereas blob URLs require a backing `Blob` or `MediaSource` and **can represent larger resources**."
>
> "**Memory management** — Each time you call `createObjectURL()`, a new object URL is created, even if you've already created one for the same object. Each of these must be released by calling `URL.revokeObjectURL()` when you no longer need them. **As long as there's one object URL active, the underlying object cannot be garbage-collected and may cause memory leaks.**"
> "Browsers will release object URLs automatically when the document is unloaded; however, for optimal performance and memory usage, if there are safe times when you can explicitly unload them, you should do so."
> "**However, avoid freeing the object URL too early.** One common anti-pattern is [revoking immediately]. Revoking the blob URL immediately after the image gets rendered would make the image unusable for user interactions ... For long-lived applications, you should revoke object URLs only when the resource is no longer accessible by the user."
>
> "**Storage partitioning** — Access to resources via blob URLs are subject to the same restrictions as all other storage mechanisms, i.e., state partitioning. Blob URLs have an associated creator origin ... and can only be fetched from environments where the storage key matches that of the creator environment. **Blob URL *navigations* are not subject to this restriction**, although browsers may enforce privacy measures such as `noopener` for cross-site navigations to a blob URL."
>
> "Blob URLs support fetching with the `Range` header to request partial content. This is particularly useful when working with large blobs."

**[官方明确]（MDN）** `navigator.share`：<https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share>（采集 2026-09-17）逐字：

> "**Secure context:** This feature is available only in secure contexts (HTTPS), in some or all supporting browsers."
> "The **`share()`** method of the `Navigator` interface invokes the native sharing mechanism of the device to share data such as text, URLs, or files."
> "The Web Share API is gated by the `web-share` permission policy. **The `share()` method will throw exceptions if the permission is supported but has not been granted.**"
> "`files` Optional — An array of `File` objects representing files to be shared."
> 异常：`NotAllowedError` — "... **the window does not have transient activation**, or a file share is being blocked due to security considerations."
> `TypeError` — "... **Files are specified but the implementation does not support file sharing.**"
> "**Security** — This method requires that the current document have the `web-share` Permissions Policy and **transient activation**. (It must be triggered off a UI event like a button click and cannot be launched at arbitrary points by a script.) Further, the method must specify valid data that is supported for sharing by the native implementation."
> "Shareable file types" 列表中含：`".csv" - "text/csv"`、`".txt" - "text/plain"`、`".json"` **不在列表内**（列表里 Text 段只有 `.css`、`.csv`、`.ehtml`、`.htm`、`.html`、`.shtm`、`.shtml`、`.text`、`.txt`）。
> "However, you should always test with `navigator.canShare()` if sharing would succeed."

**规范出处**：`w3c.github.io/web-share/#share-method`（MDN Specifications 段）。

### 4.2 iOS Safari / PWA 下的下载行为（**本项目主用场景 = iPhone 上的 PWA**）

> **先说结论**：`download` 属性在 iOS **存在且自 iOS 13.0 起支持**（[官方明确]，WebKit bug 167341）；但**「已添加到主屏的 PWA（standalone）」里的下载行为**在 WebKit 官方 bugzilla 上有**多个长期案件**，且 WebKit 团队**多次把根因判定为「不属于 WebKit（属 Apple 内部 Safari UI / Web.app）」**。**官方没有**一份「iOS PWA 下载行为」的规范文档。

#### 4.2.1 iOS 何时开始支持 `download` 属性

**[官方明确]** 来源：<https://bugs.webkit.org/show_bug.cgi?id=167341>（标题 `[iOS] Add support for the download attribute`；状态 `RESOLVED FIXED`；Reported **2017-01-23 16:14:59 PST**；采集 2026-09-17）

逐字（WebKit 工程师 David Kilzer，Comment 53）：

> "**Support for the "download" attribute was added in iOS 13.0.**"
> "If you have a specific use case with the "download" attribute that doesn't work in iOS 13.0 or later, you need to file a new bug here on bugs.webkit.org with steps to reproduce and (if possible) a reduced test case that will reproduce the issue."

同 bug 中另有一条与 **PDF/文件名** 相关的开发者反馈（逐字，Comment 内引用块）：

> "Aside from the filename issue, does the expected behavior differ on Safari for iOS versus macOS in that on macOS the PDF file is not previewed, rather it is immediately downloaded with the desired filename. On Safari for iOS must a PDF always be previewed?"
> "With our equivalent CSV file on Safari for iOS the file is not previewed, rather the user is prompted to View or Download the file with the correct filename displayed."

→ **CSV 场景在 iOS Safari 里被描述为「提示 View / Download 并显示正确文件名」**（来自 bug 中的开发者实测陈述，属官方 bug 追踪系统的记录）。**PDF 场景会被预览**（同上）。

#### 4.2.2 「已添加到主屏 → 点击下载」的官方 bug 记录

**（a）Bug 209407 — 主屏应用里 `download` 静默失败（已修复）**
<https://bugs.webkit.org/show_bug.cgi?id=209407>，状态 `RESOLVED FIXED`，Reported **2020-03-22 16:41:55 PDT**。逐字（报告人 Tony Hursh）：

> "The download attribute works fine for me in both desktop and mobile Safari, as long as the page is loaded normally. **However, it fails when the page is installed to the device home screen.** ... It just fails silently. When I inspect it in a remote debugging console from desktop Safari, no errors are shown."
> Steps: "1) Load attached HTML file in mobile Safari. 2) **Add the page to the device home screen.** 3) Click the 'Click to prepare file' button to generate the file. 4) Click the 'Click to download file' link."
> Results: "Desktop Safari: works fine. **Mobile Safari when loaded as a normal web page: works fine. Mobile Safari when added to the home screen: fails silently.**"

WebKit 侧回应逐字（Brady Eidson，2020-03-24）：

> "**I highly suspect this is not a Webkit issue and is rather an issue with Apple internal app that hosts 'Save to home screen' web apps.** Running the radar by that team."

报告人后续（2020-12-20）逐字：

> "I just revisited this after some time, and **it appears that the bug/limitation has been fixed in (or possibly before) iOS 14.3. Marking as Resolved.**"

**（b）Bug 236943 — PWA 里点下载后「出不来」（已 MOVED，未在 WebKit 侧解决）**
<https://bugs.webkit.org/show_bug.cgi?id=236943>，状态 **`RESOLVED MOVED`**，Reported **2022-02-20 13:33:48 PST**。逐字：

> "When clicking an `<a>` with a download attribute, Safari asks which app should be used to open the file. **However, in an installed PWA the user becomes stranded with no way to go back other than force quitting and relaunching the app.**"
> Steps: "1) Visit https://safari-download-bug.surge.sh/ on an iPhone 2) Add the site to your home screen 3) Open it from the home screen 4) Click the link"
> "The app ends up on a file download screen ... with no other navigation. **Even the swipe back gesture doesn't work.** There should be a 'done' or 'back' button somewhere. Found on an iPhone X running iOS 15.2.1"

WebKit 侧处置逐字（Brent Fulgham，2022-06-23）：

> "This is actually tracked here: rdar://52460025. **Unfortunately, this is an issue outside of the WebKit project and cannot be resolved with a check-in for this project. Therefore, this is marked as 'RESOLVED | MOVED'.**"

（Bug 231892「Download link in Web.app is not possible to return from」，Reported 2021-10-18，**已标记为此 bug 的 duplicate**。）

**（c）Bug 275288 — 安装后的 PWA 下载行为与 Safari 不同（2024 年，被关闭为 Apple 内部处理）**
<https://bugs.webkit.org/show_bug.cgi?id=275288>，Reported **2024-06-07 19:31:03 PDT**。逐字（报告人 Laszlo，附了 `URL.createObjectURL` + `link.download` + `link.click()` 的完整复现代码）：

> "When visiting a PWA from Safari mobile and downloading a picture, the download prompt appears and asks the user to download, upon clicking it will save the file to downloads folder. **If you add/install the PWA to the Home screen, the download no longer works at all and shows no indication of a download.**"

复现补充逐字（Comment 2）：

> "**If you use Safari on iOS, the download popup occurs and allows you to click OK to download the file automatically. If you install the PWA on the homescreen, the popup is a preview of the file instead and the user has to click to save the file within the link.**"

WebKit 侧结论逐字（Karl Dubost，2024-06-24）：

> "**As currently shown, it (after discussions) seems the UI difference in between iOS and macOS is expected here.** Thanks a lot for reporting. **It doesn't depend on WebKit, so I will close it here. The radar will be addressed by the right team inside Apple.**"

后续追问逐字（2024-07-08）：

> "As it belongs to the Safari UI (and not the opensource WebKit part), **it's not possible** [to keep track of the moved bug]. Sorry about that."

**（d）官方博客中的相关表述（非直接针对 PWA 下载）**
**[官方明确]** Safari 13 发布说明（WebKit 官方博客）：<https://webkit.org/blog/9674/new-webkit-features-in-safari-13> 逐字：

> "Last but not least, **Safari includes support for background downloads, as well as background file uploads.** This new experience on iPad means significant changes for web developers to consider..."

→ 该句只说明 iOS/iPadOS 13 引入下载能力，**未涉及 PWA/standalone 行为**。

#### 4.2.3 「`Content-Disposition: attachment` 在 iOS Safari 是否可靠？」

**[未找到一手来源]**：Apple / WebKit 官方**没有**一份文档专门评估 `Content-Disposition: attachment` 在 iOS Safari 的可靠性。
- MDN 只写通用行为（§4.1，含「Firefox and Chrome decode [percent escapes], **while Safari does not**」这条与 Safari 直接相关的差异）。
- WebKit bugzilla 里与 iOS 下载行为相关的记录都围绕 `<a download>` 属性 / blob URL / PWA 场景，**没有**单独评估 `Content-Disposition: attachment` 响应头的案件。
- **→ 结论：无法给出「可靠 / 不可靠」的官方结论；标 [未找到一手来源] + [需实测]（§7 步骤 I1）。**

### 4.3 Blob URL 在 iOS 的已知限制

**[官方明确]** 来源：<https://bugs.webkit.org/show_bug.cgi?id=216918>（标题 `WKWebView does not support blob: URLs as href value in anchors with download attribute`；状态 **`RESOLVED CONFIGURATION CHANGED`**；采集 2026-09-17）

逐字（报告人，2019 年归入此 bug）：

> "I just realized that **the `download` attribute doesn't work with `blob:` URLs in WKWebView. In contrast, `data:` URLs work there.** ... Both methods work correctly in Safari itself."

后续关键结论逐字（Anne van Kesteren 复测）：

> "When I try `<a download=test>test</a><script>document.querySelector("a").href = URL.createObjectURL(new Blob());</script>` **on macOS and iOS Safari it downloads as expected.**"
> "The problem occurred in **`WKWebView`-based browsers like Chrome on iOS**. **I just tested on 17.3 beta, and it worked just fine. I'm marking this as RESOLVED.** Not sure when this started working, but it does…"
> "**CONFIGURATION CHANGED** is used when it's unclear where the fix happened."

同 bug 内的其它官方记录逐字：
- "**If you store files in indexDB ... as blob. Then i want to open them in browser as new tab. Its not working shows only info `WebKitBlobResource error 1`. I try `window.open(blob)`, also in js create and click and its not works in any browser.**"（社区报告，作为 bug 记录保留）
- "This issue creates webcompat issues for **Firefox on iOS**." （附 webcompat issue 链接）

**→ 对「`window.open(blobUrl)` 被拦截 / `WebKitBlobResource error 1`」的官方依据**：以上是该现象在 WebKit 官方 bug 追踪系统中的**唯一**一手记录，且**状态为已 RESOLVED（含 iOS 17.3 复测通过）**。
**→ 但注意范围**：这些记录针对 **WKWebView**（iOS 上的 Chrome / Firefox / 其它嵌入式 WebView）。**主屏 PWA 不是 WKWebView**，它由 Web.app 承载 —— WebKit 官方对 PWA 侧的问题一律判为「Apple 内部、非 WebKit」（§4.2.2）。**因此「iOS PWA 里 blob URL 下载是否可靠」= [未找到一手来源] + [需实测]。**

**Blob 的内存问题（[官方明确]，MDN）**：见 §4.1 —— `As long as there's one object URL active, the underlying object cannot be garbage-collected and may cause memory leaks.`（注意：MDN 未给「大 Blob 在 iOS 的内存阈值」任何数字 → **[未找到一手来源]**，见 §6-G8）。

---

## 5. CSV 与 JSON 作为导出格式的一手规范

### 5.1 RFC 4180（CSV）

**[官方明确]** 来源：<https://www.rfc-editor.org/rfc/rfc4180.txt>（**October 2005**，Category: Informational；采集 2026-09-17）

§2「Definition of the CSV Format」逐字（完整 7 条 + ABNF）：

> "1. **Each record is located on a separate line, delimited by a line break (CRLF).**"
> "2. The last record in the file **may or may not** have an ending line break."
> "3. There may be an **optional header line** appearing as the first line of the file with the same format as normal record lines. ... (the presence or absence of the header line should be indicated via the optional "header" parameter of this MIME type)."
> "4. Within the header and each record, there may be one or more fields, **separated by commas**. Each line should contain the same number of fields throughout the file. **Spaces are considered part of a field and should not be ignored.** The last field in the record must not be followed by a comma."
> "5. **Each field may or may not be enclosed in double quotes** (however some programs, such as Microsoft Excel, do not use double quotes at all). **If fields are not enclosed with double quotes, then double quotes may not appear inside the fields.**"
> "6. **Fields containing line breaks (CRLF), double quotes, and commas should be enclosed in double-quotes.**"
> "7. **If double-quotes are used to enclose fields, then a double-quote appearing inside a field must be escaped by preceding it with another double quote.** For example: `"aaa","b""bb","ccc"`"

ABNF 逐字：

```
file = [header CRLF] record *(CRLF record) [CRLF]
header = name *(COMMA name)
record = field *(COMMA field)
name = field
field = (escaped / non-escaped)
escaped = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE
non-escaped = *TEXTDATA
COMMA = %x2C
CR = %x0D
DQUOTE = %x22
LF = %x0A
CRLF = CR LF
TEXTDATA = %x20-21 / %x23-2B / %x2D-7E
```

§3 MIME 注册逐字：

> "MIME media type name: text / MIME subtype name: csv / **Required parameters: none** / Optional parameters: **charset, header**"
> "Common usage of CSV is **US-ASCII**, but other character sets defined by IANA for the 'text' tree may be used in conjunction with the 'charset' parameter."
> "Implementors choosing not to use this parameter must make their own decisions as to whether the header line is present or absent."
> "Encoding considerations: **As per section 4.1.1. of RFC 2046, this media type uses CRLF to denote line breaks. However, implementors should be aware that some implementations may use other values.**"
> "Interoperability considerations: **Due to lack of a single specification, there are considerable differences among implementations.**"

**「RFC 4180 是否定义了 NULL / 空值的表示？」**

**[官方明确] 否。** 全文（含 ABNF 与 MIME 注册段）**没有出现任何 NULL / null / empty 值的定义**：
- 唯一的「空」概念是 §6 允许字段内容为空（`a,,b` 这种），以及 ABNF 里 `non-escaped = *TEXTDATA` 的 `*`（零个或多个）——**即「空字段」在语法上是合法的，但规范没有赋予它任何语义**；
- **没有任何规则说明「空字段」应被读作 NULL 还是空字符串**；
- MIME 注册段的 `header`/`charset` 均不涉及空值语义。

→ **本票最关心的点（NULL 与空字符串不可区分）在 RFC 4180 层面是「规范缺失」（normative gap），不是「规范允许区分」。**

### 5.1b 权威来源是否讨论「CSV 无法区分 NULL 与空字符串」

**[官方明确]** 有 —— W3C 的 **Model for Tabular Data and Metadata on the Web**（W3C Recommendation，**17 December 2015**）来源：<https://www.w3.org/TR/tabular-data-model/>（采集 2026-09-17）

该规范用**两层模型**把「语法层 string value」与「语义层 value」分开，并**明确把空字符串默认映射为 null**。逐字：

§4.5 Cells（`value` 注释）：
> "**value** — the semantic value of the cell; this MAY be a list of values ... **By default, if the string value is an empty string, the semantic value of the cell is `null`.**"

§4.5 Cells（`string value` 注释）：
> "**string value** — a string that is the original syntactic representation of the value of the cell, e.g. how the cell appears within a CSV file; **this may be an empty string**."

§4.3 Columns（`null` 注释）：
> "**null** — **the string or strings which cause the value of cells having string value matching any of these values to be `null`.**"

§4.3 Columns（`default` 注释）：
> "**default** — the default value for cells whose **string value is an empty string**."

§4.5 Cells（**引号不改变模型** —— 这条直接回答了「`a,,z` vs `a,"",z`」）：
> "Note: **There presence or absence of quotes around a value within a CSV file is a syntactic detail that is not reflected in the tabular data model. In other words, there is no distinction in the model between the second value in `a,,z` and the second value in `a,"",z`.**"

§6.4 Parsing Cells（推导链）：
> "5. if the column separator annotation is not null and the normalized string is an empty string, the cell value is an empty list. ..."
> "7. **if the string is the same as any one of the values of the column null annotation, then the resulting value is `null`.**"

**→ 结论（可直接引用的规范依据）**：
1. CSV **文本本身**无法区分「NULL」与「空字符串」——RFC 4180 对此**未作规定**；
2. W3C 的规范化模型更明确：**空字符串在默认规则下就等于 `null`**，且 **加不加引号不改变语义**；
3. 若要在导出里保住 NULL，必须**额外带出 schema / metadata**（例如列级 `null` 注解或 `default` 注解），或改用能表达缺失的格式（JSON / SQLite dump）。

### 5.2 JSON：数字精度与 SQLite 64 位整数

**[官方明确]** RFC 8259（**December 2017**）来源：<https://www.rfc-editor.org/rfc/rfc8259.txt>（采集 2026-09-17）

§6 Numbers 的 ABNF 逐字：

```
number = [ minus ] int [ frac ] [ exp ]
decimal-point = %x2E       ; .
digit1-9 = %x31-39         ; 1-9
e = %x65 / %x45            ; e E
exp = e [ minus / plus ] 1*DIGIT
frac = decimal-point 1*DIGIT
int = zero / ( digit1-9 *DIGIT )
minus = %x2D               ; -
plus = %x2B                ; +
zero = %x30                ; 0
```

关于精度与范围的逐字：

> "Since software that implements **IEEE 754 binary64 (double precision)** numbers is generally available and widely used, good interoperability can be achieved by implementations that expect **no more precision or range than these provide**, in the sense that implementations will **approximate** JSON numbers within the expected precision."
>
> "**This specification allows implementations to set limits on the range and precision of numbers accepted.**"
>
> "**A JSON number such as 1E400 or 3.141592653589793238462643383279 may indicate potential interoperability problems**, since it suggests that the software that created it expects receiving software to have greater capabilities for numeric magnitude and precision than is widely available."
>
> "Note that when such software is used, **numbers that are integers and are in the range `[-(2**53)+1, (2**53)-1]` are interoperable in the sense that implementations will agree exactly on their numeric values.**"

§8.1 Character Encoding 逐字：`"JSON text exchanged between systems that are not part of a closed ecosystem MUST be encoded using UTF-8."`

**[官方明确]** RFC 7493（**The I-JSON Message Format**，Standards Track，**March 2015**）来源：<https://www.rfc-editor.org/rfc/rfc7493.txt>（采集 2026-09-17）§2.2 Numbers 逐字：

> "Software that implements IEEE 754-2008 binary64 (double precision) numbers is generally available and widely used. **Implementations that generate I-JSON messages cannot assume that receiving implementations can process numeric values with greater magnitude or precision than provided by those numbers.** I-JSON messages SHOULD NOT include numbers that express greater magnitude or precision than an IEEE 754 double precision number provides, for example, 1E400 or 3.141592653589793238462643383279."
>
> "**An I-JSON sender cannot expect a receiver to treat an integer whose absolute value is greater than 9007199254740991 (i.e., that is outside the range `[-(2**53)+1, (2**53)-1]`) as an exact value.**"
>
> "**For applications that require the exact interchange of numbers with greater magnitude or precision, it is RECOMMENDED to encode them in JSON string values.** This requires that the receiving program understand the intended semantic of the value. **An example would be 64-bit integers, even though modern hardware can deal with them, because of the limited scope of JavaScript numbers.**"

**[官方明确]** SQLite INTEGER 的类型定义：<https://sqlite.org/datatype3.html>（页面未显示 last modified；采集 2026-09-17）§2 逐字：

> "**INTEGER**. The value is a **signed integer, stored in 0, 1, 2, 3, 4, 6, or 8 bytes** depending on the magnitude of the value."
> "**REAL**. The value is a floating point value, stored as an **8-byte IEEE floating point number**."
> "A storage class is more general than a datatype. ... **as soon as INTEGER values are read off of disk and into memory for processing, they are converted to the most general datatype (8-byte signed integer).**"
> （NUMERIC 亲和性段）"If the TEXT value is a well-formed integer literal that is **too large to fit in a 64-bit signed integer, it is converted to REAL**."
> （REAL 亲和性段）"A column with **REAL affinity** behaves like a column with NUMERIC affinity except that **it forces integer values into floating point representation.**"
> （REAL/数值精度）"For conversions between TEXT and REAL storage classes, **about 15.95 significant decimal digits** of the number are preserved. (The conversion accuracy is limited by the use of **IEEE 754 binary64 or "double"** encoding for floating-point values.)"
> 另（§2.1 Boolean）：`"SQLite does not have a separate Boolean storage class. Instead, Boolean values are stored as integers 0 (false) and 1 (true)."`

**→ 「JSON 能否无损表达 SQLite 的 64 位整数？金额存整数分能否经 JSON 往返不失真？」的规范依据链**：

1. SQLite INTEGER 是 **8-byte signed**，即范围约 **±9.22×10¹⁸**；
2. JSON 数字规范只保证 **IEEE 754 binary64**，精确整数区间只有 **`[-(2^53)+1, (2^53)-1]` = ±9,007,199,254,740,991**（约 ±9.0×10¹⁵）；
3. RFC 7493 逐字点名：**64 位整数**属「需要精确互换但超出 double 精度」的典型，应 **encode them in JSON string values**；
4. **所以：**
   - 若「金额存整数分」且日常金额上限在 **±9×10¹⁵ 分（≈ ±90 万亿元）** 之内 → **落在 2^53 安全区内，JSON 数字可无损**（但**这不是**「JSON 天生无损」，而是「数值够小」）；
   - 若列里可能承载**真正的 64 位值**（如毫秒级 epoch、雪花 ID、哈希切片的整数表示）→ **JSON 数字不保证无损，须以字符串承载**（RFC 7493 明文 RECOMMENDED）；
   - 另一条独立的坑：**SQLite 的 REAL 亲和性列会把整数强制转成浮点**（上面逐字），所以「用 REAL 存金额」走 JSON 也有精度风险 —— 「金额存整数分」正是规避它的办法。

### 5.3 汇总：格式决策相关的一手事实（不构成选择建议）

| 维度 | CSV（RFC 4180） | JSON（RFC 8259 / 7493） |
|---|---|---|
| 编码 | 未强制（`Common usage of CSV is US-ASCII`，可带 `charset`） | 跨系统交换 **MUST be UTF-8**；禁止 BOM |
| 行终止 | CRLF（`this media type uses CRLF to denote line breaks`），但 `some implementations may use other values` | 无（结构由括号界定） |
| 转义 | 双引号包裹 + `""` 转义；未引号字段内不得出现双引号 | 字符串转义（`\"` 等） |
| 类型信息 | **无**（`Required parameters: none`；规范不携带类型） | 有 4 种基本类型（object/array/number/string）+ `true`/`false`/`null` |
| NULL 表示 | **未定义**（规范缺失）；W3C 模型默认「空串 = null」 | 有 `null` 字面量 |
| 大整数 | 天然安全（文本） | **不安全**（>2^53-1 需转字符串，RFC 7493 明文） |
| 官方对互操作的告诫 | `"Due to lack of a single specification, there are considerable differences among implementations."` | `"implementations will approximate JSON numbers within the expected precision"` |

---

## 6. 未找到 / 未证实 / 需实测

### 6.1 缺口清单

| # | 缺口 | 状态 | 影响 |
|---|---|---|---|
| G1 | **流式响应期间的时间是否计入 CPU 的逐字说明** | **[未找到一手来源]** 官方只有 `CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests ... does not count` + `A Worker that is still streaming a response body remains active.` 两句可拼 | 决定候选 B 能否把「大导出的等待」移出 10 ms 预算（推测可以，但无逐字背书） |
| G2 | **Workers Free 能否用 `send_email` 主动发信** | **[官方明确但自相矛盾]**：定价表 `Outbound emails (Email Sending) = Not available` vs 三处正文「发往 verified destination 在任何 plan 都免费」。三页日期 Jun 9, 2026 / Jun 9, 2026 / Sep 16, 2026，采集 2026-09-17 | 直接决定候选 C 的「推邮箱」分支是否存在 |
| G3 | **R2 免费额度是否强制绑卡** | **[未找到一手来源]** 只有 `Complete the checkout flow to add an R2 subscription`；billing 文档把 R2 列为 usage-based subscription（隐含挂在支付方式上），但无逐字「需绑卡」 | 与用户「不愿绑卡」硬约束直接冲突 |
| G4 | **KV 是否需要绑卡** | **[未找到一手来源]** 只有「Workers Free plan includes limited usage of ... Workers KV」 | 同上 |
| G5 | **D1 单次 SELECT 的结果集行数上限 / 超出行为（报错 or 截断）** | **[未找到一手来源]** 官方正面无任何数字；只有 30 s 查询时长、128 MB 内存、单表行数 Unlimited | 直接决定「能否一次性读全表」 |
| G6 | **KV 的最终一致性（eventual consistency）逐字表述与传播延迟** | **[未证实]** 本次未逐字核到（KV limits/pricing 页未涉一致性） | 若用 KV 存备份，读到的可能是旧版本 |
| G7 | **`db.batch()` 一次最多几条语句** | **[未找到一手来源]**（与既有笔记 `cloudflare-runtime-fetch-facts.md` §4 结论一致） | 影响「分批读」时一次能塞多少 SQL |
| G8 | **iOS Safari 上 `Content-Disposition: attachment` 的可靠性** | **[未找到一手来源]** Apple/WebKit 无专门文档；MDN 只有通用行为 + 「Safari 不解码 filename 里的 percent escape」 | 主用场景（iPhone PWA）的下载可用性核心风险 |
| G9 | **iOS PWA（standalone）里下载是否可用** | **[官方明确但均为 bug 记录，非规范]** bug 209407（iOS 14.3 前静默失败→已 FIXED）/ bug 236943（下载后无法返回，**MOVED 给 Apple**）/ bug 275288（与 Safari 行为不同，**关闭为 Apple 内部**）。**无「当前 iOS 版本的行为」官方声明** | 同上，必须实测 |
| G10 | **大 Blob 在 iOS 的内存阈值 / `window.open(blobUrl)` 被拦截** | **[未找到一手来源] 具体阈值**；现象在 WebKit bug 216918 有记录但状态为已 RESOLVED（iOS 17.3 复测通过），且该案的 WKWebView 语境**不能直接外推到主屏 PWA** | 决定候选 A（Blob 拼文件）在 iPhone 上的可行边界 |
| G11 | **Workers 调用第三方 API 是否有「禁止此类用途」的专门条款** | **[未找到一手来源]** 只有 Self-Serve 协议 2.2.1(c)(j) 两条通用条款 | 影响候选 C 的第三方网盘分支的合规判断 |
| G12 | **D1 的 SQL 解析是否计入 Workers CPU** | **[未找到一手来源]** Workers 页说 database queries 等待不计；D1 页说 query execution 受 Workers CPU 限制 → 两页口径张力 | 影响 CPU 预算估算 |
| G13 | **「CPU 时间估算 / 常见操作耗时表」** | **[未找到一手来源]** 官方全站只有 `The average Worker uses approximately 2.2 ms per request` 与 `10-20 ms` 的粗描述 | 无法先验估算导出所需 CPU |
| G14 | **Contents API 创建/更新端点自身的逐字文件大小上限** | **[未找到一手来源]** 只有仓库层面的 50 MiB / 100 MiB / 浏览器 25 MiB，以及 Get 端点的 1 MB / 100 MB 分档 | 影响「推 GitHub」分支的文件切分策略 |
| G15 | **GitHub 官方「PAT vs GitHub App 决策表」** | **[未找到一手来源]** 差异由 PAT 页 + Rate limits 页并列得出 | 影响凭证形态选择 |
| G16 | **Cloudflare Pages 侧是否明文继承「Responses body size: No enforced limit」与 Streams 能力** | **[官方间接]** Pages Functions 计 Workers 配额、跑同一运行时，但 Pages 文档未逐字重复这两条 | 本文件按 [官方间接] 处理 |

### 6.2 明确不作为结论依据的来源

- 本次检索**未采用**任何二手博客 / 社区帖子 / 知乎 / 掘金 / CSDN / Medium 作为结论依据。
- 唯一涉及的社区文本是 **WebKit bugzilla 内**开发者与用户贴出的复现描述（如 bug 216918 内的社区评论）—— 这些属**官方 bug 追踪系统内的原始记录**，但**已明确标注为「bug 内报告人陈述」而非 WebKit 团队结论**。

---

## 7. 可执行的实测方法（部署一次即可回答大部分缺口）

```bash
BASE=https://<your-project>.pages.dev      # 或自定义域

# ── D1 / 大响应侧 ──────────────────────────────────────────────
# D1: 单次读全表，观察 meta.rows_read / duration / 是否报错（回答 G5）
#   把 limit 逐步加大：1k → 1w → 10w → 全表
npx wrangler d1 execute <DB> --remote --json \
  --command "SELECT COUNT(*) AS n FROM transactions;"
npx wrangler d1 execute <DB> --remote --json \
  --command "SELECT * FROM transactions LIMIT 100000;"

# D2: 走 Worker 路由读全表，看 Error 1102 / 内存错误（回答 G1/G5）
curl -s -o /tmp/exp.json -w '%{http_code} %{size_download}\n' \
  "$BASE/api/export?format=json&full=1"
head -c 200 /tmp/exp.json

# D3: 流式版对照（若实现了 ReadableStream），用 -N 关闭缓冲看首个字节时间
curl -sN -o /dev/null -w 'ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}\n' \
  "$BASE/api/export?format=json&stream=1"

# ── Email 侧（回答 G2，最关键的一个冲突）─────────────────────
# E1: 先确认 destination address 已验证，然后在 Free plan 的 Worker 里跑：
#    await env.EMAIL.send({ to: "<your-verified-address>", from: "<you@your-routing-domain>", ... })
#    观察：① 是否抛 E_SENDER_NOT_VERIFIED / 授权类错误；
#          ② Dashboard → Email Service → 发送指标里是否记为已投递。
#    注意官方原话：send_email 发出的邮件在 Email Routing summary 里会显示为 "dropped"，
#    即使投递成功 —— 必须看 Email sending metrics 而不是 Routing summary。

# ── R2 / KV 侧（回答 G3 / G4）─────────────────────────────────
# R2: 在 Dashboard → Storage & databases → R2 → Overview 点开通，
#     记录 checkout 是否强制要求支付方式（不实际付款，只记录被拦在哪一步）。
# KV: Dashboard → Storage & databases → KV 直接建 namespace，
#     若不要求支付方式即可创建 → Free 可用；再 put 一个 26 MiB 的值验证 25 MiB 硬上限。

# ── iOS / PWA 侧（回答 G8 / G9 / G10，必须在真机做）──────────
# I1: iPhone Safari 直接打开：
#     （a）一个返回 Content-Disposition: attachment; filename="x.csv" 的端点
#     （b）一个 <a href="blob:..." download="x.csv"> 的页面
#     记录：是否出现「查看/下载」提示、保存到「文件」App 的路径、文件名是否被改成 Unknown/document。
# I2: 把 (b) 加到主屏，从主屏图标打开后重复步骤 I1。
#     记录：是否出现 bug 236943 的「卡在下载页无法返回」；
#           或 bug 275288 的「变成预览而非下载」。
# I3: 在 PWA 里试 window.open(blobUrl) 与 navigator.share({files:[...]})，
#     记录 navigator.canShare({files:[new File([...],'x.csv',{type:'text/csv'})]}) 的返回值。
# I4: 大 Blob：尝试 5 MB / 20 MB / 50 MB 三档，观察是否触发 WebKitBlobResource error 1 或页面崩溃。
```

---

## 8. 来源清单（含 Last updated / 版本日期与采集日期）

| 来源 | URL | 类型 | 页面自报日期 | 采集日期 |
|---|---|---|---|---|
| Workers · Limits（响应体/CPU/内存/时长/子请求/Cron） | <https://developers.cloudflare.com/workers/platform/limits/> | 官方文档 | Last updated **Sep 5, 2026** | 2026-09-17 |
| Workers · Streams（Runtime API） | <https://developers.cloudflare.com/workers/runtime-apis/streams/> | 官方文档 | 未显示 | 2026-09-17 |
| Workers · Stream large JSON（example） | <https://developers.cloudflare.com/workers/examples/streaming-json/> | 官方文档 | Last updated **Apr 23, 2026** | 2026-09-17 |
| Workers · Encoding（TextEncoder/TextDecoder） | <https://developers.cloudflare.com/workers/runtime-apis/encoding/> | 官方文档 | 未显示 | 2026-09-17 |
| Workers · How Workers works | <https://developers.cloudflare.com/workers/reference/how-workers-works/> | 官方文档 | Last updated **Apr 23, 2026** | 2026-09-17 |
| Workers · Best Practices（stream 建议） | <https://developers.cloudflare.com/workers/best-practices/workers-best-practices> | 官方文档 | 未显示 | 2026-09-17 |
| Workers · Pricing（Free plan 含 KV/Hyperdrive） | <https://developers.cloudflare.com/workers/platform/pricing/> | 官方文档 | 未显示 | 2026-09-17 |
| Workers · Changelog（子请求上限变更） | <https://developers.cloudflare.com/changelog/product-group/developer-platform/12/> | 官方 Changelog | 条目 **Feb 11, 2026** | 2026-09-17 |
| D1 · Limits | <https://developers.cloudflare.com/d1/platform/limits/> | 官方文档 | Last updated **Apr 21, 2026** | 2026-09-17 |
| D1 · Prepared statement methods（`run` / `raw` / `first`） | <https://developers.cloudflare.com/d1/worker-api/prepared-statements/> | 官方文档 | Last updated **Jun 22, 2026** | 2026-09-17 |
| D1 · Wrangler commands（`d1 execute` / `d1 export`） | <https://developers.cloudflare.com/d1/wrangler-commands/> | 官方文档 | Last updated **Apr 21, 2026** | 2026-09-17 |
| D1 · FAQs（CLI 计数、序列化计费、超配额行为） | <https://developers.cloudflare.com/d1/reference/faq/> | 官方文档 | 未显示 | 2026-09-17 |
| D1 · Query D1 Database（HTTP API，`meta.rows_read`） | <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/> | 官方 API 参考 | 未显示 | 2026-09-17 |
| KV · Limits | <https://developers.cloudflare.com/kv/platform/limits/> | 官方文档 | Last updated **Apr 21, 2026** | 2026-09-17 |
| KV · Pricing | <https://developers.cloudflare.com/kv/platform/pricing/> | 官方文档 | Last updated **Apr 21, 2026** | 2026-09-17 |
| R2 · Pricing（Free tier） | <https://developers.cloudflare.com/r2/pricing/> | 官方文档 | Last updated **Aug 7, 2026** | 2026-09-17 |
| R2 · Get started（需 R2 subscription + checkout） | <https://developers.cloudflare.com/r2/get-started/> | 官方文档 | Last updated **Apr 21, 2026** | 2026-09-17 |
| R2 · Limits | <https://developers.cloudflare.com/r2/platform/limits/> | 官方文档 | Last updated **Jun 8, 2026** | 2026-09-17 |
| Email Service · Pricing（Free/Paid 表 + verified destination 免费） | <https://developers.cloudflare.com/email-service/platform/pricing/> | 官方文档 | Last updated **Jun 9, 2026** | 2026-09-17 |
| Email Service · Limits（投递配额、邮件大小、verified destination） | <https://developers.cloudflare.com/email-service/platform/limits/> | 官方文档 | Last updated **Sep 16, 2026** | 2026-09-17 |
| Email Service · Workers API（`send_email` binding、`send()`） | <https://developers.cloudflare.com/email-service/api/send-emails/workers-api/> | 官方文档 | Last updated **Sep 16, 2026** | 2026-09-17 |
| Email Service · Configure send bindings | <https://developers.cloudflare.com/email-service/configuration/send-bindings/> | 官方文档 | Last updated **Jun 9, 2026** | 2026-09-17 |
| Email Service · Email routing rules and addresses | <https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/> | 官方文档 | Last updated **Jun 9, 2026** | 2026-09-17 |
| Cloudflare · Self-Serve Subscription Agreement（2.2.1 限制条款） | <https://www.cloudflare.com/terms/> | 官方法律条款 | 未显示 | 2026-09-17 |
| Cloudflare Billing · Resolve "cannot remove payment method"（R2 属 usage-based subscription） | <https://developers.cloudflare.com/billing/resolve-cannot-remove-payment-method/> | 官方文档 | 未显示 | 2026-09-17 |
| Cloudflare Billing · FAQ（plan vs subscription 定义） | <https://developers.cloudflare.com/billing/understand/faq> | 官方文档 | 未显示 | 2026-09-17 |
| GitHub Docs · About large files on GitHub（50 MiB / 100 MiB / 25 MiB） | <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github> | 官方文档 | 未显示 | 2026-09-17 |
| GitHub Docs · REST Repos Contents（Create or update file contents；Get 的 1 MB / 100 MB 分档） | <https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10> | 官方 API 参考 | API version **2026-03-10** | 2026-09-17 |
| GitHub Docs · Rate limits for the REST API | <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10> | 官方文档 | API version **2026-03-10** | 2026-09-17 |
| GitHub Docs · Managing your personal access tokens | <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens> | 官方文档 | 未显示 | 2026-09-17 |
| MDN · `<a>` element（`download` 属性） | <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a> | MDN | Baseline 自 2015-07 | 2026-09-17 |
| MDN · `Content-Disposition` header | <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition> | MDN | Baseline 自 2015-07 | 2026-09-17 |
| MDN · `URL.createObjectURL()` | <https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static> | MDN | Baseline 自 2015-07 | 2026-09-17 |
| MDN · `blob:` URLs（内存管理 / 存储分区 / Range） | <https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob> | MDN | Baseline 自 2015-07 | 2026-09-17 |
| MDN · `Navigator.share()` | <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share> | MDN | 未显示 | 2026-09-17 |
| WebKit Bugzilla 167341（iOS 13.0 加入 download 属性支持） | <https://bugs.webkit.org/show_bug.cgi?id=167341> | WebKit 官方 | Reported **2017-01-23**；RESOLVED FIXED | 2026-09-17 |
| WebKit Bugzilla 209407（主屏应用 download 静默失败 → iOS 14.3 修复） | <https://bugs.webkit.org/show_bug.cgi?id=209407> | WebKit 官方 | Reported **2020-03-22**；RESOLVED FIXED | 2026-09-17 |
| WebKit Bugzilla 236943（PWA 下载后无法返回；MOVED 给 Apple） | <https://bugs.webkit.org/show_bug.cgi?id=236943> | WebKit 官方 | Reported **2022-02-20**；RESOLVED MOVED | 2026-09-17 |
| WebKit Bugzilla 275288（安装后 PWA 下载行为不同；关闭为 Apple 内部） | <https://bugs.webkit.org/show_bug.cgi?id=275288> | WebKit 官方 | Reported **2024-06-07** | 2026-09-17 |
| WebKit Bugzilla 216918（WKWebView `blob:` + download；iOS 17.3 复测通过） | <https://bugs.webkit.org/show_bug.cgi?id=216918> | WebKit 官方 | RESOLVED CONFIGURATION CHANGED | 2026-09-17 |
| WebKit Blog · New WebKit Features in Safari 13 | <https://webkit.org/blog/9674/new-webkit-features-in-safari-13> | WebKit 官方博客 | 2019（Safari 13） | 2026-09-17 |
| RFC 4180 · Common Format and MIME Type for CSV Files | <https://www.rfc-editor.org/rfc/rfc4180.txt> | IETF RFC | **October 2005** | 2026-09-17 |
| RFC 8259 · The JavaScript Object Notation (JSON) Data Interchange Format | <https://www.rfc-editor.org/rfc/rfc8259.txt> | IETF RFC | **December 2017** | 2026-09-17 |
| RFC 7493 · The I-JSON Message Format | <https://www.rfc-editor.org/rfc/rfc7493.txt> | IETF RFC | **March 2015** | 2026-09-17 |
| W3C · Model for Tabular Data and Metadata on the Web（null / empty string 语义） | <https://www.w3.org/TR/tabular-data-model/> | W3C Recommendation | **17 December 2015** | 2026-09-17 |
| SQLite · Datatypes In SQLite（INTEGER 8-byte / REAL 亲和性） | <https://sqlite.org/datatype3.html> | SQLite 官方 | 页面未显示 | 2026-09-17 |

---

## 9. 与本仓库既有笔记的关系

- 本文件**不重复** `cloudflare-free-tier-constraints.md`（Free 限额总表 / Pages Functions 能力边界 / Access）、`cloudflare-runtime-fetch-facts.md`（TextDecoder GBK / fetch 超时 / 子请求 / batch 参数限额）、`cloudflare-pages-static-layer-facts.md`（`_routes.json` / `_headers` / SPA fallback）、`cloudflare-cron-and-timezone-facts.md`（Cron 配额 / 时区 / Queues）。
- 本文件**新增**（既有笔记未记录）：
  1. 「Response body size: **No enforced limit**」与 `Cloudflare does not enforce response body size limits.` 的**逐字原文**；
  2. Streams 专页的**逐字**表述、`TransformStream` 官方示例、以及「**流式期间不计 CPU 无逐字说明**」这个缺口；
  3. 内存 128 MB 是 **per-isolate, not per-invocation** 的**逐字**原文；
  4. D1 **结果集行数上限官方无明文**（正面结论）与「改动海量行须分批」的**逐字**原文；
  5. GitHub Contents API / rate limit / PAT vs App 的**官方数字与限制**；
  6. Cloudflare **Email Service** 的 Free/Paid 发信能力，以及**官方自身的矛盾表述**；
  7. Cloudflare Self-Serve 协议 2.2.1(c)(j) 的**逐字**条款；
  8. **KV 单值 25 MiB 硬上限** 与 Free 读写删 list 的**逐字**配额；
  9. **iOS Safari / iOS PWA 下载行为的 WebKit 官方 bug 记录**（4 个 bug，含日期、状态、团队结论）；
  10. **RFC 4180 未定义 NULL**、**W3C 表格模型「空串 = null」**、**RFC 7493 对 64 位整数须用字符串**的三条规范级依据。
- 一处**结论加固**：既有笔记 `cloudflare-runtime-fetch-facts.md` §4 说「batch 条数上限官方未给数字」，本文件在 D1 Limits 页复核后**再次确认**（G7）。
