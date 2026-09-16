# 一手事实调研：鉴权选型相关（Cloudflare Pages Functions / Workers / D1 / PSL）

> 产出票：#9 «鉴权与访问控制方案»（本报告是其证据链的一手部分）

- **采集日期**：2026-09-16（以下所有 URL 均于该日访问）
- **范围**：Cloudflare 官方文档（developers.cloudflare.com、www.cloudflare.com）、cloudflare/workerd 仓库（源码 + commit + issue）、publicsuffix.org / publicsuffix/list 仓库、IETF draft。**二手博客、知乎/掘金转述、DeepWiki 等一律未采信**。
- **版本依赖**：workerd 引文取自 `main` 分支快照（2026-09-16）与指定 commit；Cloudflare 文档页面自带的 “Last updated” 逐条标注；仓库侧 `compatibility_date` / workerd 版本号在本项目**尚未确定**（票面未给），故未绑定具体版本。
- **取证限制（重要）**：本环境只能通过网页抓取工具取文，**无法 `curl`/`grep`**。`public_suffix_list.dat` 全文过大，单次抓取被截断到 ICANN 段中部（PRIVATE 段在文件末尾），因此 PSL 的「当前文件逐字行」未能直接取得，改用 PSL 官方 commit（该条目的入库 commit）作为逐字证据，并标注核验缺口（见 §3、§7）。

---

## 1. CPU 时间限制：免费版 vs Paid 版，CPU time 与 wall clock 的区分，IO 是否计入，Pages Functions 是否同一套

**结论（一句话）**：官方数字是 `CPU time per HTTP request` = **Free 10 ms / Paid 5 min（默认 30 s）**；官方明确定义 **await 网络 IO 不计入 CPU time**；Pages Functions 官方口径是「按 Workers 计费/占用 Workers 配额」，但**文档中没有任何一句逐字写明 “Pages Functions 的 CPU 上限是 10 ms/5 min”**（见下方缺口）。

**证据**

1. Workers 计划额度表（Free / Paid 两列）：
   > “Requests 100,000/day | No limit”
   > “CPU time 10 ms | 5 min”
   
   来源：https://developers.cloudflare.com/workers/platform/limits/ （页面未显示 Last updated；抓取于 2026-09-16）
2. CPU time 的定义与「IO 不计入」：
   > “CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time.”
   > “Limit | Workers Free | Workers Paid — CPU time per HTTP request | 10 ms | 5 min (default: 30 seconds) — CPU time per Cron Trigger | 10 ms | 30 seconds (< 1 hour interval) / 15 min (>= 1 hour interval)”
   
   同上 URL。
3. wall clock time 的定义（与 CPU time 的区分原文）：
   > “Wall time (also called wall-clock time) is the total elapsed time from the start to end of an invocation, including time spent waiting on network requests, I/O, and other asynchronous operations. This is distinct from CPU time, which only measures time the CPU spends actively executing your code.”
   > “Duration measures wall-clock time from start to end of a Worker invocation.” 表：`HTTP request | No limit`；`Cron Trigger | 15 min`；`Durable Object Alarm | 15 min`；`Queue Consumer | 15 min`
   
   同上 URL（“Wall time limits by invocation type” 与 “Duration” 两节）。
4. 超限的表现：
   > “When a Worker exceeds its CPU time limit, Cloudflare returns Error 1102 to the client with the message `Worker exceeded resource limits`… In analytics and Logpush, the invocation outcome is `exceededCpu`.”
   
   同上 URL。
5. Pages Functions 适用同一套（三条官方原文，均为「计费/配额/失败」口径，非「CPU 数字」口径）：
   - Pages Functions Pricing（页面 Last updated **Sep 8, 2026**）：
     > “Requests to your Functions are billed as Cloudflare Workers requests. Workers plans and pricing can be found in the Workers documentation.”
     > “Requests to your Pages Functions count towards your quota for the Workers Free plan. For example, you could use 50,000 Functions requests and 50,000 Workers requests to use your full 100,000 daily request usage. The free plan daily request limit resets at midnight UTC.”
     
     https://developers.cloudflare.com/pages/functions/pricing/
   - Workers Pricing（明确把 Pages Functions 并入 Workers 定价文档）：
     > “All Pages Functions are billed as Workers. All pricing and inclusions in this document apply to Pages Functions.”
     
     https://developers.cloudflare.com/workers/platform/pricing/
   - Pages Limits（页面 Last updated 未显示；抓取于 2026-09-16）：
     > “Requests to Pages functions count towards your quota for Workers plans, including requests from your Function to KV or Durable Object bindings.”
     > “Pages supports the Standard usage model.”
     
     https://developers.cloudflare.com/pages/platform/limits/
   - Pages Known issues（Last updated **May 6, 2026**）侧面确认 Pages Functions 会撞 CPU 上限：
     > “any critical failures (such as exceeding CPU time or exceeding memory) may still throw an error.”
     
     https://developers.cloudflare.com/pages/platform/known-issues/
