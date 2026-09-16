# Cloudflare Pages 静态层事实清单（`_routes.json` / `_headers` / `_redirects` / SPA 回退 / 缓存头）

> **调研范围**：家庭财务管理系统在 Cloudflare **免费套餐**下，Pages（React + Vite 静态产物 + PWA）与 Pages Functions（`/api/*`）混合部署时，静态层的三个门禁问题：
> 1. `_routes.json` 的位置与语义；2. `/sw.js` 的默认 `Cache-Control` 与 `_headers` 覆盖能力；3. SPA 客户端路由的 404 / fallback 行为。
>
> **采集日期**：**2026-09-16**（所有「Last updated」为抓取时页面自报值；文档会变动，复跑时请重新核对）。
> **来源口径**：只采 `developers.cloudflare.com`（官方文档 / Changelog）、`cloudflare/workers-sdk` 仓库（源码 / PR / Discussion）、以及本项目直接依赖的 `vite.dev` 官方文档。**二手博客、社区回答仅作为「线索」，不作为结论依据**，凡引用必标注为线索。
> **标注规则**：
> - **[官方明确]** = 官方文档/官方仓库原文写明，可直接引用；
> - **[官方间接]** = 由官方原文可推导，但官方没有逐字写出这一步；
> - **[未找到一手来源]** = 官方未给出说明，只有二手来源；
> - **[未证实 / 需实测]** = 官方无明文，且必须用实测才能定论（附实测方法）。
>
> **重要前提**：Cloudflare 官方已明示「新项目推荐用 Workers 而非 Pages」（见 <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages>，Last updated Aug 14, 2026）。本票按既定拓扑（Pages + Pages Functions）核实事实，不改变技术选型。

---

## 0. 结论速览

| # | 问题 | 结论 | 依据等级 |
|---|---|---|---|
| 1 | `_routes.json` 放哪 | **构建输出目录**（本仓库即 `dist/_routes.json`；Vite 工程建议写在 `public/_routes.json`，构建时原样复制到 dist 根） | [官方明确] |
| 1 | 只让 `/api/*` 走 Functions 怎么写 | `{"version":1,"include":["/api/*"],"exclude":[]}`（≥1 条 include；include+exclude ≤100 条；每条 ≤100 字符） | [官方明确]（限制/语义）+ [官方间接]（该具体写法） |
| 1 | 不加 `_routes.json` 会怎样 | 一旦项目里有 Functions，**默认所有请求都会调用 Function**；静态请求想保住「无限免费」必须靠 exclude 类规则把它排除 | [官方明确] |
| 2 | `/sw.js` 默认 `Cache-Control` | **`Cache-Control: public, max-age=0, must-revalidate`**（官方列在 "Headers sometimes added"，条件是「资产可缓存且请求不带 `Authorization` / `Range`」）；同时所有 `200 OK` 都带 `ETag`，可 304 | [官方明确] |
| 2 | 是否可以不管它 | **默认策略本身就不会长期缓存 `sw.js`**（每次使用前必须校验），所以「SW 永久卡旧版本」的经典风险在 Pages 默认配置下**不成立** | [官方明确]（默认头）+ [官方间接]（推论） |
| 2 | 能否用 `_headers` 覆盖 | 能。`_headers` 放在**静态资源目录**（Vite 即 `public/_headers`）；最多 100 条规则、每行 ≤2000 字符；**不作用于 Pages Functions 的响应** | [官方明确] |
| 2 | Pages 静态资源是否走 CDN 缓存 | **走**。资产自动缓存在 Cloudflare CDN 直到下次部署，且自动使用 Tiered Cache（无需单独开启）；资产 TTL 一周，也可能随时消失 | [官方明确] |
| 2 | 能否「绕过」CDN 缓存 / `cf-cache-status` 长什么样 | **官方无明文**；`cf-cache-status` 不在 Pages 官方「总会/有时添加」的头列表里，二手来源互相矛盾 → 见 §6 | [未证实 / 需实测] |
| 3 | SPA 路由 `/entry`、`/stocks` 会不会 404 | **默认不会**。项目**没有顶层 `404.html`** 时，Pages 自动进入 SPA 模式，把所有未匹配路径映射到根 `index.html`（**不需要写 `_redirects`**） | [官方明确] |
| 3 | 能否写 `/* /index.html 200` | 能（200 rewrite/proxy 是官方支持的语法）；但**反而不推荐**，因为它会连 `/assets/不存在的.js` 一起 200 成 `index.html` | [官方明确]（语法）+ [官方间接]（副作用） |
| 3 | Pages 有没有 `not_found_handling` 设置 | **Pages 侧没有这个键**（`not_found_handling` / `html_handling` 属 Workers 的 `assets` 配置）；Pages 靠「有没有 `404.html` / `index.html`」自动判断 | [官方明确]（键属 Workers）+ [官方间接]（Pages 无此键） |
| 3 | `_redirects` 会不会把请求变成 Functions 调用 / 吃额度 | **不会**——路由是否走 Functions 只由 `_routes.json` 决定；`_redirects` 只作用于「由静态资产层提供的响应」。官方对此无逐字合并说明 | [官方间接] + [未证实部分] |

---

## 1. 三个文件的位置与语义（总览）

| 文件 | 官方规定的位置 | 本项目（Vite）落地位置 | 作用对象 | 限制 |
|---|---|---|---|---|
| `_routes.json` | 「**build directory** of your project」（构建输出目录） | 写 `public/_routes.json`（Vite 构建时原样复制到 `dist/` 根） | 决定哪些请求**调用 Pages Functions** | ≥1 条 include；include+exclude 合计 ≤100 条；每条 ≤100 字符 |
| `_headers` | 「**static asset directory** of your project」（静态资源目录；无框架时即构建输出目录） | 写 `public/_headers`（→ `dist/_headers`） | 覆盖/删除/新增**静态资产响应**的响应头 | ≤100 条 header 规则；每行 ≤2000 字符 |
| `_redirects` | 同上（静态资源目录 / 构建输出目录） | 写 `public/_redirects`（→ `dist/_redirects`） | **静态资产响应**的重定向与 200 rewrite | 2000 静态 + 100 动态 = 合计 2100 条；单条声明 ≤1000 字符 |