6. Cron Worker 的免费额度（与独立 Cron Worker 直接相关）：
   > “CPU time per Cron Trigger | 10 ms | 30 seconds (< 1 hour interval) / 15 min (>= 1 hour interval)”
   > “Number of Cron Triggers per account | 5 | 250”
   
   https://developers.cloudflare.com/workers/platform/limits/

**缺口（如实记录）**：官方**没有**任何一句 «Pages Functions 的 CPU time 上限 = 10 ms» 的逐字表述。可得到的最近表述是第 5 条的三句（计费与配额对齐 Workers）+ 第 5 条最后一句（Pages Functions 会因 CPU 超限失败）。把「Pages Functions 的 CPU 上限等同 Workers 的 10 ms/请求」当作已确证的数字，属于**推断**（见 §8 第 2 条）。

---

## 2. workerd / Workers 的 WebCrypto 与 PBKDF2：是否支持、迭代次数硬上限、有无官方基准

**结论（一句话）**：WebCrypto 明确支持 `deriveBits/deriveKey` 的 **PBKDF2**；workerd 侧存在**可配置的 PBKDF2 迭代次数上限常量 `DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000`**（默认行为即拒绝 >100,000），Cloudflare 生产环境**截至 2026-09-16 仍未放开**该 100,000 上限；官方/仓库中**未找到任何「某迭代次数 → 多少 ms」的基准数字**。

**证据**

1. 支持 PBKDF2（官方文档原文）：
   > “Workers implements all operations of the WebCrypto standard, as shown in the following table.”
   > 算法表含 `PBKDF2 ✓ ✓`（对应 `deriveBits()` / `deriveKey()` 两列）
   > “Performing cryptographic operations using the Web Crypto API is significantly faster than performing them purely in JavaScript. If you want to perform CPU-intensive cryptographic operations, you should consider using the Web Crypto API.”
   
   https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ （Last updated **Apr 23, 2026**）
2. workerd 源码中的上限常量与判定（`main` 分支快照，2026-09-16 抓取）：
   > `static constexpr size_t DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000;`
   > `static constexpr uint64_t DEFAULT_MAX_SCRYPT_COST = 1u << 20;`
   > “// Called when performing a crypto key derivation function (like pbkdf2) to determine if if the requested number of iterations is acceptable. If kj::none is returned, the number of iterations requested is acceptable. If a number is returned, the requested iterations is unacceptable and the return value specifies the maximum.”
   > `if (iterations > DEFAULT_MAX_PBKDF2_ITERATIONS) return DEFAULT_MAX_PBKDF2_ITERATIONS; return kj::none;`
   > “// By default, historically we've limited this to 100,000 iterations max. We'll set that as the default for now. To set a default of no-limit, this would be changed to return kj::none. Note, this current default limit is *WAY* below the recommended minimum iterations for pbkdf2.”
   > scrypt：`virtual kj::Maybe<uint64_t> checkScryptCost(...)` — “Saturate to avoid overflow in the product.” `if (cost > DEFAULT_MAX_SCRYPT_COST) return DEFAULT_MAX_SCRYPT_COST;`（即 **N×r×p ≤ 2^20**）
   
   https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/limit-enforcer.h （`main` 快照）
3. 该机制的引入 commit（逐字引 patch）：
   - commit message：
     > “Introduce configurable pbkdf2 iteration limit — Introduces the ability for workerd embedders to configure the max iteration limit for KDFs. Removes the limit for workerd by default. Keeps the current limit of 100,000 when not configured.”
   - 改动前（硬编码）：
     > `JSG_REQUIRE(iterations <= 100000, DOMNotSupportedError, "PBKDF2 iteration counts above 100000 are not supported (requested ", iterations, ").");`
   - 改动后新增的函数：
     > `void checkPbkdfLimits(jsg::Lock& js, size_t iterations) { if (js.getEmbedderData() == nullptr) { JSG_REQUIRE(iterations <= DEFAULT_MAX_PBKDF2_ITERATIONS, DOMNotSupportedError, kj::str("Pbkdf2 failed: iteration counts above 100000 are not supported (requested ", iterations, ").")); return; } auto& limits = Worker::Isolate::from(js).getLimitEnforcer(); KJ_IF_SOME(max, limits.checkPbkdfIterations(js, iterations)) { JSG_FAIL_REQUIRE(DOMNotSupportedError, kj::str("Pbkdf2 failed: iteration counts above ", max ," are not supported (requested ", iterations, ").")); } }`
   - workerd 独立运行时（standalone）显式放开：
     > `kj::Maybe<size_t> checkPbkdfIterations(jsg::Lock& lock, size_t iterations) const override { // No limit on the number of iterations in workerd  return kj::none; }`
   - 日期：commit `804c596682642f30d6ad5b15d8f774036eab16a6`（GitHub commit 页显示 jasnell committed **Dec 15, 2023**）；同一 message 的 merge sha `12bc98a9168609b2de328de4f49f80aaef0b8bf7` 的 committer 日期为 **2023-12-21**（作者日期 2023-12-04）。
   - URL：https://github.com/cloudflare/workerd/commit/804c596682642f30d6ad5b15d8f774036eab16a6 ；https://api.github.com/repos/cloudflare/workerd/commits?path=src/workerd/api/crypto-impl-pbkdf2.c%2B%2B
   - 路径变动：相关实现文件当时为 `src/workerd/api/crypto-impl-pbkdf2.c++`；2024-06-24 的 commit 把 `api/crypto.h|c++` 移到 `api/crypto/` 下（“Move api/crypto.h|c++ to api/crypto/crypto.h|c++ (#2318)”）。
4. 生产环境仍未放开（workerd issue #1346，官方人员逐字回复 + 用户近期复现）：
   > kentonv, **2023-10-30**：“Since our CPU time-limiting code cannot interrupt BoringSSL in the middle of running PBKDF, we have to limit the iterations upfront. But, these days most Workers have a 30s time limit so we should be able to increase the limit on PBKDF2 much higher for workers with such a higher limit.”
   > jasnell, **2024-01-03**：“A change has been landed that makes the max iteration count configurable in `workerd`, with the default max iteration count *removed* in workerd. However, **in the production environment the current limit will remain for at least some period of time**.”
   > jasnell, **2024-04-19**：“Not yet. @irvinebroque we should prioritize figuring out when/how to raise the limits in production based on the change that was landed.”
   > 用户 akshaybabloo, **2026-01-26**：“I just had this error on the workers side, when I set the iterations to 210000.”
   > 用户 paulh-rnd, **2026-08-19**（该 issue 抓取范围内最后一条）：“Came here after discovering this issue as well, is this likely to ever be fixed or should we be looking at alternatives?”
   > **该 issue 中 Cloudflare 侧最后一条回复是 2024-04-19；此后至 2026-09-16 无官方状态更新。**
   
   https://github.com/cloudflare/workerd/issues/1346 ；逐条日期取自 https://api.github.com/repos/cloudflare/workerd/issues/1346/comments （抓取于 2026-09-16）
5. 基准数字：**未找到官方或 workerd 仓库中的 PBKDF2 耗时基准**。Cloudflare 官方组织仓库 `cloudflare/worker-performance-examples` 的 PBKDF2 示例只给出参数、无计时：
   > `crypto.subtle.deriveBits({ name: "PBKDF2", salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 15000, hash: {name: "SHA-512"} }, key, 256)`
   
   https://raw.githubusercontent.com/cloudflare/worker-performance-examples/master/pbkdf2/worker.js （repo `default_branch` = `master`；根目录无 README，故无可引用的公布结果：https://api.github.com/repos/cloudflare/worker-performance-examples/contents/）

---

## 3. `pages.dev` 与 Cookie：是否在 PSL、能否设 Domain 级 Cookie、是否有官方 Pages Cookie 说明、是否强制 HTTPS

**结论（一句话）**：`pages.dev` **确实由 Cloudflare 提交进了 PSL 的 PRIVATE 段**（2020-09-08，commit “Add pages.dev (#1093)”），因此 `Domain=pages.dev` 的 cookie 属跨子域 supercookie 范畴、**不应指望浏览器接受**（PSL 官方明说其用途之一是阻止这类 cookie）；但 Cloudflare 官方文档中**未找到任何关于 Pages 站点 Cookie 的说明**，也**未找到「`*.pages.dev` 强制 HTTPS」的官方文档原文**。

**证据**

1. PSL 官方仓库中 `pages.dev` 的入库 commit（逐字 patch，含上下文）：
   > commit message: `Add pages.dev (#1093)` / `* Add pages.dev` / `* update to Cloudflare organization`
   > patch:
   > ```
   >  // Cloudflare, Inc. : https://www.cloudflare.com/
   > -// Submitted by Jake Riesterer <publicsuffixlist@cloudflare.com>
   > +// Submitted by Cloudflare Team <publicsuffixlist@cloudflare.com>
   > +pages.dev
   >  trycloudflare.com
   >  workers.dev
   > ```
   > 作者 Rita Kozlov（Cloudflare），日期 **2020-09-08T22:11:00Z**
   
   https://github.com/publicsuffix/list/commit/255371bef53331ffe4aa50e77bdb06f7e5c05480 （diff 亦取自 https://api.github.com/repos/publicsuffix/list/commits/255371bef53331ffe4aa50e77bdb06f7e5c05480 ）
2. PSL 官方对「为何存在这个列表」的原文（cookie 相关的官方理由）：
   > “A "public suffix" is one under which Internet users can (or historically could) directly register names. Some examples of public suffixes are `com`, `co.uk` and `pvt.k12.ma.us`. The Public Suffix List is a list of all known public suffixes.”
   > “It allows browsers to, for example: — Avoid privacy-damaging "supercookies" being set for high-level domain name suffixes — Highlight the most important part of a domain name in the user interface — Accurately sort history entries by site”
   
   https://publicsuffix.org/
3. PSL 官方提交指南（PRIVATE 段的适用对象）：
   > “In addition, owners of privately-registered domains who themselves issue subdomains to mutually-untrusting parties may wish to be added to the PRIVATE section of the list.”
   
   https://github.com/publicsuffix/list/wiki/Guidelines
4. Cookie 规范侧的机制（**部分取得**）：draft-ietf-httpbis-rfc6265bis-22 的 Storage Model 中，`domain-attribute` 与请求主机不匹配时直接丢弃 cookie：
   > “3. … If the domain-attribute is identical to the request-host-canonical: Let the domain-attribute be the empty string. Otherwise: Abort this algorithm and ignore the cookie entirely.”
   > “4. If the domain-attribute is non-empty: If request-host-canonical does not domain-match (see Section 5.1.3) the domain-attribute: Abort this algorithm and ignore the cookie entirely. Otherwise: Set the cookie's host-only-flag to false. Set the cookie's domain to the domain-attribute.”
   > 该 draft 另有章节标题 `8.9. Public Suffix List`（正文未能完整抓取）
   
   https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis
   **注意**：我**未能**在抓到的规范文本里逐字找到「若 domain-attribute 是 public suffix 则拒绝」这一步（页面被截断）。因此“浏览器会拒绝 `Domain=pages.dev`”这一行为，我以 **PSL 官方目的陈述（第 2 条）+ draft 的 domain-match 丢弃规则（第 4 条）** 作支撑，并把它标为**需自测确认**（见 §7）。
5. Cloudflare 侧关于 Pages Cookie / 自定义域与 PSL：**未找到官方说明**。已检索并逐页核对：Pages Custom domains、Pages Known issues、Pages Redirects、Pages Headers、Pages Preview deployments、Pages Debugging、Pages platform Limits、Pages Functions Pricing/API reference 与 WAF SameSite 文档页——**均无 pages.dev cookie / PSL 的表述**。
   https://developers.cloudflare.com/pages/configuration/custom-domains/ （Last updated **Apr 21, 2026**）
6. `*.pages.dev` 是否强制 HTTPS：**官方文档未找到**。仅找到 Cloudflare Community 讨论帖（非官方文档）：
   > 用户提问：“Cloudflare Pages sites are not available over HTTP Only connection, they always redirect to HTTPS, even if SSL is disabled for the domain.”
   > 论坛回复（Cloudflare MVP）：“This is correct.” / “No, this is intended. CF pages always to https”
   
   https://community.cloudflare.com/t/cloudflare-pages-sites-are-https-only/674248 （2024-06-19）。**标注为社区来源，未证实的官方事实。**
7. Cookie 能否跨到别人的 pages.dev 子域：官方同样无说明。可用的官方事实只有第 1 条的 PSL 条目 + 第 2 条 PSL 的用途陈述（阻止 supercookie）。

---

## 4. 免费套餐的限速能力与边界：WAF Rate Limiting、DDoS、Workers 侧免费原语

**结论（一句话）**：**免费套餐确实有 WAF Rate Limiting Rules，但只有 1 条规则、10 秒窗口、按 IP 计数、可用字段只有 Path 与 Verified Bot**；DDoS 防护是「全计划包含的、非计量（unmetered）的 L3-7 缓解」；**Workers 运行时本身没有官方限速原语**，免费可当计数器用的只有 KV / Durable Objects（免费可用，SQLite 后端）/ D1 / Cache API 的额度。

**证据**

1. Rate Limiting Rules 的计划可用性表（Free 列为第一列）：
   > “Available fields in rule expression：Path, Verified Bot”（Free）
   > “Counting characteristics：IP”（Free）
   > “Custom counting expression：No”（Free）
   > “Counting periods：10 s”（Free）
   > “Mitigation timeout periods：10 s”（Free）
   > “Number of rules：1”（Free；Pro 2、Business 5、Enterprise 100）
   > “Cache exclusion：No”（Free）
   
   https://developers.cloudflare.com/waf/rate-limiting-rules/ （Last updated **Aug 25, 2026**）
2. 该功能的作用域是 zone（对 `*.pages.dev` 的关键约束）：
   > “Rate limiting rules allow you to define rate limits for requests matching an expression, and the action to perform when those rate limits are reached.”
   > “Some Enterprise customers can create rate limiting rulesets at the account level that they can deploy to multiple Enterprise zones.”
   > 相关操作文档标题为 “Create a rate limiting rule in the dashboard for a **zone**” / “…via API for a **zone**”
   
   同上 URL。
3. DDoS 的计划可用性（官方文档表，Free 列 = Yes）：
   > “Available on all plans”
   > 表行：`Availability | Yes | Yes | Yes | Yes | Yes`；`Standard, unmetered DDoS protection (layers 3-7) | Yes | …`；`HTTP DDoS attack protection | Yes | …`；`Network-layer (L3/4) DDoS attack protection | Yes | …`
   
   https://developers.cloudflare.com/ddos-protection/ （Last updated **Aug 14, 2026**）
4. Durable Objects **在免费版可用**（官方原文，直接回答“DO 是否免费”）：
   > “Durable Objects are available both on Workers Free and Workers Paid plans.”
   > “**Workers Free plan**: Only Durable Objects with SQLite storage backend are available.”
   > Free 额度表：`Requests 100,000 / day`；`Duration 13,000 GB-s / day`；SQLite 后端存储：`Rows reads 5 million / day`；`Rows written 100,000 / day`；`SQL Stored data 5 GB (total)`
   > “On Workers Free plan: If you exceed any one of the free tier limits, further operations of that type will fail with an error. Daily free limits reset at 00:00 UTC.”
   
   https://developers.cloudflare.com/durable-objects/platform/pricing/ （Last updated **Aug 25, 2026**）
5. Workers KV 免费额度（可作计数器，但写额度很小）：
   > `Free plan`：`Keys read 100,000 / day`；`Keys written 1,000 / day`；`Keys deleted 1,000 / day`；`List requests 1,000 / day`；`Stored data 1 GB`
   > “All limits reset daily at 00:00 UTC. If you exceed any one of these limits, further operations of that type will fail with an error.”
   
   https://developers.cloudflare.com/workers/platform/pricing/
6. Cache API（免费可用，但不是限速器）：
   > `Cache API limits | Feature | Workers Free | Workers Paid — Maximum object size | 512 MB | 512 MB — Calls per request | 50 | 1,000`
   > “Calls per request is the number of `put()`, `match()`, or `delete()` Cache API calls per request. This shares the same quota as subrequests (`fetch()`).”
   
   https://developers.cloudflare.com/workers/platform/limits/
7. **未找到**：任何 Cloudflare 官方文档描述 Workers 运行时提供限速/令牌桶原语（`workers/platform/limits` 与 Workers runtime-apis 目录中均无此类 API）。
8. 版本/时间说明：第 1 条可用性表为 **2026-08-25** 版本；Cloudflare 历史上有「Rate Limiting 属 Pro+ 付费附加」的做法（旧版 Rate Limiting 文档已标注 “previous version, no longer available”，见同页链接 https://developers.cloudflare.com/waf/reference/legacy/old-rate-limiting/ ）。以 2026-08-25 的可用性表为准。

---

## 5. Pages Functions 中间件与路由约定

**结论（一句话）**：`functions/_middleware.js`（`.ts` 同样支持）的官方定位是「作用于 `/functions` 目录下所有 Functions（含子目录），放在 `functions/` 根即覆盖整个应用、**包括静态文件之前**」；因此它能拦截本项目全部 `/api/*`；绑定通过 `context.env` 访问，**但官方未就「middleware 能否访问 D1 绑定」作专门表述**。

**证据**

1. Middleware 的定义与作用范围（逐字）：
   > “Middleware is similar to standard Pages Functions but middleware is always defined in a `_middleware.js` file in your project's `/functions` directory. A `_middleware.js` file exports an `onRequest` function.”
   > “The middleware will run on requests that match any Pages Functions in the same `/functions` directory, including subdirectories. For example, `functions/users/_middleware.js` file will match requests for `/functions/users/nevi`, `/functions/users/nevi/123` and `functions/users`.”
   > “If you want to run a middleware on your entire application, including in front of static files, create a `functions/_middleware.js` file.”
   > “You can export an array of Pages Functions as your middleware handler. This allows you to chain together multiple middlewares that you want to run.” + “In the above example, the `errorHandling` function will run first.”
   
   https://developers.cloudflare.com/pages/functions/middleware/ （Last updated **Apr 21, 2026**）
   （原文即用 `_middleware.js`；`.ts` 由第 3 条官方 TypeScript 说明覆盖——官方示例本身也用 `_middleware.ts` 指代能力。）
2. 路由约定（文件 → URL）：
   > “Functions utilize file-based routing. Your `/functions` directory structure determines the designated routes that your Functions will run on.”
   > 表：`/functions/index.js → example.com`；`/functions/helloworld.js → example.com/helloworld`；`/functions/fruits/apple.js → example.com/fruits/apple`
   > “Trailing slash is optional. Both `/foo` and `/foo/` will be routed to `/functions/foo.js` or `/functions/foo/index.js`.”
   > “More specific routes (routes with fewer wildcards) take precedence over less specific routes.”
   → 故 `functions/api/foo.ts` → `/api/foo`（由同一张映射表得出）。
   
   https://developers.cloudflare.com/pages/functions/routing/ （Last updated **Apr 21, 2026**）
3. TypeScript 支持（`.ts` 可作中间件文件名）：
   > “Pages Functions supports TypeScript. Author any files in your `/functions` directory with a `.ts` extension instead of a `.js` extension to start using TypeScript.”
   
   https://developers.cloudflare.com/pages/functions/typescript/ （Last updated **Apr 21, 2026**）
4. 调用范围可控（控制 10 万/天请求额度的关键）：
   > “On a purely static project, Pages offers unlimited free requests. However, once you add Functions on a Pages project, all requests by default will invoke your Function. To continue receiving unlimited free static requests, exclude your project's static routes by creating a `_routes.json` file.”
   > “`include`: Defines routes that will be invoked by Functions. Accepts wildcard behavior. `exclude`: Defines routes that will not be invoked by Functions… `exclude` always take priority over `include`.”
   > “Functions invocation routes have the following limits: You must have at least one include rule. You may have no more than 100 include/exclude rules combined. Each rule may have no more than 100 characters.”
   
   同上 Routing URL。
5. 绑定访问方式（D1）：
   > “In the following example, your D1 database binding is `NORTHWIND_DB` and you can access the binding in your Function code on `context.env`:”
   > “Interact with this binding by using `context.env` (for example, `context.env.NORTHWIND_DB`.)”
   > “A binding enables your Pages Functions to interact with resources on the Cloudflare developer platform.” / “Pages Functions only support a subset of all bindings, which are listed on this page.”
   
   https://developers.cloudflare.com/pages/functions/bindings/ （抓取于 2026-09-16）
6. `context` 对象的官方字段（middleware 与普通 Function 共用同一个 `onRequest(context)` 签名）：
   > “`env` [EnvWithFetch]” ；`data` “Holds the environment variables, secrets, and bindings for a Function. This also holds the `ASSETS` binding…”
   > “`next(input?Request | string, init?RequestInit)` Promise<Response> — Passes the request through to the next Function or to the asset server if no other Function is available.”
   
   https://developers.cloudflare.com/pages/functions/api-reference/ （Last updated **Apr 21, 2026**）
   **缺口**：Bindings 页与 API reference 页**都未出现 “middleware” 一词**，即「middleware 里能用 `context.env.DB`」是**推断**（依据 middleware 导出的 `onRequest` 接收同一 `EventContext`），非官方逐字结论。

---

## 6. D1 免费版限制与「写行数」计数口径

**结论（一句话）**：免费版官方数字为 **读 5,000,000 行/天、写 100,000 行/天、单库 500 MB、单账户总存储 5 GB**；官方**只列出读行/写行的每日额度，不存在「每日查询请求数」这一指标**；`INSERT` 写 1 行 = 1 行、索引列写入会**额外 +1 行**；**`INSERT ... ON CONFLICT DO UPDATE` 的计数口径官方未说明（未找到一手来源）**；**「单次查询返回行数上限」官方限制表中未列出**。

**证据**

1. 计费指标（Free 列）：
   > `Rows read | 5 million / day`（Workers Free）
   > `Rows written | 100,000 / day`（Workers Free）
   > `Storage (per GB stored) | 5 GB (total)`（Workers Free）
   
   https://developers.cloudflare.com/d1/platform/pricing/ （Last updated **Apr 21, 2026**）
2. 「写行数」计数口径（逐字）：
   > “Rows written measure how many rows were written to D1 database. Write operations include `INSERT`, `UPDATE`, and `DELETE`. Each of these operations contribute towards rows written. A query that `INSERT` 10 rows into a `users` table would count as 10 rows written.”
   > “Row size or the number of columns in a row does not impact how rows are counted. A row that is 1 KB and a row that is 100 KB both count as one row.”
   > “Indexes will add an additional written row when writes include the indexed column, as there are two rows written: one to the table itself, and one to the index. The performance benefit of an index and reduction in rows read will, in nearly all cases, offset this additional write.”
   > “DDL operations (for example, `CREATE`, `ALTER`, and `DROP`) are used to define or modify the structure of a database. They may contribute to a mix of read rows and write rows.”
   > “Rows read measure how many rows a query reads (scans), regardless of the size of each row. For example, if you have a table with 5000 rows and run a `SELECT * FROM table` as a full table scan, this would count as 5,000 rows read.”
   > “Free limits reset daily at 00:00 UTC.”
   
   同上 URL。**未找到** `ON CONFLICT DO UPDATE` / upsert 的专门计数说明（该页仅枚举 INSERT/UPDATE/DELETE）。
3. 超限行为：
   > “When your account hits the daily read and/or write limits, you will not be able to run queries against D1. D1 API will return errors to your client indicating that your daily limits have been exceeded.”
   
   同上 URL。
4. D1 限制表（逐字，Free 相关）：
   > `Databases per account | 50,000 (Workers Paid) / 10 (Free)`
   > `Maximum database size | 10 GB (Workers Paid) / 500 MB (Free)`
   > `Maximum storage per account | 1 TB (Workers Paid) / 5 GB (Free)`
   > `Time Travel duration (point-in-time recovery) | 30 days (Workers Paid) / 7 days (Free)`
   > `Queries per Worker invocation (read subrequest limits) | 1000 (Workers Paid) / 50 (Free)`
   > `Maximum number of columns per table | 100`
   > `Maximum number of rows per table | Unlimited (excluding per-database storage limits)`
   > `Maximum string, BLOB or table row size | 2,000,000 bytes (2 MB)`
   > `Maximum SQL statement length | 100,000 bytes (100 KB)`
   > `Maximum bound parameters per query | 100`
   > `Maximum SQL query duration | 30 seconds`
   > `Maximum file import (d1 execute) size | 5 GB`
   > 另：“Each individual D1 database is inherently single-threaded, and processes queries one at a time.” / “You can open up to six connections (to D1) simultaneously for each invocation of your Worker.”
   
   https://developers.cloudflare.com/d1/platform/limits/ （Last updated **Apr 21, 2026**）
   → **该表未包含「单次查询返回行数上限」条目**：即**未找到官方一手来源**说明存在这一上限。
5. 关于「每日查询请求数」：
   > 官方计量维度只有 `Rows read` / `Rows written` / `Storage`（第 1 条），并在 FAQ 中只用 “daily read and/or write limits” 表述；
   > `Queries per Worker invocation` 是**单次调用内的语句数**上限（Free 50），不是每日请求数。
   
   同上两个 URL。
6. 用量可自测（对确认 upsert 计数口径唯一可靠的官方手段）：
   > “Every query returns a `meta` object that contains a total count of the rows read (`rows_read`) and rows written (`rows_written`) by that query.”
   > 示例：`"meta": { "duration": 0.20472300052642825, "size_after": 45137920, "rows_read": 5000, "rows_written": 0 }`
   
   https://developers.cloudflare.com/d1/platform/pricing/

---

## 7. 对鉴权选型的直接影响

> 每条标明 **[事实]**（有一手来源）或 **[推断]**（我基于事实的判断，未被官方逐字确认）。

1. **[事实]** PBKDF2 迭代次数被 workerd 硬性封顶在 **100,000**，且 Cloudflare 工程师说明这个上限是「**事先限额**」而非事后中断：“Since our CPU time-limiting code cannot interrupt BoringSSL in the middle of running PBKDF, we have to limit the iterations upfront.”（kentonv, 2023-10-30），并且截至 2026-09-16 生产环境状态未更新（jasnell 2024-01-03 “in the production environment the current limit will remain…”，2024-04-19 “Not yet.”）。
   → **不要按 OWASP 的 600,000 次设计**：既会被 `DOMNotSupportedError` 拒绝（“iteration counts above 100000 are not supported”），也不可能靠"撞 CPU 上限后优雅失败"来兜底。
2. **[事实 + 推断]** 免费版 CPU time = **10 ms/请求**（含 Cron Trigger 亦为 10 ms/次），PBKDF2 是纯 CPU 消耗（await IO 不计 CPU，而哈希正是 CPU）。
   → **[推断]** 迭代次数必须按 **≤10 ms CPU** 校准，而不是按 100,000 上限校准；而**官方与 workerd 仓库均未公布任何「迭代次数 → ms」基准**（唯一官方示例是 15,000 次 + SHA-512，且无计时）。**这条只能自测**（用 `wrangler dev` + DevTools CPU profile 或线上 CPU 时间观测）。**未证实项：具体建议迭代次数。**
3. **[事实]** 生产上限只约束 PBKDF2 **迭代次数**；workerd 对 **scrypt** 另设成本上限 `DEFAULT_MAX_SCRYPT_COST = 1u << 20`（N×r×p ≤ 2^20）。纯 JS 的 scrypt/argon2 不进这条 check，但会直接吃 CPU 配额。
   → **[推断]** 若选 scrypt 纯 JS 实现，约束从「迭代次数上限」变成「10 ms CPU + N×r×p ≤ 2^20」，并不会更宽松。
4. **[事实]** `pages.dev` 是 PSL 中的 public suffix（Cloudflare 于 2020-09-08 提交，PRIVATE 段 “Cloudflare, Inc.” 块内），PSL 官方明说其用途之一是 “Avoid privacy-damaging "supercookies" being set for high-level domain name suffixes”。
   → **[事实/推断]** cookie 只能是 host-only（不设 `Domain` 属性），**不要写 `Domain=xxx.pages.dev`**；`Secure` / `HttpOnly` / `SameSite` 与 `Path` 不受 PSL 影响，仍可设置。**[待自测]**：浏览器拒绝 `Domain=pages.dev` 的具体行为，我未能在规范里逐字取得「public suffix 判定」步骤（见 §3 第 4 条）。
5. **[事实]** 免费套餐的**平台级限速只有 zone 上的 WAF Rate Limiting Rules**，且 Free 档位被限死为 **1 条规则 / 10 s 窗口 / 按 IP / 表达式仅 Path 与 Verified Bot / 不支持自定义计数表达式 / 10 s 缓解**；而 `*.pages.dev` **不是 zone**。
   → **[推断]** 登录防爆破**不能依赖平台限速**，必须自研；且自研计数器只能落在免费额度内：**KV 免费仅 1,000 次写/天**（极易被打爆），**D1 免费 100,000 写行/天**、**DO 免费（SQLite 后端）100,000 请求/天**。DDoS 方面官方是 “Standard, unmetered DDoS protection (layers 3-7)”，全计划包含（**[事实]**），但它面向流量型攻击，不是登录爆破这种应用层配额控制（**[推断]**）。
6. **[事实]** D1 免费写额度 100,000 行/天，且**索引列写入会额外计 1 行**；`ON CONFLICT DO UPDATE` 的计数口径官方未说明（未证实）。
   → **[推断]** 任何「每次请求都写一行」的审计/限速设计都要按「1 次业务写 × (1 + 索引数)」估，且 upsert 的实际计数需用 `meta.rows_written` 实测后再定预算。
7. **[事实]** `functions/_middleware.ts` 可覆盖整个应用（含静态文件之前），`_routes.json` 的 `include`/`exclude` 可限定 Functions 调用范围；同时 Functions 与 Workers **共享** 100,000 请求/天 与 CPU 配额。
   → **[推断]** 统一鉴权中间件可行，但必须放在 `_routes.json` 的 `include`（如 `/api/*`）范围内，避免静态资源也消耗 10 万/天额度；中间件自身要保持极低 CPU。
8. **[事实]** **未找到**任何官方说明支持「在 middleware 中访问 D1 绑定」；官方只说明绑定通过 `context.env` 在 “Function code” 中访问。
   → **[推断]** 可预期可行（middleware 的 `onRequest` 接收同一 `EventContext`），但落地前建议用官方本地开发（`wrangler pages dev` + D1 本地绑定）验证一次。

---

## 8. 未证实 / 未找到 / 待决问题

**未找到一手来源（保留原文缺口，不做推测填充）**
1. **Pages Functions 的 CPU 上限逐字数字**：文档只写「按 Workers 计费 / 占用 Workers 配额 / 超 CPU 会报错」，未逐字写出 “10 ms”（§1）。
2. **PBKDF2 任意迭代次数的耗时基准**：Cloudflare 官方文档、workerd 仓库、cloudflare/worker-performance-examples 均无计时数据（§2 第 5 条）。
3. **`INSERT ... ON CONFLICT DO UPDATE` 的写行计数口径**：D1 官方文档只枚举 INSERT/UPDATE/DELETE，无 upsert 说明（§6 第 2 条）。
4. **D1「单次查询返回行数上限」**：官方限制表无此条目（§6 第 4 条）；查询结果规模只受 subrequest 计数（50/请求）、行大小 2 MB、SQL 超时 30 s 等约束。
5. **D1「每日查询请求数」**：官方不存在该计量维度，只有读行/写行/存储（§6 第 5 条）。
6. **Cloudflare 官方关于 Pages 站点 Cookie / `*.pages.dev` 的说明**：逐页检索 Pages 相关文档后未找到任何相关表述（§3 第 5 条）。
7. **`*.pages.dev` 强制 HTTPS 的官方文档原文**：未找到；仅有 Cloudflare Community 帖（2024-06-19，含 Cloudflare MVP 回复 “This is correct.”）——**社区来源，未证实**（§3 第 6 条）。
8. **Workers 运行时是否内置限速原语**：官方文档中未找到（§4 第 7 条）。

**取证缺口（工具限制，非源头缺失）**
9. `public_suffix_list.dat` **当前全文**未能一次性抓取（工具把 300+ KB 内容截断在 ICANN 段中部，PRIVATE 段位于文件末尾）。因此 `pages.dev` 的「当前仍在列表中」是用**间接**方式核验：GitHub commit 搜索 `repo:publicsuffix/list pages.dev` 返回 `total_count = 1`（唯一命中即 2020-09-08 的入库 commit，无任何后来删除该条目的 commit message）。抓取中看到的 PSL 数据版本字符串为 `2026-09-08_12-18-37_UTC`。
   来源：https://api.github.com/search/commits?q=repo%3Apublicsuffix%2Flist+pages.dev （2026-09-16）
10. draft-ietf-httpbis-rfc6265bis 的 §8.9 “Public Suffix List” 正文在抓取中被截断，未能逐字取得「domain-attribute 是 public suffix 则丢弃 cookie」的算法步骤（§3 第 4 条）。
11. `src/workerd/api/crypto-impl-pbkdf2.c++` 的**当前**内容未能取得（raw 抓取 404，且该文件路径可能已被 2024-06-24 的目录搬迁影响）。PBKDF2 上限的**当前**证据取自 `main` 分支的 `src/workerd/io/limit-enforcer.h`（已逐字引用），历史行为取自 commit `804c596`（已逐字引用 patch）。

**待决问题（需主 Agent / 用户裁决，不应由调研补齐）**
- **迭代次数定多少**：无官方基准 → 必须实测；实测口径（只看 CPU 时间？含 D1 往返？）需先定。
- **是否需要在本机/线上做「浏览器是否接受 `Domain=pages.dev` cookie」的实测**（若计划用子域隔离会话，建议实测一次）。
- **upsert 的写行计数**是否接受“未证实、需以 `meta.rows_written` 实测”作为决策依据。
- **`*.pages.dev` 是否强制 HTTPS** 未证实 → 若该事实不能证实，是否仍无条件设置 `Secure`（[推断] 设置 `Secure` 在 HTTPS 站点无副作用，但“站点一定是 HTTPS”本身在本次调研中**未经官方证实**）。
- **限速实现载体**（D1 表 / DO / KV）未定：三者的免费额度与写入计量口径不同（§4 第 4/5 条、§6 第 2 条）。

**互相矛盾之处（保留双方，不抹掉）**
- Rate Limiting 的**可用性口径**：WAF 文档可用性表（**2026-08-25**）显示 Free 有 1 条 rate limiting rule（10 s 窗口）；但 Cloudflare 面向客户的 plans/产品页在本次抓取中未能取得可逐字引用的 Free 包含说明（`https://www.cloudflare.com/plans/` 为动态渲染，抓取结果不含计划对比表），且文档站仍保留 “Cloudflare Rate Limiting (previous version, no longer available)”（按用量计费的旧版）。**结论以 2026-08-25 的 WAF 文档可用性表为准，但「免费版能否在 dashboard 里实际创建该 1 条规则」在本次调研中未见逐字确认。**