- **[官方明确]** `_headers` / `_redirects`「will not itself be served as a static asset」——这两个文件不会被当作静态资源对外提供，而是被 Pages 解析。
- **[官方明确]** 三者均可写在框架的静态资源目录（如 Vite 的 `public/`），「These files get copied over to a final output directory during the build, so this is the perfect place to author your `_headers` file」。
- **[官方明确]** Vite 官方文档：`public/` 下的文件「copied to the root of the dist directory **as-is**」（不做 hash、不改名），开发时按 `/` 根路径提供。
  - 来源：<https://vite.dev/guide/assets#the-public-directory>（页面未显示 Last updated；抓取 2026-09-16）
- **[官方明确]** 本仓库 Pages 构建目录：官方框架预设表里 **React (Vite) → Build command `npm run build` / Build directory `dist`**。
  - 来源：<https://developers.cloudflare.com/pages/configuration/build-configuration/>（Last updated Apr 21, 2026）；<https://developers.cloudflare.com/pages/functions/routing/>（React (Vite) → `dist`）

---

## 2. 问题 1：`_routes.json` 的确切位置与语义

### 2.1 位置：构建输出目录，不是 `functions/`

**[官方明确]** 原文：

> "Create a `_routes.json` file to control when your Function is invoked. **It should be placed in the build directory of your project.**"

因此：

- 结论：**`dist/_routes.json`**（构建输出目录根），**不是** `functions/_routes.json`。
- 本仓库推荐做法：源文件放 `public/_routes.json`，构建后被 Vite 原样复制成 `dist/_routes.json`。
- 来源：<https://developers.cloudflare.com/pages/functions/routing/#create-a-_routesjson-file>（Last updated Apr 21, 2026）
- **[官方明确]** 官方同时在该页给出「Default build directories」表：React (Vite) 的 build directory 是 `dist`。

### 2.2 语义：三个属性 + exclude 优先

**[官方明确]** 原文要点：

- `version`：schema 版本，目前只有 `version: 1`。
- `include`：**会被 Functions 调用的路由**，支持 wildcard。
- `exclude`：**不会被 Functions 调用的路由**，支持 wildcard；「**`exclude` always take priority over `include`**」。
- Wildcard 语义：「Wildcards match any number of path segments (slashes). For example, `/users/*` will match everything after the `/users/` path.」

官方示例（未匹配 `/build` 的路径会调用 Function；`/build/*` 不调用）：

```json
{
  "version": 1,
  "include": ["/*"],
  "exclude": ["/build/*"]
}
```

> 官方对该示例的注释原文：「Any route inside the `/build` directory **will not invoke the Function and will not incur a Functions invocation charge**.」→ **[官方明确]** 被排除的路由既不计 Functions 调用、也不产生 Functions 调用费用。

来源：<https://developers.cloudflare.com/pages/functions/routing/#example-configuration>（Last updated Apr 21, 2026）

### 2.3 默认行为：加了 Functions 就默认全走 Functions

**[官方明确]** 原文（同一页）：

> "On a purely static project, Pages offers unlimited free requests. However, **once you add Functions on a Pages project, all requests by default will invoke your Function**. To continue receiving unlimited free static requests, exclude your project's static routes by creating a `_routes.json` file. **This file will be automatically generated if a `functions` directory is detected in your project** when you publish your project with Pages CI or Wrangler."

推论与注意点：

1. **本项目一定有 `functions/` 目录**（API 在 `/api/*`）→ 若不自带 `_routes.json`，Pages 会**自动生成**一份，且「所有请求默认调用 Function」意味着 `/_expo`、`/entry`、`/stocks`、`/sw.js`、`/assets/*` 都会先撞 Function，静态请求的「无限免费」保不住。
2. **[官方间接]** 自写 `_routes.json` 是否会**覆盖**自动生成的那份：Pages 文档只说会自动生成，**没有明写「自带则优先」**（框架适配器层面有此类描述，但那是第三方适配器行为，不是 Pages 本体规定）。→ 需实测（见 §6）。
   - 相关框架侧线索（非 Pages 官方规定）：`cloudflare/workers-sdk` 生态与 Qwik 适配器 README 描述「项目自带 `public/_routes.json` 时不再自动生成」。仅作线索。

### 2.4 限制（官方逐条）

**[官方明确]**「Functions invocation routes have the following limits:」

- You must have **at least one include rule**.
- You may have **no more than 100 include/exclude rules combined**.
- **Each rule may have no more than 100 characters.**

来源：<https://developers.cloudflare.com/pages/functions/routing/#limits>（Last updated Apr 21, 2026）

> ⚠️ 注意与第 2 问的额度门禁的关系：上述三条是**硬限制**（写超了会构建/部署失败或规则失效）。家庭项目不会接近 100 条，但字符限制（100 字符/条）在写长 URI 前缀时要留意。

### 2.5 只让 `/api/*` 走 Functions 的写法

**[官方间接]**（由 §2.2 的 include/exclude 语义 + §2.4「至少 1 条 include」直接推得，Pages 文档未给出这一具体示例）：

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
```

- `include` 只有 `/api/*`：其余一切路径（`/`、`/entry`、`/stocks`、`/assets/*`、`/sw.js`、`/manifest.webmanifest`）都不调用 Function → 保持静态、走「无限免费」桶。
- 官方允许 `exclude` 为空数组（限制只规定 include ≥ 1 条）；文档示例中 `exclude` 都是数组，故**建议保留 `"exclude": []` 而不是省略该键**（文档说文件「will include three different properties」）。
- **[官方间接] 未验证点**：官方把「保住免费静态额度」表述为「**exclude** your project's static routes」；用「include 只写 `/api/*`」达到同一效果在语义上等价（因为 include 定义了「哪些路由会被 Functions 调用」），但官方未对该形态逐字背书。→ 用 §6 的方法核对 Functions 指标。

### 2.6 附带官方事实：Functions 日额度耗尽时的行为可配

**[官方明确]** Workers **Free** 套餐下，可在 dashboard 配 `Fail open / closed`（Pages 项目 → **Settings > Runtime > Fail open / closed**）：

- 「Fail open」= 「static assets will continue to be served, even if Pages Functions would ordinarily have run first」；
- 「Fail closed」= 「an error page will be returned, rather than static assets」。

对本项目含义：免费套餐 Functions 日额度（见本项目既有笔记 `cloudflare-free-tier-constraints.md`）耗尽时，选 **Fail open** 可保证 SPA 静态壳仍可访问（API 失效）。来源：<https://developers.cloudflare.com/pages/functions/routing/#fail-open--closed>（Last updated Apr 21, 2026）

---

## 3. 问题 2：`/sw.js` 的默认 `Cache-Control`、`_headers` 覆盖、CDN 缓存

### 3.1 Pages 默认响应头（官方两列表格）

**[官方明确]** 「By default, Pages automatically adds several HTTP response headers when serving assets」：

**Headers always added（总是添加）**

```
Access-Control-Allow-Origin: *
Cf-Ray: $CLOUDFLARE_RAY_ID
Referrer-Policy: strict-origin-when-cross-origin
Etag: $ETAG
Content-Type: $CONTENT_TYPE
X-Content-Type-Options: nosniff
Server: cloudflare
```

**Headers sometimes added（有时添加）**

```
// if the asset has been encoded
Cache-Control: no-transform
Content-Encoding: $CONTENT_ENCODING

// if the asset is cacheable (the request does not have an `Authorization` or `Range` header)
Cache-Control: public, max-age=0, must-revalidate

// if requesting the asset over a preview URL
X-Robots-Tag: noindex
```

来源：<https://developers.cloudflare.com/pages/configuration/serving-pages/#headers>（Last updated Apr 21, 2026）

**对本票门禁的直接回答：**

- **[官方明确]** 对「可缓存资产」且请求不带 `Authorization`/`Range` 的场景，Pages 默认下发 **`Cache-Control: public, max-age=0, must-revalidate`**。
- **[官方间接]** 语义上 `max-age=0, must-revalidate` = 「可以存，但每次使用前必须向服务器校验」→ Service Worker 的更新检查**不会被 HTTP 缓存挡住**，`/sw.js` 的经典「永久旧版本」风险在默认配置下**不成立**。
- **[官方明确]** 该列表**没有** `Age`、**没有** `cf-cache-status`。因此「Pages 资产响应里能否看到 `cf-cache-status`」**官方无明文**（见 §6）。

### 3.2 ETag / 304 机制（官方明文）

**[官方明确]** 原文：

> "For browser caching, Pages **always sends `Etag` headers for `200 OK` responses**, which the browser then returns in an `If-None-Match` header on subsequent requests for that asset. Pages compares the `If-None-Match` header from the request with the `Etag` it's planning to send, and if they match, **Pages instead responds with a `304 Not Modified`**."
> 「Pages currently returns `200` responses for HTTP range requests」（206 正在开发中）；「Pages will also serve Gzip and Brotli responses whenever possible.」

来源：<https://developers.cloudflare.com/pages/configuration/serving-pages/#behavior>（Last updated Apr 21, 2026）

### 3.3 用 `_headers` 覆盖响应头

**[官方明确]** 原文要点：

- 位置：「creating a plain text file called `_headers` without a file extension, **in the static asset directory of your project**」；框架工程通常就是 `public/`（构建后进输出目录）。
- 作用：「The default response headers served on static asset responses **can be overridden, removed, or added to**」；「Headers defined in the `_headers` file **override** what Cloudflare ordinarily sends.」
- 语法：

```
[url]
  [name]: [value]
```

- 支持绝对 URL（必须 `https` 开头，不支持端口）；匹配时忽略请求的 port/protocol。
- 多条规则同时命中会**合并**；同一个头写两次，值以逗号连接。
- 删除头：头部名前置 `!`（如 `! Content-Security-Policy`）。
- 支持 `*` splat（URL 里**只能有一个** splat，值可用 `:splat` 引用）与 `:placeholder`（名字限 `[A-Za-z]\w*`）。
- **[官方明确]** 官方给的缓存示例（与 Sw 无关，但正是「给带 hash 的资产长缓存」的官方推荐写法）：

```
/static/*
  Cache-Control: public, max-age=31556952, immutable
```

- **[官方明确]** ⚠️ 关键限制：「Custom headers defined in the `_headers` file **are not applied to responses generated by Pages Functions**, even if the request URL matches a rule defined in `_headers`.」→ `/api/*` 由 Function 提供，其响应头必须在 Function 代码里 `Response` 上加。
- **[官方明确]** 限制：**最多 100 条 header 规则**；**每行 2000 字符上限**（含空格、头名、值）。
- **[官方明确]** 重定向先于请求头执行：「redirects are applied before headers, so when a request matches both a redirect and a header, the redirect takes priority.」

来源：<https://developers.cloudflare.com/pages/configuration/headers/>（Last updated Aug 25, 2026）；<https://developers.cloudflare.com/pages/platform/limits/#headers>（页面未显示 Last updated；抓取 2026-09-16）

### 3.4 对 `/sw.js` 的推荐策略

**官方对 Service Worker / `sw.js` 的专门表述：**

- **[未找到一手来源]** 在 `developers.cloudflare.com` 的 Pages 文档（Headers / Redirects / Serving Pages / Routing / Limits / wrangler configuration）与 Workers 文档中，**未找到任何把「service worker」或 `sw.js` 与缓存头关联的官方表述**。官方没有为 SW 单独写更新/缓存建议。
- 因此**不能**引用官方「SW 应该设 no-cache」这类说法——那是社区共识（本次检索命中的相关建议全部来自二手博客/项目 README，如 `/sw.js → Cache-Control: no-store`，仅作线索，不作为结论）。

**基于官方明文事实的推荐（标注为工程建议，非官方规定）：**

| 方案 | 写法 | 评价 |
|---|---|---|
| A. 什么都不做 | 依赖 Pages 默认 `public, max-age=0, must-revalidate` | **最低风险**：`max-age=0` + `must-revalidate` 已保证每次使用前校验；官方文档明写这是默认行为 |
| B. 显式钉住 | `_headers` 写 `/sw.js` → `Cache-Control: no-cache` | `no-cache` 与默认的 `max-age=0, must-revalidate` 在浏览器行为上等价（都是「存但必须校验」）；好处是**显式化**、防止未来默认值变化 |
| C. 最严格 | `/sw.js` → `Cache-Control: no-store` | 浏览器与中间缓存都不存；但**会让 304 优化失效**（每次全量下载 SW 脚本，SW 通常只有几 KB，家庭场景可接受）。**注意**：`no-store` 在 Cloudflare 的 CDN 语义里可能连带影响边缘缓存表现，官方未就 Pages 资产给出说明 → 需实测 |

> 结论建议：**方案 A 或 B**。若追求“文档化门禁”，用 B（`no-cache`）并配 `/assets/*` 的 immutable 长缓存。不要用 `immutable` / `max-age=31536000` 去覆盖 `/sw.js`——那才会制造出被门禁担心的旧版本卡死。

### 3.5 Pages 静态资源是否走 CDN 缓存 / 能否绕过

**[官方明确]** 原文：

- 「Every time you deploy an asset to Pages, the asset remains cached on the Cloudflare CDN **until your next deployment**.」
- 「when you use Cloudflare Pages, the static assets that you upload as part of your Pages project are **automatically served from Tiered Cache**. You do not need to separately enable Tiered Cache for the custom domain.」
- 「Assets have a **time-to-live (TTL) of one week** but can also disappear at any time. If you do a new deploy, the assets could exist in that data center **up to one week**.」（Asset retention）
- 官方**建议**：「In most situations, you should **avoid setting up any custom caching** on your site.」并警示：在**自定义域**上加缓存可能导致部署后提供陈旧资源，还可能干扰 Pages redirects / Functions（「the cached response might get served to your end user before Pages can act on the request」）。
- 官方**允许**的例外：对带内容哈希的 CSS/JS，用 **Cache Rules**（自定义域维度）加长缓存；「Just make sure that your caching does not interfere with any redirects or Functions.」

来源：<https://developers.cloudflare.com/pages/configuration/serving-pages/#caching-and-performance>（Last updated Apr 21, 2026）

**能否绕过 CDN 缓存？**

- **[未找到一手来源 / 未证实]** 官方**没有**给出「关闭/绕过 Pages 资产边缘缓存」的开关或说法。官方只谈两件事：① 这套 CDN 缓存是自动的、以「部署」为失效边界；② 在**自定义域**上可以通过 Cache Rules 额外加固（而不是关闭）。
- **[未证实]** `pages.dev` 域名不在你自己的 zone 下，官方文档未说明能否对其配置 Cache Rules（自定义域可以，`pages.dev` 未提及）。→ 若本项目用 `pages.dev` 直连，则**事实上没有配置边缘缓存的入口**（[官方间接] 推论：官方所有 Cache Rules 指引都要求「in your zone / custom domain」）。
- **[未证实 / 需实测]** 响应里是否有 `cf-cache-status`、其值是什么：官方 Pages 头列表未列该头（§3.1）。二手来源互相矛盾：
  - 有云函数社区贴称 Pages 不返回 `cf-cache-status`（「Pages doesn't touch the Zone Cache」，2024-01-17，**线索**）；
  - 有社区工单贴展示 Pages 自定义域上出现 `cf-cache-status: DYNAMIC`（2026-09-05，**线索**）；
  - 二手博客声称静态资产第二次请求为 `HIT`、HTML 为 `DYNAMIC`（**线索**，未证实）。
  - 结论：**不做任何结论**，用 §6 的 `curl -I` 在自家项目上实测。

---

## 4. 问题 3：SPA 客户端路由的 404 / fallback

### 4.1 最重要的一条：Pages 会自动进入 SPA 模式（无需 `_redirects`）

**[官方明确]** 原文：

> 「If your project **does not include a top-level `404.html` file**, Pages assumes that you are deploying a single-page application. This includes frameworks like React, Vue, and Angular. Pages' default single-page application behavior **matches all incoming paths to the root (`/`)**, allowing you to capture URLs like `/about` or `/help` and respond to them from within your SPA.」

**[官方明确]** 404 行为原文：

> 「You can define a custom page to be displayed when Pages cannot find a requested file by creating a `404.html` file. Pages will then attempt to find the closest 404 page… ending in `/404.html`.」

推论（[官方间接]，但非常强）：

- 本项目 `dist/` **不要放顶层 `404.html`**，否则 SPA 模式会被关闭，`/entry`、`/stocks` 直接 404。
- **不需要**为了 SPA 路由去写 `/* /index.html 200`——Pages 默认已经这么干了。`_redirects` 只在你想覆盖默认行为时才需要。
- **[官方明确]** React 官方框架指南的旁注也确认这一点：「By default, Cloudflare Pages assumes you are developing a single-page application.」
  - 来源：<https://developers.cloudflare.com/pages/framework-guides/deploy-a-react-site/>（Last updated Apr 21, 2026）；<https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering>（Last updated Apr 21, 2026）

### 4.2 `_redirects` 的语法、位置与限制

**[官方明确]** 原文要点：

- 位置：与 `_headers` 相同，「in the static asset directory of your project」（Vite → `public/_redirects`）；文件本身不会被当作静态资源提供。
- 语法：`[source] [destination] [code?]`，每行一条，`code` 默认 `302`；`#` 开头为注释。
- **支持 200**（官方 Advanced redirects 表：Proxying ✅，示例 `/blog/* /news/:splat 200`）。
- 支持 301/302/303/307/308；**不支持其它状态码**（表格示例 `/blog/* /blog/404.html 404` ❌）。
- 支持 splat（每行最多一个 `*`，`destination` 里用 `:splat`）与 placeholder（`:name`）。
- **不支持** query parameters、domain-level redirects、country/language、cookie 条件。
- Proxying **只支持站内相对 URL**，不能代理外部域名（且站内 200 链式：「Only the first redirect in your file will apply」）。
- 顺序敏感：「If there are multiple redirects for the same `source` path, the top-most redirect is applied」「Static redirects should appear before dynamic redirects」。
- **「Redirects are always followed, regardless of whether or not an asset matches the incoming request.」**（← 这句是后面 §4.5 陷阱的官方依据）
- 重定向先于 header 执行。

**限制 [官方明确]**：「A `_redirects` file is limited to **2,000 static redirects and 100 dynamic redirects, for a combined total of 2,100 redirects**. Each redirect declaration has a **1,000-character limit**.」（超限用 Bulk Redirects，属于 zone 级功能）

来源：<https://developers.cloudflare.com/pages/configuration/redirects/>（Last updated Aug 25, 2026）；<https://developers.cloudflare.com/pages/platform/limits/#redirects>（页面未显示 Last updated）

### 4.3 Pages 是否有 `not_found_handling` 之类的设置

- **[官方明确]** `not_found_handling` 与 `html_handling` 是 **Workers** 的 `assets` 配置键，取值分别是 `single-page-application` / `404-page`（`html_handling`：`auto-trailing-slash` / `force-trailing-slash` / `drop-trailing-slash` / `none`）。
  - 来源：<https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>（Last updated Aug 25, 2026）；<https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/>（页面未显示 Last updated）；<https://developers.cloudflare.com/workers/static-assets/>
- **[官方明确]** Workers 侧 `not_found_handling = "single-page-application"` 的语义原文：「Workers will serve the contents of the `/index.html` file with a `200 OK` status」。
- **[官方间接]** **Pages 侧没有等价配置键**：
  - Pages 的 wrangler 配置文件参考页（Inheritable keys + Non-inheritable keys 全列表）**没有** `assets`、`not_found_handling`、`html_handling`；
  - Pages 的 Serving Pages 文档只用「有没有 `404.html`」来切换 SPA / 404 行为，未提供显式开关；
  - 官方迁移文档明确把「显式配置」列为 Workers 与 Pages 的**差异**：「Pages would automatically attempt to determine the type of project you deployed. It would look for `404.html` and `index.html` files as signals… In Workers, to prevent accidental misconfiguration, **this behavior is explicit and must be set up manually**.」
  - 来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated Jun 25, 2026）；<https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages>（Last updated Aug 14, 2026）
- **[未证实]** 在 Pages 项目的 `wrangler.jsonc` 里写 `assets.not_found_handling` 会不会被 wrangler 接受/报错——官方文档未说明。**不要依赖它**；不要把 Pages 与 Workers 两套配置混写（官方明说 Pages 的配置字段「do not match exactly」Workers）。

### 4.4 `_redirects` 与 `_routes.json` 的相互作用

**官方明文（可依据的部分）：**

1. **[官方明确]** 「Redirects defined in the `_redirects` file **are not applied to requests served by Pages Functions**, even if the Function route matches the URL pattern. If your Pages application uses Functions, you must migrate any behaviors from the `_redirects` file to the code in the appropriate `/functions` route, **or exclude the route from Functions**.」
   → 即：**Functions 优先**。凡是 `_routes.json` 把请求交给 Function 的路径，`_redirects` 一律不生效（`_headers` 同理）。
2. **[官方明确]** 被 `exclude` 的路由「will not invoke the Function and will not incur a Functions invocation charge」。
3. **[官方明确]** 「Redirects are always followed, regardless of whether or not an asset matches the incoming request.」（这条决定了 §4.5 的陷阱）

**官方没有明写、需要标注的部分：**

- **[未证实 / 需实测]** 「把 `/* /index.html 200` 写进 `_redirects` 会不会导致路由落到 Functions？」——官方**没有**任何一句把 `_redirects` 的 200 rewrite 与 Functions 调用挂钩。按官方模型（`_routes.json` 决定函数路由，`_redirects` 只在静态资产层生效），[官方间接] 结论是**不会**，但这是推断，不是原文 → 标注为需实测项（§6）。
- **[未证实 / 需实测]** 「命中 include 但没有任何 `/functions/*.js` 文件匹配的路径（例如 `include: ["/*"]` 时的 `/entry`）会不会仍计一次 Functions 调用？」官方只说「默认所有请求都会调用 Function」，也说了「If no Function is matched, it will fall back to a static asset if there is one. Otherwise, the Function will fall back to the default routing behavior for Pages' static assets」，但**没有明确这种 fallback 是否计入 Functions 请求数**。→ 这正是本票推荐 `include: ["/api/*"]`（而不是 `include: ["/*"]` + 长 exclude 列表）的原因：把不确定性消除掉。
- **[未证实]** `_redirects` 的 200 rewrite 目标（`/index.html`）响应上，`_headers` 里针对 `/*` 的规则是否生效（「redirects applied before headers」只说了重定向优先，没说 rewrite 后按哪条路径匹配 header）。→ 实测。

**为什么本票不推荐 `include: ["/*"]` + 长 exclude 列表**（官方自动生成的那种形态）：

- 自动生成的 exclude 列表通常枚举静态文件名（例如 `/_headers`、`/favicon.ico`、`/assets/*`、`/manifest.json`、`/sw.js` 等），**SPA 客户端路由路径（`/entry`、`/stocks/…`）不存在对应文件，天然不会出现在 exclude 里** → 这些请求会落在 include 内、走 Function 判定分支，把「不确知是否计费」的风险引进来（[官方间接] 分析）。
- 用 `include: ["/api/*"]` 把函数路由收窄到唯一需要它的前缀，语义与官方「exclude 静态路由以保住无限免费」的目标一致，且不受 exclude 枚举遗漏影响。

### 4.5 SPA fallback 与静态资源的优先级（经典陷阱）

**（a）官方能支撑的部分**

- **[官方明确]** `/* /index.html 200` 是合法写法（Proxying / 200）。
- **[官方明确]** 「Redirects are always followed, **regardless of whether or not an asset matches the incoming request**.」→ **[官方间接]** 只要你写了 `/* /index.html 200`，那么**不存在的 `/assets/foo.js` 也会命中 `/*`**，被 rewrite 成 `index.html` 并返回 **200**（而不是 404）。这正是「SPA fallback 把缺失资产变成 200 HTML」的经典陷阱，本项目必须避开。
- 官方 Proxying 章节还提到 200 rewrite 会有 SEO 重复内容问题（「Be aware that proxying pages can have an adverse effect on search engine optimization」），并建议配 `Link: <...>; rel="canonical"`。

**（b）官方没有明文的部分（必须实测）**

- **[未证实 / 需实测]** 如果不写 `_redirects`、**依赖 Pages 内建 SPA 行为**，那么不存在的 `/assets/foo.js` 是返回 **404** 还是 **200 + index.html**？
  - 官方原文只说内建 SPA 行为「matches **all incoming paths** to the root (`/`)」——字面上是「所有路径」，包括带扩展名的路径；
  - 但官方在 404 章节又说 Pages「will attempt to find the closest 404 page」——只有在**存在** `404.html` 时才成立（而存在 `404.html` 时 SPA 模式又关闭了）；
  - Workers 侧（另一个产品，不能直接套用）的 `not_found_handling = "single-page-application"` 近年引入了 `Sec-Fetch-Mode: navigate` 导航请求判定与 `run_worker_first` 精细化控制，说明 Cloudflare 确实在按「是否导航请求」区分，但**Pages 文档没有写这套判定**。
  - → 结论：**文档未明文，需实测**。用 §6 的两条 curl 对比（`/assets/不存在.js` vs `/entry`）即可判定。
  - 二手来源（仅线索，不作为依据）：一篇 2024-12 的技术博客实测表中给出「/about 之类不存在路径 → 404 或 serves / (SPA 模式)」，未区分扩展名情形。
- **[未证实 / 需实测]** 内建 SPA 行为返回的 `index.html`，其状态码是否一定是 200（官方只说「matches all incoming paths to the root」，未给状态码；Workers 侧明写 200）。

**（c）本项目的处置建议（工程选择，非官方规定）**

1. 优先依赖 Pages **内建 SPA 行为**（不放顶层 `404.html`，不写 `/* /index.html 200`）→ 官方明确、最少配置。
2. 若要显式化（避免团队后来人误加 `404.html`），可以用**更窄的规则**代替 `/*`，把静态资源目录排除掉，例如仅对前端路由前缀写 rewrite，或维持 `/* /index.html 200` 但在部署后用 §6 实测确认 `/assets/*` 行为可接受。**注意窄规则的写法需要实测**：splat 只能有一个、且是贪婪匹配。
3. 无论选哪种，都必须实测「不存在的 `/assets/foo.js`」的返回码——这是 SPA fallback 的唯一真实风险点。

---

## 5. 本项目落地建议（三个文件的完整内容）

> 本节是**基于上述官方事实的工程推荐**，不是官方规定。每个文件后标注仍需实测的项。

**`public/_routes.json`**（构建后成为 `dist/_routes.json`）

```json
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
```

- 效果 [官方间接 由官方语义推得]：仅 `/api/*` 调用 Pages Functions；SPA 路由、`/assets/*`、`/sw.js`、`/manifest.webmanifest` 全部走静态（保住「静态请求无限免费」）。
- 仍需实测：自带的 `_routes.json` 是否覆盖 Pages 自动生成的那一份（§6 步骤 4）。

**`public/_headers`**

```
# Service Worker：显式要求每次使用前校验（默认已是 max-age=0, must-revalidate）
/sw.js
  Cache-Control: no-cache

# PWA manifest 同理：小文件，避免陈旧
/manifest.webmanifest
  Cache-Control: no-cache

# Vite 内容哈希资产：官方示例即推荐长缓存
/assets/*
  Cache-Control: public, max-age=31556952, immutable
```

- 官方依据：`_headers` 可覆盖静态资产默认头、官方的 `/static/*` immutable 示例、`_headers` 不作用于 Functions 响应（<https://developers.cloudflare.com/pages/configuration/headers/>）。
- `/api/*` 的响应头（如 CORS、`Cache-Control: no-store`）**必须写在 Function 代码里**，不能靠 `_headers`。

**`_redirects`：本项目建议 _不创建_**（依赖 Pages 内建 SPA 行为）。若日后需要，务必按 §4.5(c) 处置并实测。

**`dist/` 顶层不要出现 `404.html`**（否则内建 SPA 模式被关闭）。

---

## 6. 未找到 / 未证实 / 需实测

### 6.1 缺口清单

| # | 缺口 | 状态 | 影响 |
|---|---|---|---|
| G1 | Cloudflare 官方对 **Service Worker / `sw.js`** 更新与缓存的专门表述 | **[未找到一手来源]** 官方 Pages/Workers 文档中未出现 `sw.js` 与缓存头的组合说明 | 只能依据「静态资产默认头」事实推断，属工程判断 |
| G2 | Pages 资产响应是否包含 **`cf-cache-status`**、其值语义 | **[未证实]** 官方头列表未列该头；二手来源互相矛盾（无该头 / `DYNAMIC` / `HIT`） | 影响「边缘缓存是否命中」的可观测性 |
| G3 | `_headers` 里的 `Cache-Control` **是否会改变 Cloudflare 边缘缓存的缓存决策**（Pages 资产走内部资产服务 + Tiered Cache，非普通 zone cache） | **[未证实]** 官方未明文 | 影响 `no-cache` / `no-store` 的实际语义边界 |
| G4 | 能否**关闭/绕过** Pages 静态资源的 CDN 缓存；`pages.dev` 域能否配 Cache Rules | **[未找到一手来源]** 官方只讲自定义域上的 Cache Rules | 若必须绕过，当前无官方路径 |
| G5 | 自带 `_routes.json` 是否**覆盖** Pages 自动生成的那份 | **[未证实]** 官方只说会「自动生成」 | 需实测 |
| G6 | 命中 `include` 但**没有匹配的 Function 文件**的路径（如 `include: ["/*"]` 时的 `/entry`），是否**计入 Functions 请求数/额度** | **[未证实]** 官方无明文 | 本票用 `include: ["/api/*"]` 规避 |
| G7 | `_redirects` 的 200 rewrite 是否**会导致请求落到 Functions**（是否吃 Workers 额度） | **[未证实]** 官方无明文；[官方间接] 结论是「不会」 | 需实测 |
| G8 | 不写 `_redirects`、依赖内建 SPA 时，**不存在的 `/assets/foo.js`** 返回 404 还是 200+index.html | **[未证实]** 官方只说「matches all incoming paths to the root」 | SPA fallback 经典陷阱，必须实测 |
| G9 | 内建 SPA fallback 返回 `index.html` 时的**状态码**是否一定 200 | **[未证实]** Pages 文档未给状态码（Workers 侧明写 200） | 影响前端/监控判断 |
| G10 | `_redirects` 200 rewrite 后，`_headers` 中 `/*` 规则是否对该响应生效 | **[未证实]** | 影响头策略的可预测性 |
| G11 | Pages 侧写 `assets.not_found_handling` 是否被 wrangler 接受 | **[未证实]** | 不建议使用，勿混写 Pages/Workers 配置 |
| G12 | 「Pages 已进入维护、新项目推荐 Workers」对既有 Pages 项目的时限承诺 | 官方推荐语句存在，但**无弃用日期/时间表**（检索 `developers.cloudflare.com/changelog/product/pages` 未发现 Pages 弃用公告；二手文章声称「2025-04 弃用」**未能在一手来源核实**） | 长期技术债风险，本票不改选型 |

### 6.2 可执行实测方法（部署一次即可全部回答）

```bash
BASE=https://<your-project>.pages.dev

# 1) /sw.js 的实际响应头（回答 G2/G3 的一半：默认 Cache-Control / ETag / 是否有 cf-cache-status / Age）
curl -sI "$BASE/sw.js" | grep -Ei '^(HTTP/|cache-control|etag|age|cf-cache-status|last-modified|content-encoding)'

# 2) 同一 URL 再请求一次，看 cf-cache-status 是否从 MISS/DYNAMIC 变成 HIT（判定边缘缓存是否生效）
curl -sI "$BASE/sw.js" | grep -Ei 'cf-cache-status|age'

# 3) SPA 客户端路由不应 404（期望 200）
curl -sI "$BASE/entry" | head -n 1
curl -sI "$BASE/stocks" | head -n 1

# 4) 不存在的静态资产：判定 SPA fallback 陷阱（G8/G9）
#    - 若返回 200 且 content-type 是 text/html（或 body 是 index.html）→ 陷阱存在，需要窄化规则
curl -sI "$BASE/assets/does-not-exist-$(date +%s).js" | grep -Ei '^(HTTP/|content-type)'
curl -s "$BASE/assets/does-not-exist-$(date +%s).js" | head -c 200

# 5) API 仍由 Function 提供（期望 200 + JSON 的 content-type）
curl -sI "$BASE/api/<health-endpoint>" | grep -Ei '^(HTTP/|content-type)'

# 6) 本地预演（wrangler 会读取 _routes.json 行为，能提前暴露 include/exclude 写法问题）
npx wrangler pages dev ./dist
```

**额度侧核对（回答 G6/G7）：**

- Dashboard → **Workers & Pages** → 本项目 → **Metrics**，看 `Functions requests` 曲线：
  1. 只访问 `/entry`、`/stocks`、`/assets/*`、`/sw.js` 若干次 → **曲线不应增长**（证明静态请求没走 Functions、没吃额度）；
  2. 再访问 `/api/*` 若干次 → 曲线应随之增长（证明 include 生效）。
- 若第 1 步曲线增长 → 说明当前 `_routes.json` 形态不对（例如被自动生成版本覆盖，或 include 写成了 `/*`），按 §5 修正后重测。

**用于判定 G5（自带 `_routes.json` 是否生效）的辅助方法：**

- 部署后拉取本次部署的产物对照：Cloudflare dashboard 的部署详情或 `wrangler pages deployment list`；更直接的是——若 `_routes.json` 未生效，步骤 3/6 的 Metrics 会立刻表现为「所有请求都算 Functions」。

### 6.3 明确不作为结论依据的二手来源（仅线索，复核时可用）

- Cloudflare Community 帖：`_redirects` 在 SSR/Functions 路由下失效、需调整 `_routes.json`（WalshyMVP / dougrichardson 回复，2023-02 / 2024-05）— 结论方向与官方 Caution 一致，但**不作为依据**。
- Cloudflare Community 帖：Pages 自定义域陈旧资产、`cf-cache-status: DYNAMIC`（2026-09-05）— 仅线索。
- Cloudflare Developers Discord 存档（GregBrimble 关于 `not_found_handling` 与 `Sec-Fetch-Mode: navigate` 的说明，2025-04）— 与官方 Workers 文档一致，但**属 Workers 语境**，不能外推到 Pages。
- 各类博客/项目 README 关于 `/sw.js → Cache-Control: no-store` 的建议 — 仅线索，**官方无相应表述**。

---

## 7. 来源清单（含 Last updated 与采集日期）

| 来源 | URL | 类型 | 页面自报 Last updated | 采集日期 |
|---|---|---|---|---|
| Pages · Headers（`_headers`） | <https://developers.cloudflare.com/pages/configuration/headers/> | 官方文档 | Aug 25, 2026 | 2026-09-16 |
| Pages · Redirects（`_redirects`） | <https://developers.cloudflare.com/pages/configuration/redirects/> | 官方文档 | Aug 25, 2026 | 2026-09-16 |
| Pages Functions · Routing（`_routes.json`、limits、fail open/closed） | <https://developers.cloudflare.com/pages/functions/routing/> | 官方文档 | Apr 21, 2026 | 2026-09-16 |
| Pages · Serving Pages（默认头、ETag、CDN/Tiered Cache、SPA、404） | <https://developers.cloudflare.com/pages/configuration/serving-pages/> | 官方文档 | Apr 21, 2026 | 2026-09-16 |
| Pages · Limits（`_headers` 100 条/2000 字符；`_redirects` 2100 条；文件数/大小） | <https://developers.cloudflare.com/pages/platform/limits/> | 官方文档 | 页面未显示 | 2026-09-16 |
| Pages Functions · Configuration（wrangler 配置键全表，无 `assets`/`not_found_handling`） | <https://developers.cloudflare.com/pages/functions/wrangler-configuration/> | 官方文档 | Jun 25, 2026 | 2026-09-16 |
| Pages · Build configuration（React (Vite) → `dist`） | <https://developers.cloudflare.com/pages/configuration/build-configuration/> | 官方文档 | Apr 21, 2026 | 2026-09-16 |
| Pages · React framework guide（默认按 SPA 处理） | <https://developers.cloudflare.com/pages/framework-guides/deploy-a-react-site/> | 官方文档 | Apr 21, 2026 | 2026-09-16 |
| Workers · Static Assets · SPA（`not_found_handling`、导航请求、路由决策图） | <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/> | 官方文档 | Aug 25, 2026 | 2026-09-16 |
| Workers · Static Assets · HTML handling（`html_handling` 取值表） | <https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/> | 官方文档 | 页面未显示 | 2026-09-16 |
| Workers · Static Assets（overview，`not_found_handling` 语义） | <https://developers.cloudflare.com/workers/static-assets/> | 官方文档 | 页面未显示 | 2026-09-16 |
| Workers · Migrate from Pages（Pages 自动探测 SPA vs Workers 显式配置） | <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages> | 官方文档 | Aug 14, 2026 | 2026-09-16 |
| Pages · Changelog（检索有无 Pages SPA/404 相关公告） | <https://developers.cloudflare.com/changelog/product/pages> | 官方 Changelog | 抓取片段内无相关条目 | 2026-09-16 |
| `cloudflare/workers-sdk` · Discussion #9143（静态路由 `_routes.json` 提案与路由优先级背景） | <https://github.com/cloudflare/workers-sdk/discussions/9143> | 官方仓库（PM/工程师） | 讨论帖，抓取内容未给创建日期 | 2026-09-16 |
| `cloudflare/workers-sdk` · PR #9280（Workers 侧 `_routes.json` 实现；exclude → Asset Worker，include → User Worker） | <https://github.com/cloudflare/workers-sdk/pull/9280> | 官方仓库源码/PR | merged **2025-05-22** | 2026-09-16 |
| Vite · Static Asset Handling（`public/` 原样复制到 dist 根） | <https://vite.dev/guide/assets#the-public-directory> | 上游官方文档 | 页面未显示 | 2026-09-16 |

---

## 8. 与本仓库既有笔记的关系

- 与本文件重叠、但不重复的部分见 `docs/research/cloudflare-free-tier-constraints.md`（Pages Functions 绑定能力、Workers Free 限额、Cron 需独立 Worker 等）。该文第 1.2 节已记录 `_routes.json` 的基本限制，**本文件是对它未展开的三个门禁问题（位置语义 / `sw.js` 缓存 / SPA 404）的补充与更正依据**：
  - 本文件确认：`_routes.json` 的官方位置表述为「build directory / output directory」（`dist/_routes.json`），本仓库按 Vite 惯例写 `public/_routes.json`；
  - 本文件新增（既有笔记未记录）：Pages 静态资产**默认** `Cache-Control: public, max-age=0, must-revalidate`、`ETag` + 304、Tiered Cache 自动启用、资产 TTL 一周；
  - 本文件新增：Pages 的 SPA 行为是**自动**的（无顶层 `404.html` 时），且 Pages **没有** `not_found_handling` 配置键。
