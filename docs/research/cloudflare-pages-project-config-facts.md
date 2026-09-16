# 家庭财务系统 · Cloudflare Pages 项目与独立 Worker 的配置落点 — 一手事实清单

> **研究性质**：联网检索 `developers.cloudflare.com` 官方文档、Cloudflare 官方博客、`cloudflare/workers-sdk` 仓库**源码**（main 分支快照），逐条核对一手来源。
> **采集日期**：**2026-09-16**（以下所有 URL 均于该日访问；每条来源另附其文档自带 “Last updated” 日期）。
> **范围**：单仓库（monorepo）内同时存在 **Pages 项目（含 `functions/`）** 与 **独立 Cron Worker** 时，各自的配置文件如何落位；Pages 项目的 `wrangler.toml` 支持范围与不支持项；D1 绑定与 `database_id` 的管理方式；local / preview / production 三档环境；环境变量与 Secrets 的定义方式与上限。
> **不重复调研**：Pages 无 Cron Triggers、免费账户 Cron ≤5/账户、免费 CPU 10 ms、D1 读写额度与 `batch()`、`pages.dev` 在 PSL PRIVATE 段等事实已冻结在前述报告中（见文末 §9），本文件只在需要交叉引用时点出。
>
> **标注规则**（沿用既有报告口径）
> - **[官方明确]** = 官方文档 / 官方博客 / 官方仓库源码**逐字写明**；
> - **[官方间接]** = 官方材料可逻辑推导（例如由多份官方原文 + 源码查找逻辑共同得出）；
> - **[未找到一手来源]** = 官方文档与官方仓库中均未给出明确说法。
>
> **取证方式说明**：`developers.cloudflare.com` 页面同时抓取了 HTML 版与官方 “View as Markdown” 版（`.../index.md`）；仓库侧引用 `raw.githubusercontent.com` 的 main 分支快照，并记录 blob SHA。**二手博客、知乎/掘金/CSDN、Discord 转帖、AI 生成站点一律未作为结论依据**（个别处仅用于提示"需实测"，已明确标注）。

---

## 0. 结论速览

| # | 问题 | 结论 | 标注 |
|---|---|---|---|
| 1 | 一个仓库里同时放 Pages 项目与独立 Worker，官方支持吗 | **官方支持**：Pages 官方有 Monorepos 页，允许"同一仓库多个项目 + 用 root directory 指定子目录"；同一仓库最多 **5 个 Pages 项目** | [官方明确] |
| 2 | 两份 `wrangler.toml`（不同子目录）能否共存 | **没有禁止，且机制上成立**：wrangler 从当前工作目录**向上查找**配置文件，取最近的一个；但官方**没有一句**明文说"一个仓库允许多份 wrangler 配置" | [官方间接] |
| 3 | Pages 侧配置必须有 `pages_build_output_dir` 且**不能有 `main`** | **核实成立**。文档：`main` 等 Workers 专用键 "do not apply to a Pages Function's Wrangler configuration file"；源码校验报错：不能同时含 `main` 与 `pages_build_output_dir`。源码判定"是否 Pages 配置"的唯一依据就是 `pages_build_output_dir` 是否存在 | [官方明确]（文档 + 源码） |
| 4 | Pages 侧 `name` 是否必填 | **必填**（源码报错："Missing top-level field \"name\"… Pages requires the name of your project to be configured at the top-level"） | [官方明确] |
| 5 | Worker 侧必须有 `name` + `main` | **成立**：文档 "At a minimum, the `name`, `main` and `compatibility_date` keys are required to deploy a Worker." | [官方明确] |
| 6 | Git 集成建 Pages 项目能否指定子目录为项目根 | **能**："Root directory (advanced) > Path" 字段；官方明说"root directory 需要在 monorepo 这类场景下指定" | [官方明确] |
| 7 | `functions/` 相对谁定位 | **相对"Pages 项目根目录"，不在构建输出目录**。逐字："Make sure that the `/functions` directory is at the root of your Pages project (and not in the static root, such as `/dist`)." | [官方明确] |
| 8 | Pages 项目里 `wrangler.toml` 放哪 | 官方多处只说 "in the root of your Pages project" / "your project's root directory"；**没有**把 dashboard 的 Root directory 设置与本文件的查找机制直接挂钩的明文 | [官方明确]（root）+ [未找到一手来源]（Root directory 与查找机制的挂钩） |
| 9 | Pages 能否用 `wrangler.toml` 声明绑定 | **能**：`vars` / `d1_databases` / `kv_namespaces` / `r2_buckets` / `services` / `analytics_engine_datasets` / `ai` / `vectorize` / `hyperdrive` / `durable_objects` / `queues.producers` 均在支持清单内 | [官方明确] |
| 10 | Pages 配置里能否写 `secrets` | **不能**。源码 `supportedPagesConfigFields` 不含 `secrets`（会报 `Configuration file for Pages projects does not support "secrets"`）；Pages 文档里 Secrets 只给 dashboard 路径（`wrangler pages secret put` 是命令，不是配置文件键） | [官方明确]（源码）+ [官方间接]（文档侧） |
| 11 | Pages 配置能否用任意 `[env.*]` | **不能**，只允许 `production` 与 `preview`。源码报错 "The supported named-environments for Pages are \"preview\" and \"production\"." | [官方明确] |
| 12 | Pages 配置能否用 `vars` | **能**（属 non-inheritable keys） | [官方明确] |
| 13 | 一个 Pages 项目能否有多个 wrangler 配置文件 | 官方**无**"允许/禁止"明文；源码在同一目录只取**一个**，优先级 `wrangler.json` → `wrangler.jsonc` → `wrangler.toml` | [官方间接]（源码） |
| 14 | `database_id` 该写死还是走 Secrets | 官方把它定义为普通 `string` 必填字段、示例一律**明文写在配置文件里**，且从未列入 secrets；但**没有**"可以公开提交到 public 仓库"的明文承诺 | [官方间接] + [未找到一手来源]（公开安全性） |
| 15 | production / preview 是否各自绑定同一个 D1 | **能分别设置**（"You can set bindings for both production and preview environments."；`[env.preview]` / `[env.production]` 可覆盖）；**preview 默认是否复用 production 的那份绑定，官方无逐字说明 → 未证实** | [官方明确]（可分别设置）+ [未找到一手来源]（默认是否继承） |
| 16 | Pages 有哪些环境档位 | **只有三档语境：local（`wrangler pages dev`）/ preview deployments / production**；命名环境只有 `preview` 与 `production`，**没有官方 staging 档** | [官方明确] |
| 17 | Pages 免费版环境变量 / Secrets 数量上限 | **Pages Limits 页未列**。Workers Limits 页给出 `Variables per Worker (secrets + text) = 64（Free）/ 128（Paid）`、`Variable size = 5 KB`；是否原样适用于 Pages **无明文** | [未找到一手来源]（Pages 侧）+ [官方明确]（Workers 侧） |
| 18 | `.dev.vars` 是否入库 | **不得入库**。逐字："The `.dev.vars` and `.env` files should not be committed to git. Add `.dev.vars*` and `.env*` to your project's `.gitignore` file." | [官方明确] |

---

## 1. monorepo 目录结构：Pages 项目 + 独立 Worker 如何共存

### 1.1 官方支持 monorepo（子目录即项目）

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/configuration/monorepos/>（Last updated **Apr 21, 2026**）

> "While some apps are built from a single repository, Pages also supports apps with more complex setups. A monorepo is a repository that has multiple subdirectories each containing its own application."

> "You can create multiple projects using the same repository, in the same way that you would create any other Pages project. You have the option to vary the build command and/or root directory of your project to tell Pages where you would like your build command to run. All project names must be unique even if connected to the same repository."

Limitations 一节逐字：

> "You must be using Build System V2 or later in order for monorepo support to be enabled."
> "You can configure a maximum of 5 Pages projects per repository. If you need this limit raised, contact your Cloudflare account team or use the Limit Increase Request Form."

以及：

> "While Pages does not provide specialized tooling for dependency management in monorepos, you may choose to bring additional tooling to help manage your repository."

**对本项目的含义**：`前端 Pages 项目` + `Cron Worker` 放在同一仓库，**不触碰"5 个 Pages 项目/仓库"上限**（Cron Worker 不是 Pages 项目，不计数）。但需注意 **Build System V2** 这个前提。

### 1.2 两个 `wrangler.toml` 能否共存于同一仓库（不同子目录）

**[官方间接]（文档口径）**：
- Pages 侧把 wrangler 配置文件作为**该项目**配置的唯一真相源：
  > "If using a Wrangler configuration file, you must treat your file as the source of truth for your Pages project configuration."
  > "This file becomes the source of truth when used, meaning that you can not edit the same fields in the dashboard once you are using this file."
  来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated **Jun 25, 2026**）
- Worker 侧同样是各自项目的真相源：
  > "We recommend treating your Wrangler configuration file as the source of truth for your Worker configuration…"
  来源：<https://developers.cloudflare.com/workers/wrangler/configuration/>（Last updated **Sep 4, 2026**）
- D1 文档明确承认 monorepo 里可以有多个包各自的 wrangler 配置：
  > `migrations_dir` … "Use `migrations_dir` to specify a different folder containing the migration files (for example, if you have a mono-repo setup, and want to use a single D1 instance across your apps/packages)."
  来源：同 Workers wrangler configuration 页（**Sep 4, 2026**）

**[官方间接]（源码机制）** 来源：`cloudflare/workers-sdk`，`main` 分支快照（采集于 **2026-09-16**）
`packages/workers-utils/src/config/config-helpers.ts`：

> `/** Find the wrangler configuration file by searching up the file-system from the current working directory. */`
> `export function findWranglerConfig(referencePath: string = process.cwd(), { useRedirectIfAvailable = false } = {}): ConfigPaths {`
> `	const userConfigPath =`
> `		find.file(\`wrangler.json\`, { cwd: referencePath }) ??`
> `		find.file(\`wrangler.jsonc\`, { cwd: referencePath }) ??`
> `		find.file(\`wrangler.toml\`, { cwd: referencePath });`

> `/** Resolve the path to the configuration file, given the `config` and `script` optional command line arguments. `config` takes precedence, then `script`, then we just use the cwd. */`
> `export function resolveWranglerConfigPath({ config, script }, options): ConfigPaths {`
> `	if (config !== undefined) { return { userConfigPath: config, configPath: config, deployConfigPath: undefined, redirected: false }; }`
> `	const leafPath = script !== undefined ? path.dirname(script) : process.cwd();`
> `	return findWranglerConfig(leafPath, options);`

URL：<https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/workers-utils/src/config/config-helpers.ts>

**推导结论（3 条，均为 [官方间接]）**
1. wrangler 解析配置的落脚点是**当前工作目录（或 `--cwd` / `--config` 指定处）**，并**向上逐级查找**，取**最近的一个**配置文件。因此在 `repo/frontend/` 下执行 `wrangler pages deploy` 只会命中 `repo/frontend/wrangler.toml`，在 `repo/cron-worker/` 下执行 `wrangler deploy` 只会命中 `repo/cron-worker/wrangler.toml`——**两份文件互不干扰**。
2. **风险点**：向上查找意味着若子目录里**没有**配置文件，wrangler 会继续向上找到仓库根的配置文件。因此**不要把"某个部署单元该用哪份配置"建立在隐式查找上**，要么保证每个部署单元目录都有自己的配置文件，要么显式 `--config`。
3. 同一目录下若同时存在 `wrangler.json` 与 `wrangler.toml`，按源码优先级只取 **`wrangler.json`**（其次 `.jsonc`，最后 `.toml`）。目录里"多个配置文件"不会被合并。

> **官方明文缺口**：官方文档**没有**任何一句写"一个仓库里允许/禁止存在多份 wrangler 配置文件"。上述结论是从官方 monorepo 文档 + 官方仓库源码的查找逻辑推出的，属 **[官方间接]**，不是官方承诺。→ 见 §8。

### 1.3 建议的目录布局（**本报告的推论，不是官方推荐**）

> ⚠️ 官方**没有**给出"Pages + 独立 Worker 共存"的目录布局示例。下面是基于 §1.1/§1.2 的**推论**，属 [官方间接]，落地前请按 §7 的清单验证。

```
repo/
  frontend/                 # ← Pages 项目的「root directory」
    functions/              #   必须在「Pages 项目根」而非 build 输出目录
      _middleware.ts
      api/...
    dist/                   #   Vite 构建输出 = pages_build_output_dir
    wrangler.toml           #   Pages 配置：必须有 pages_build_output_dir，绝不能有 main
    package.json
  cron-worker/              # ← 独立 Worker（无 Pages 项目概念）
    src/index.ts            #   scheduled() handler
    wrangler.toml           #   Worker 配置：必须有 name + main + triggers.crons
    package.json
```

Pages 侧最小配置（字段名照官方示例）：

```toml
name = "family-finance"
pages_build_output_dir = "./dist"
compatibility_date = "2026-09-16"
[[d1_databases]]
binding = "DB"
database_name = "family"
database_id = "<SAME_ID>"
```

Worker 侧最小配置：

```toml
name = "finance-cron"
main = "src/index.ts"
compatibility_date = "2026-09-16"
[triggers]
crons = ["0 16 * * *"]
[[d1_databases]]
binding = "DB"
database_name = "family"
database_id = "<SAME_ID>"
```

---

## 2. Pages 项目的「root directory」、`functions/` 位置、`wrangler.toml` 位置

### 2.1 Git 集成能否指定子目录作为项目根 —— **能**

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/get-started/git-integration/>（Last updated **Apr 21, 2026**）

> "Cloudflare Pages begins by working from your repository's root directory. The entire build pipeline, including the installation steps, will begin from this location. If you would like to change this, specify a new root directory location through the **Root directory (advanced)** > **Path** field."

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/configuration/build-configuration/>（Last updated **Apr 21, 2026**）

> "The root directory is where your site's content lives. If not specified, Cloudflare assumes that your linked git repository is the root directory. The root directory needs to be specified in cases like monorepos, where there may be multiple projects in one repository."

同页还给出 **React (Vite)** 的官方 preset：`Build command = npm run build`、`Build directory = dist`。

**同一页（构建期环境变量）** 逐字列出 Pages 自动注入的系统变量（可用于构建脚本判断环境）：

> | `CI` | `true` | … |
> | `CF_PAGES` | `1` | … |
> | `CF_PAGES_COMMIT_SHA` | `<sha1-hash-of-current-commit>` | … |
> | `CF_PAGES_BRANCH` | `<branch-name-of-current-deployment>` | … |
> | `CF_PAGES_URL` | `<url-of-current-deployment>` | … |

（原文注："The following system environment variables are injected by default (but can be overridden)".）

### 2.2 `functions/` 相对谁定位 —— **相对"Pages 项目根"，绝不在构建输出目录**

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/get-started/>（Last updated **Apr 21, 2026**）

> "To get started with generating a Pages Function, create a `/functions` directory. **Make sure that the `/functions` directory is at the root of your Pages project (and not in the static root, such as `/dist`).**"

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/routing/>（Last updated **Apr 21, 2026**）

> "Functions utilize file-based routing. Your `/functions` directory structure determines the designated routes that your Functions will run on. You can create a `/functions` directory with as many levels as needed for your project's use case."

> "This file [`_routes.json`] will be automatically generated if a `functions` directory is detected in your project when you publish your project with Pages CI or Wrangler."
> "Create a `_routes.json` file to control when your Function is invoked. **It should be placed in the build directory of your project.**"

**对照证据（`/functions` 与「输出目录」是两个不同位置）** —— [官方明确]，来源：<https://developers.cloudflare.com/pages/functions/advanced-mode/>（Last updated **Apr 21, 2026**）

> "Pages offers the ability to define a `_worker.js` file **in the output directory** of your Pages project."
> "make sure your `_worker.js` file is placed in your Pages' project output directory"

即：`functions/` 在**项目根**，`_routes.json` 与 `_worker.js` 在**构建输出目录**（`dist/`）。两者不可混淆。

> **[未找到一手来源]**：官方**没有**用一句话把"`root directory (advanced)` 设置"与"`functions/` 的定位基准"直接绑定（即没有写 "functions/ 是相对 Root directory 解析的"）。上文的对应关系是从 "at the root of your Pages project" 与 monorepo 文档中"root directory = 你的站点内容所在处"两句推出的。→ 见 §8。

### 2.3 Pages 项目里 `wrangler.toml` 的位置要求

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/best-practices/local-development/>（Last updated **Jun 25, 2026**）

> "You can only develop against a *local* D1 database when using Cloudflare Pages by **creating a minimal Wrangler configuration file in the root of your Pages project**."

**[官方明确]** 来源：Cloudflare 官方博客（2024-04-04）<https://blog.cloudflare.com/pages-workers-integrations-monorepos-nextjs-wrangler/>

> "Run this command, add the **wrangler.toml file that it generates to your project's root directory**, and then when you deploy, your project will be configured based on this configuration file."

> "Write configuration that is shared across environments. **Define bindings and environment variables for local, preview, and production in one file.**"

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>（Last updated **Aug 14, 2026**）

> "If your project doesn't already have one, create a Wrangler configuration file (either wrangler.jsonc, wrangler.json or wrangler.toml) **in the root of your project**."

**Pages 侧配置的硬性前置条件** —— [官方明确]，来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated **Jun 25, 2026**）

> "Pages Functions configuration via the Wrangler configuration file **requires the V2 build system** or later."
> "You must have **Wrangler version 3.45.0 or higher** to use a Wrangler configuration file for your Pages project's configuration."
> "As of Wrangler v3.91.0, Wrangler supports both JSON (`wrangler.json` or `wrangler.jsonc`) and TOML (`wrangler.toml`) for its configuration file. Prior to that version, only `wrangler.toml` was supported."

> **[未找到一手来源]**：官方**没有**明文说明"Git 集成构建时，Pages 从哪个目录读取 wrangler 配置文件"（是 Root directory？还是 build 输出目录？还是仓库根？）。上文的"项目根"来自官方措辞，但**未**与 dashboard 的 `Root directory (advanced)` 字段显式挂钩。→ 见 §8。

---

## 3. Pages 用 `wrangler.toml` 配置绑定：支持范围与**不支持项**

### 3.1 总体口径

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated **Jun 25, 2026**）

> "Pages Functions can be configured two ways, either via the Cloudflare dashboard or the Wrangler configuration file…"
> "**If using a Wrangler configuration file, you must treat your file as the source of truth for your Pages project configuration.**"
> "Using the Wrangler configuration file to configure your Pages project allows you to: Store your configuration file in source control… Edit your configuration via your code editor… Write configuration that is shared across environments. Define configuration like bindings for local development, preview and production in one file. Ensure better access control…"

**与 Workers 配置文件的差异（逐字）**：

> "The configuration fields **do not match exactly** between Pages Functions Wrangler file and the Workers equivalent. For example, configuration keys like `main`, which are Workers specific, **do not apply to** a Pages Function's Wrangler configuration file. Some functionality supported by Workers, such as module aliasing cannot yet be used by Cloudflare Pages projects."
> "The Pages' Wrangler configuration file introduces a new key, `pages_build_output_dir`, which is only used for Pages projects."
> "The concept of environments and configuration inheritance in this file **is not** the same as Workers."
> "This file becomes the source of truth when used, meaning that you **can not edit the same fields in the dashboard** once you are using this file."

### 3.2 官方文档列出的支持清单（inheritable / non-inheritable）

**[官方明确]** 同页。

**Inheritable keys**（顶层配置，可被环境配置继承或覆盖）：

| key | 必填 | 官方描述 |
|---|---|---|
| `name` | **required** | "The name of your Pages project. Alphanumeric and dashes only." |
| `pages_build_output_dir` | **required** | "The path to your project's build output folder. For example: `./dist`." |
| `compatibility_date` | **required** | "A date in the form `yyyy-mm-dd`…" |
| `compatibility_flags` | optional | "A list of flags that enable features…" |
| `send_metrics` | optional | "Whether Wrangler should send usage data to Cloudflare for this project. Defaults to `true`." |
| `limits` | optional | "Configures limits to be imposed on execution at runtime." |
| `placement` | optional | "Specify how Pages Functions should be located to minimize round-trip time." |
| `upload_source_maps` | optional | "…Wrangler will upload any server-side source maps part of your Pages project…" |

**Non-inheritable keys**（顶层配置，但一旦为某环境覆盖了任意一个，所有 non-inheritable key 都必须在环境配置里一并给出）：

`vars`、`d1_databases`、`durable_objects`、`hyperdrive`、`kv_namespaces`、`queues.producers`、`r2_buckets`、`vectorize`、`services`、`analytics_engine_datasets`、`ai`。

> 原文（关键约束）：
> "Non-inheritable keys are configurable at the top-level, but, if any one non-inheritable key is overridden for any environment (for example,`[[env.production.kv_namespaces]]`), **all non-inheritable keys must also be specified in the environment configuration and overridden**."
> "This will work for local development, but **will fail to validate when you try to deploy**."

**文档在支持清单里明确不包含**：`main`、`account_id`、`route`/`routes`、`workers_dev`、`rules`、`tail_consumers`、`secrets`、`assets`、`site`、`keep_vars`、`queues.consumers`。

### 3.3 源码侧的机器可读支持清单（**最权威的"不支持项"依据**）

**[官方明确]**（官方仓库源码）来源：`cloudflare/workers-sdk`，`main` 分支快照，blob SHA `d6ba240c405842dd236674b3cdb9a330fdd3a04e`（采集于 **2026-09-16**）
URL：<https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/workers-utils/src/config/validation-pages.ts>

文件头注释逐字：

> `/**`
> ` * Pages now supports configuration via a Wrangler configuration file. As opposed to`
> ` * Workers however, Pages only supports a limited subset of all available`
> ` * configuration keys.`
> ` *`
> ` * This file contains all Wrangler configuration file validation things, specific to`
> ` * Pages.`
> ` */`

白名单逐字：

```ts
const supportedPagesConfigFields = [
	"pages_build_output_dir",
	"name",
	"compatibility_date",
	"compatibility_flags",
	"send_metrics",
	"no_bundle",
	"limits",
	"placement",
	"vars",
	"durable_objects",
	"kv_namespaces",
	"queues", // `producers` ONLY
	"r2_buckets",
	"d1_databases",
	"vectorize",
	"hyperdrive",
	"services",
	"analytics_engine_datasets",
	"ai",
	"version_metadata",
	"dev",
	"mtls_certificates",
	"browser",
	"upload_source_maps",
	// normalizeAndValidateConfig() sets these values
	"configPath",
	"userConfigPath",
	"topLevelName",
	"definedEnvironments",
	"targetEnvironment",
] as const;
```

**注意**：白名单里**没有** `secrets`、**没有** `main`、**没有** `account_id`、**没有** `route`/`routes`、**没有** `workers_dev`、**没有** `rules`、**没有** `assets`。凡不在白名单且被显式写入配置文件的键，都会命中：

> `Configuration file for Pages projects does not support "${field}"`

（`queues.consumers` 单独报 `Configuration file for Pages projects does not support "queues.consumers"`。）

**`main` 与 `pages_build_output_dir` 不能共存（逐字报错）**：

```ts
function validateMainField(config: Config, diagnostics: Diagnostics) {
	if (config.main !== undefined) {
		diagnostics.errors.push(
			`Configuration file cannot contain both both "main" and "pages_build_output_dir" configuration keys.\n` +
				`Please use "main" if you are deploying a Worker, or "pages_build_output_dir" if you are deploying a Pages project.`
		);
	}
}
```

**`name` 必填（逐字报错）**：

> `Missing top-level field "name" in configuration file.\nPages requires the name of your project to be configured at the top-level of your Wrangler configuration file. This is because, in Pages, environments target the same project.`

**环境名只允许 `preview` 与 `production`（逐字报错）**：

> `Configuration file contains the following environment names that are not supported by Pages projects:\n<names>.\nThe supported named-environments for Pages are "preview" and "production".`

**"这是不是一份 Pages 配置"的判定依据** —— [官方明确]（源码）
来源：<https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/workers-utils/src/config/validation.ts>

```ts
export function isPagesConfig(rawConfig: RawConfig): boolean {
	return rawConfig.pages_build_output_dir !== undefined;
}
```

> 历史旁证（同一判定，早期位于 wrangler 内）：`packages/wrangler/src/config/index.ts` @ commit `1acbf5211656b82c6688dcf82db4fae74ff06428` 的注释逐字：
> "The `pages_build_output_dir` config key is used to determine if the configuration file belongs to a Workers or Pages project. **This key should always be set for Pages but never for Workers.**"
> URL：<https://github.com/cloudflare/workers-sdk/blob/1acbf5211656b82c6688dcf82db4fae74ff06428/packages/wrangler/src/config/index.ts>

### 3.4 Worker 侧必填字段（与 Pages 侧对照）

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/wrangler/configuration/>（Last updated **Sep 4, 2026**）

> "At a minimum, the `name`, `main` and `compatibility_date` keys are required to deploy a Worker."
> "The `main` key is optional for assets-only Workers."

| key | 必填 | 官方描述 |
|---|---|---|
| `name` | required | "The name of your Worker. Alphanumeric characters and dashes only. Do not use underscores… Worker names can be up to 255 characters." |
| `main` | required | "The path to the entrypoint of your Worker that will be executed. For example: `./src/index.ts`." |
| `compatibility_date` | required | "A date in the form `yyyy-mm-dd`…" |

→ **[官方明确]** 用户提出的三条说法（Pages 侧必须有 `pages_build_output_dir` 且不能有 `main`；Worker 侧必须有 `name` + `main`）**全部核实成立**：前者同时有文档原文与源码报错双重依据，后者有文档原文。

---

## 4. D1 绑定与 `database_id` 的管理方式

### 4.1 `database_id` 是普通配置字段，不是秘密

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/wrangler/configuration/>（Last updated **Sep 4, 2026**）

```toml
[[d1_databases]]
binding = "<BINDING_NAME>"
database_name = "<DATABASE_NAME>"
database_id = "<DATABASE_ID>"
```

各字段逐字：

> `binding` `string` required — "The binding name used to refer to the D1 database… The binding must be a valid JavaScript variable name."
> `database_name` `string` required — "The name of the database. This is a human-readable name that allows you to distinguish between different databases, and is set when you first create the database."
> `database_id` `string` required — "The ID of the database. The database ID is available when you first use `wrangler d1 create` or when you call `wrangler d1 list`, and uniquely identifies your database."
> `preview_database_id` `string` optional — "The preview ID of this D1 database. If provided, `wrangler dev` uses this ID. Otherwise, it uses `database_id`. **This option is recommended when using `wrangler dev --remote` to avoid using your production database.**"
> `migrations_dir` `string` optional — "…(for example, if you have a mono-repo setup, and want to use a single D1 instance across your apps/packages)."
> `migrations_pattern` `string` optional — "A glob pattern (relative to your Wrangler config file) used to discover migration files. Defaults to `migrations/*.sql`."

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/secrets/>（Last updated **Jul 3, 2026**）

> "Secrets are a type of binding that allow you to attach **encrypted** text values to your Worker."
> "**Do not use `vars` to store sensitive information** in your Worker's Wrangler configuration file. Use secrets instead."
> "Put secrets for use in local development in either a `.dev.vars` file or a `.env` file, **in the same directory as the Wrangler configuration file**."
> "The `.dev.vars` and `.env` files **should not be committed to git**. Add `.dev.vars*` and `.env*` to your project's `.gitignore` file."

**[官方间接]（结论）**：`database_id` 在官方体系里被当作**普通标识符**处理——它是 `required` 的 `string`，官方所有示例都把它**明文写在** `wrangler.toml` / `wrangler.jsonc` 中；它从未出现在 "Secrets" 的机制里，也不属于"应放进 `.dev.vars` / 环境变量"的内容。因此**按官方设计意图，它随配置文件入库（含 public 仓库）是被预期的用法**。
**[未找到一手来源]**：官方**没有**任何一句明文承诺 "`database_id` 可以安全公开"、也没有说 "`database_id` 不是敏感信息"。也没有任何一处建议把 `database_id` 改走环境变量/Secrets。→ 见 §8。

> 补充：D1 的 `database_id` 与绑定名 `binding` 在运行时通过 `context.env.<BINDING>` 暴露（Pages 与 Worker 一致），绑定关系由 `database_id` 唯一确定；"两个部署单元填同一个 `database_id` 即共享同一库"这一冻结事实与本节字段定义一致（另见 `cloudflare-free-tier-constraints.md` §2.2/§2.3）。

### 4.2 Pages 的 production / preview 能否各自绑定不同 D1

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/bindings/>（Last updated **Jun 25, 2026**）

> "A binding enables your Pages Functions to interact with resources on the Cloudflare developer platform… **You can set bindings for both production and preview environments.**"
> "Pages Functions only support a subset of all bindings, which are listed on this page."

Dashboard 路径（D1 一节逐字）：

> "To configure a D1 database binding via the Cloudflare dashboard: … 2. Select your Pages project. 3. Go to **Settings** > **Bindings** > **Add**> **D1 database bindings**. 4. Give your binding a name under **Variable name**. 5. Under **D1 database**, select your desired D1 database. 6. **Redeploy your project for the binding to take effect.**"

Wrangler 配置文件路径（同一节逐字）：

> "To bind your D1 database to your Pages Function, you can configure a D1 database binding in the [Wrangler configuration file] or the Cloudflare dashboard."
> Note: "If a binding is specified in a Wrangler configuration file and via a command-line argument, **the command-line argument takes precedence**."

其他绑定页面在 dashboard 步骤中显式出现环境选择（说明 production / preview 是两个独立目标），例如 Vectorize 一节逐字：

> "2. **Choose whether you would like to set up the binding in your Production or Preview environment.**"

以及 Workers AI 一节逐字："Select your Pages environment > **Bindings** > **Add** > **Workers AI**."

**preview 与 production 用配置文件区分** —— [官方明确]，来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated **Jun 25, 2026**）

> "It is possible to override configuration for production and preview deployments by using `[env.production]` or `[env.preview]`."
> Note: "Unlike Workers Environments, `production` and `preview` are **the only two options** available via `[env.<ENVIRONMENT>]`."
> "If you deployed this file via `wrangler pages deploy`, `name`, `pages_build_output_dir`, `kv_namespaces`, and `vars` would apply the configuration to **local and production**, while `env.preview` would override `kv_namespaces` and `vars` for **preview deployments**."

### 4.3 **preview 部署默认能否访问生产 D1 —— 未证实（关键缺口）**

**[官方间接]（推得的两种读法，互相不完全一致）**

- 读法 A（**不支持继承**）：上引 "…would apply the configuration to **local and production**, while `env.preview` would override…" 只把顶层值说成作用于 "local and production"，**没有说顶层值也作用于 preview** → 若某绑定只在顶层声明，preview 可能**拿不到**该绑定。
- 读法 B（**支持继承**）：同一页的 Non-inheritable keys 规则说顶层 non-inheritable key"**can be inherited (or overridden) by environment-specific configuration**"（inheritable 定义），且"若为某环境覆盖了任意 one non-inheritable key，则所有 non-inheritable key 都要在该环境里一并给出"——这套规则只有在"顶层值默认对所有环境生效"时才有意义 → 若绑定只在顶层声明，preview 应当**同样拿到生产 D1**。

**[未找到一手来源]**：官方**没有任何一句**写明 "preview deployments 默认使用 production 的绑定" 或 "默认不使用"。因此——**preview 部署默认是否指向生产 D1，本报告判为「未证实」，不做推断填充**。这是本项目"鉴权只覆盖 `/api/*` + 不透明 token + 同库"设计里风险最高的一条行为假设，**必须实测**（见 §8 与 §7）。

**相关旁证（不构成对本条的证明）**
- [官方明确] D1 local development 页（**Jun 25, 2026**）："Note that `wrangler dev` separates local and production (remote) data. **A local session does not have access to your production data by default.**" / "**It is currently not possible to develop against a *remote* D1 database when using Cloudflare Pages.**"
  → 这条只覆盖 **local**（`wrangler pages dev`），**不覆盖 preview deployments**，不可外推。
- [官方明确] migrate-from-pages 页（**Aug 14, 2026**）："**Pages automatically creates a preview environment for each project, and can be independently configured.**" / "**Unlike Pages, Workers does not natively support defining different bindings in production vs. non-production builds.**"
  → 反证 Pages **支持** production / non-production 绑定分离，但"默认是否相同"仍未说明。
- [官方明确] 同页 compatibility matrix 脚注 3（DO 场景）："To use Durable Objects with your Cloudflare Pages project, you must create a separate Worker with a Durable Object and then **declare a binding to it in both your Production and Preview environments**."
  → 这条**暗示**在 Pages 里 production 与 preview 的绑定需要**分别声明**（而非自动继承），但它是脚注、针对 DO，措辞是"建议做法"而非"默认语义"。

### 4.4 Pages 本地开发时 `preview_database_id` 的要求

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/best-practices/local-development/>（Last updated **Jun 25, 2026**）

> "You can only develop against a *local* D1 database when using Cloudflare Pages by creating a minimal Wrangler configuration file in the root of your Pages project."

官方示例（逐字，含注释）：

```jsonc
{
	// If you are only using Pages + D1, you only need the below in your Wrangler config file to interact with D1 locally.
	"d1_databases": [
		{
			"binding": "DB", // Should match preview_database_id
			"database_name": "YOUR_DATABASE_NAME",
			"database_id": "the-id-of-your-D1-database-goes-here", // wrangler d1 info YOUR_DATABASE_NAME
			"preview_database_id": "DB" // Required for Pages local development
		}
	]
}
```

> 注意 `preview_database_id` 在 **Pages local development** 语境下的语义是"**本地库的标识**"（注释：**Required for Pages local development**；"Should match preview_database_id"），与 Worker 语境下"远程预览库"的语义**不同**。两者不可混为一谈。

---

## 5. 环境划分：local / preview / production

### 5.1 官方对三档的表述

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>（Last updated **Jun 25, 2026**）

> "With a Wrangler configuration file, you can quickly set configuration across your **local environment, preview deployments, and production**."
> "The Wrangler configuration file applies **locally** when using `wrangler pages dev`."
> "**Environment-specific overrides**: There are times that you might want to use different configuration across local, preview deployments, and production."
> "To deploy the configuration for preview deployments, you can run the same command as above while on a branch you have configured to work with preview deployments. **This will set the configuration for all preview deployments**, not just the deployments from a specific branch. **Pages does not currently support branch-based configuration.**"
> Note: "The `--branch` flag is optional with `wrangler pages deploy`. If you use git integration, Wrangler will infer the branch you are on from the repository you are currently in and implicitly add it to the command."

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/configuration/preview-deployments/>（Last updated **Jun 3, 2026**）

> "Preview deployments allow you to preview new versions of your project without deploying it to production."
> "Every time you open a new pull request on your GitHub repository, Cloudflare Pages will create a unique preview URL…"
> "Any custom domains, as well as your `user-example.pages.dev` site, will not be affected by preview deployments."
> "By default, preview deployments are enabled and available publicly. In your project's settings, you can require visitors to authenticate to view preview deployment."

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/get-started/git-integration/>（Last updated **Apr 21, 2026**）

> "**Production branch** indicates the branch that Cloudflare Pages should use to deploy the production version of your site. For most projects, this is the `main` or `master` branch. All other branches that are not your production branch will be used for preview deployments."

→ 对本项目：**默认分支是 `master`，即 production branch 必须显式选 `master`**（官方措辞枚举了 `main` 或 `master`，即 `master` 是被承认的合法选项）。

### 5.2 有没有官方 staging 建议

- **Pages：[官方明确] 没有 staging 档**。命名环境只能是 `preview` 与 `production`（文档 "Unlike Workers Environments, `production` and `preview` are the only two options available via `[env.<ENVIRONMENT>]`." + 源码报错 `The supported named-environments for Pages are "preview" and "production".`）。
- **Worker：[官方明确] 有 staging 示例**。来源：<https://developers.cloudflare.com/workers/wrangler/environments/>（Last updated **Apr 23, 2026**）
  > "### Staging and production environments"
  > "The following Wrangler file adds two environments, `[env.staging]` and `[env.production]`, to the Wrangler file. If you are deploying to a Custom Domain or route, you must provide a `route` or `routes` key for each environment."
  > "When you create an environment, Cloudflare effectively creates a new Worker with the name `<top-level-name>-<environment-name>`. For example, a Worker project named `my-worker` with an environment `dev` would deploy as a Worker named `my-worker-dev`."
  > "Like other environment variables, **secrets are non-inheritable and must be defined per environment**."
  > Caution: "When you create a Worker via an environment, Cloudflare automatically creates an SSL certification for it. SSL certifications are discoverable and a matter of public record. Be careful when naming your environments that they do not contain sensitive information…"

→ 对本项目：Cron Worker 若要分档，**只能在 Worker 侧用 `[env.staging]` 之类命名环境**；Pages 侧做不到 stg 档（只能 preview / production）。**注意**：Worker 命名环境会**额外创建一个真实 Worker 部署**（`my-worker-staging`），会占 Workers/Pages 项目上限配额（Pages 100 个项目/账户、Workers 免费 100 个项目——见 <https://developers.cloudflare.com/pages/platform/limits/> 与 Workers limits 页）。

### 5.3 本地开发命令

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/local-development/>（Last updated **Apr 21, 2026**）

> "The main command for local development on Pages is `wrangler pages dev`."
> "If you have a Wrangler configuration file configured for your Pages project, you can run `wrangler pages dev` **without specifying a directory**."
> "This will then start serving your Pages project… (available, by default, on http://localhost:8788)."

（对照：[官方明确] migrate-from-pages 页："`wrangler pages dev` will, by default, expose the local development server at `http://localhost:8788`, whereas `wrangler dev` will expose it at `http://localhost:8787/`。"）

---

## 6. Pages 的环境变量与 Secrets

### 6.1 定义方式

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/bindings/>（Last updated **Jun 25, 2026**）

**环境变量（vars）**

> "An environment variable is an injected value that can be accessed by your Functions. Environment variables are a type of binding that allow you to attach text strings or JSON values to your Pages Function. **It is stored as plain text.** Set your environment variables directly within the Cloudflare dashboard for both your production and preview environments at runtime and build-time."
> "To add environment variables to your Pages project, you can **use the Wrangler configuration file or the Cloudflare dashboard**."
> Dashboard 路径："Go to **Settings** > **Variables and Secrets** > **Add**."
> 本地："Configure your Pages project's Wrangler file and running `npx wrangler pages dev`." 或 `npx wrangler pages dev --binding=<NAME>=<VALUE>`

**Secrets**

> "Secrets are a type of binding that allow you to attach **encrypted** text values to your Pages Function. You cannot see secrets after you set them and can only access secrets programmatically on `context.env`. Secrets are used for storing sensitive information like API keys and auth tokens."
> Dashboard 路径逐字："Go to **Settings** > **Variables and Secrets** > **Add**. … Set a variable name and value. **Select `Encrypt` to create your secret.** … Select **Save**."
> "You use secrets the same way as environment variables. **When setting secrets with Wrangler or in the Cloudflare dashboard, it needs to be done before a deployment that uses those secrets.**"

**[官方明确]**（Wrangler 命令存在）来源：<https://developers.cloudflare.com/workers/wrangler/commands/pages/>（Last updated **Apr 23, 2026**）

官方列出 14 个 `wrangler pages*` 子命令，其中包含：

> `pages secret put` — "Create or update a secret variable for a Pages project"，参数 `[KEY]`（required）、`--project-name`
> `pages secret list` / `pages secret delete` / `pages secret bulk` / `pages download config` / `pages deploy` / `pages dev` / `pages project create` / `pages project list` / `pages project delete` / `pages deployment list|tail|delete` / `pages functions build`

**结论**：
- **[官方明确]** Pages 的**环境变量（`vars`）可以走 wrangler 配置文件**（`vars` 在 non-inheritable keys 白名单内）。
- **[官方明确]（源码）+ [官方间接]（文档）** Pages 的 **Secrets 不能写在 wrangler 配置文件里**：`secrets` 不在 `supportedPagesConfigFields`（写入会报 `Configuration file for Pages projects does not support "secrets"`）；Pages 的 Configuration 页**通篇未出现 "secret" 一词**，Secrets 只在 Bindings 页出现且只给 dashboard 步骤；Wrangler 侧提供的是**命令**（`wrangler pages secret put`），而非配置键。

> 备注：Workers 侧确实有一个 `secrets` **配置属性**（用于声明"必需哪些 secret 名"以便部署前校验），见 <https://developers.cloudflare.com/workers/configuration/secrets/>（**Jul 3, 2026**）：
> "You can declare the secret names your Worker requires using the `secrets` configuration property in your Wrangler configuration. When defined, `wrangler deploy` and `wrangler versions upload` will fail with a clear error if any required secrets are not configured on the Worker."
> "You can upload up to **100 secrets per bulk request** for a single version."（`--secrets-file`）
> **该属性未出现在 Pages 的白名单里**，故 Pages 项目不可用（[官方明确] 源码）。**注意措辞边界**：这是"源码白名单不含"，不是官方文档的逐字否定。

### 6.2 免费版数量 / 大小上限

**[未找到一手来源]（Pages 侧）**：<https://developers.cloudflare.com/pages/platform/limits/>（Last updated **Sep 5, 2026**）的分类为 **Builds / Custom domains / Files / File size / Functions / Headers / Preview deployments / Redirects / Users / Projects**，**没有任何一行**关于"环境变量数量"或"Secrets 数量"。同页明确的相关上限：

> "Builds | 1 build at a time | … | Builds per month | 500"；"Builds will timeout after 20 minutes."
> "Cloudflare Pages sites can contain up to **20,000 files** on the Free plan."
> "The maximum file size for a single Cloudflare Pages site asset is **25 MiB**."
> "Cloudflare Pages has a limit of **100 projects per account**."
> "Requests to [Pages functions] count towards your quota for Workers plans, including requests from your Function to KV or Durable Object bindings."
> "You can have an unlimited number of preview deployments active on your project at a time."
> "A `_headers` file can have a maximum of 100 header rules."；"A `_redirects` file can have a maximum of 2,000 static redirects and 100 dynamic redirects…"

**[官方明确]（Workers 侧数字）** 来源：<https://developers.cloudflare.com/workers/platform/limits/>（Last updated **Sep 5, 2026**）

> `## Environment variables`
> | Limit | Workers Free | Workers Paid |
> | Variables per Worker (secrets + text) | **64** | **128** |
> | Variable size | **5 KB** | **5 KB** |
> | Variables per account | No limit | No limit |

→ **注意**：**Secrets 与明文变量共用同一配额**（行名即 "secrets + text"），单变量上限 **5 KB**。**"该 64/128 是否原样适用于 Pages Functions"官方无明文**——只能由 Pages 官方口径 "Requests to Pages functions count towards your quota for Workers plans" 与 "All Pages Functions are billed as Workers"（见 `cloudflare-auth-platform-facts.md` §1 第 5 条）**间接推得**，属 [官方间接]，且**未找到**逐字依据。→ 见 §8。

### 6.3 `.dev.vars` 的作用与是否入库

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/bindings/>（**Jun 25, 2026**）与 <https://developers.cloudflare.com/workers/configuration/secrets/>（**Jul 3, 2026**）（两页该段文字完全相同）

> Caution: "Do not use `vars` to store sensitive information in your Worker's Wrangler configuration file. Use secrets instead."
> "Put secrets for use in local development in either a `.dev.vars` file or a `.env` file, **in the same directory as the Wrangler configuration file**."
> "**Do not commit secrets to git**: The `.dev.vars` and `.env` files should not be committed to git. Add **`.dev.vars*` and `.env*`** to your project's `.gitignore` file."
> "**Choose to use either `.dev.vars` or `.env` but not both.** If you define a `.dev.vars` file, then values in `.env` files will not be included in the `env` object during local development."
> "To set different secrets for each Cloudflare environment, create files named `.dev.vars.<environment-name>` or `.env.<environment-name>`."
> "When using `.dev.vars.<environment-name>` files, **all secrets must be defined per environment**. If `.dev.vars.<environment-name>` exists then only this will be loaded; the `.dev.vars` file will not be loaded."
> 环境变量开关："To disable loading local dev vars from `.env` files without providing a `.dev.vars` file, set the `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV` environment variable to `"false"`."

格式为 dotenv 语法：

```bash
SECRET_KEY="value"
API_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
```

**对本项目的含义**：自研鉴权的签名密钥 / 用于登录的初始口令等**只能**放 `.dev.vars`（本地）+ dashboard Secrets（线上），**绝不能**进 `wrangler.toml` 的 `[vars]`，也**不能**进 git（`.gitignore` 要含 `.dev.vars*` 与 `.env*`）。**仓库是 public，这条是硬约束。**

---

## 7. 落地检查清单（**全部是上文的约束推导，不是官方推荐方案**）

1. `frontend/` 与 `cron-worker/` **各自**放一份 wrangler 配置文件；不要依赖"向上查找到仓库根"的隐式行为，必要时显式 `--config`。
2. Pages 侧配置：`name` + `pages_build_output_dir` + `compatibility_date` **三个必填**；**不得出现 `main`**；**不得出现 `secrets` / `account_id` / `route` / `workers_dev` / `rules`**。
3. Pages 侧环境名只能写 `[env.preview]` / `[env.production]`；写别的会**在部署时校验失败**（源码报错）。
4. 一旦在任一 `[env.*]` 里覆盖了任意一个 non-inheritable key（`vars` / `d1_databases` / …），**必须在该环境里把所有 non-inheritable key 全部补齐**，否则 "will fail to validate when you try to deploy"。
5. Git 集成：Production branch 选 **`master`**；`Root directory (advanced) > Path` 指向 `frontend/`（官方明说 monorepo 需要指定）；需 **Build System V2 或更高**。
6. `functions/` 放 `frontend/functions/`（**不在** `frontend/dist/`）；`_routes.json` 放 `frontend/dist/`（构建输出目录）。
7. `database_id` 明文写进两份配置即可；**不要**把 `database_id` 改写成环境变量（官方无此要求，反而与"配置文件即真相源"相冲突）。
8. 仓库 public → `.gitignore` 必须含 `.dev.vars*` 与 `.env*`；`[vars]` 里**只放非敏感配置**。
9. **上线前必须实测**：preview 部署到底绑的是哪个 D1（§4.3 未证实项）。

---

## 8. 未找到 / 未证实 / 需实测

### 8.1 未找到官方一手来源（明确缺口，**未用推测填充**）

1. **"一个仓库允许多份 wrangler 配置文件"没有逐字表述**。官方只有 monorepo 文档（多项目 + root directory）与 D1 的 `migrations_dir` monorepo 提法，**没有任何一句**直接回答"能否共存"。本报告用 **wrangler 源码的查找逻辑**（`findWranglerConfig` 从 cwd 向上查找、同目录优先级 json > jsonc > toml）给出 [官方间接] 结论。
2. **Git 集成构建时 wrangler 配置文件的读取目录未明文**。官方只说 "in the root of your Pages project" / "your project's root directory"，**没有**把 dashboard 的 `Root directory (advanced)` 字段与该文件的查找机制挂钩。
3. **`functions/` 的定位基准未明文**。官方逐字只说 "at the root of your Pages project (and not in the static root, such as `/dist`)"，**没有**说"相对 `Root directory` 解析"。本报告的对应关系是 [官方间接]。
4. **preview 部署默认是否使用 production 的绑定（含同一个生产 D1）——未证实**。文档只写 "You can set bindings for both production and preview environments." 与 "`env.preview` would override…"，**没有任何一句**说明"默认是否相同 / 是否继承"。§4.3 给出的两种读法**互相不完全一致**，本报告不选边、不做行为推断。
5. **`database_id` 能否安全公开（public 仓库）——未证实**。官方只把它定义为普通必填 `string` 且示例明文入配置；**没有**"可公开"或"是敏感信息"的任何表述。
6. **Pages 侧环境变量 / Secrets 的数量上限未明文**。Pages Limits 页无该行；Workers Limits 的 `64 / 128 per Worker`、`5 KB` 是否适用于 Pages，**无逐字依据**。
7. **Pages 的 Secrets 不能写进 wrangler 配置——文档侧无逐字否定**。依据是源码白名单 `supportedPagesConfigFields` 不含 `secrets`（写入会报错），以及 Pages Configuration 页通篇无 "secret" 一词。属"源码级 [官方明确] + 文档级缺位"。
8. **Pages 配置里 `wrangler.json` / `wrangler.jsonc` 是否真的可用**。文档说 "As of Wrangler v3.91.0, Wrangler supports both JSON…"（Pages 页，Jun 25, 2026），但**当前** `validation-pages.ts` 的校验入口并**未**再做"只允许 toml"的判断（该判断在旧版 `packages/wrangler/src/config/index.ts` 里存在过：`Pages doesn't currently support JSON formatted config`）。**文档与旧版源码冲突，本次未取得新版源码中对应的放行/拒绝逻辑** → 需实测。
9. **同一份 `wrangler.toml` 内 `wrangler.json` 与 `wrangler.toml` 同时存在时的实际行为**未在文档中出现；源码优先级见 §1.2 第 3 点（[官方间接]）。

### 8.2 互相矛盾 / 口径不一致（双方都保留）

- **"缺 `pages_build_output_dir` 时的行为"：文档说"警告"，源码说"FatalError"。**
  - 文档（Pages Configuration 页，**Jun 25, 2026**）逐字："You can continue to use your Wrangler file for local development without migrating it for production use by not adding a `pages_build_output_dir` key. If you do not add a `pages_build_output_dir` key and run `wrangler pages deploy`, you will see **a warning message** telling you that fields are missing and that the file will continue to be used for local development only."
  - 源码（`packages/wrangler/src/config/index.ts` main 分支，**2026-09-16** 采集）逐字：`if (!isPagesConfig(rawConfig)) { throw new FatalError(\`Your ${configFileName(configPath)} file is not a valid Pages configuration file\`, { code: EXIT_CODE_INVALID_PAGES_CONFIG, … }); }`
  - **不抹掉任一方**：可能的解释是文档描述的是 `wrangler pages dev`（不要求 Pages 配置）而源码该分支属 `wrangler pages deploy` 路径（要求 Pages 配置），但**本报告未能逐字确认这两条路径的分工** → 记为**待实测**。
- **`preview_database_id` 的语义在 Pages 与 Worker 语境不同**：Worker 侧文档说它是"远程预览库 ID，避免 `wrangler dev --remote` 打到生产库"；D1 的 Pages 本地开发文档把它当"本地库标识"并注释 "Required for Pages local development"。同一字段名、两处语义，**容易误配** → 落地时按 Pages 侧口径理解。
- **`pages.dev` 子域的 `*.pages.dev` 与自定义域**：见既有报告，本文件不重复。

### 8.3 需实测（本报告无法从文档判定，必须跑一遍）

| # | 待测事项 | 判定方法（建议） |
|---|---|---|
| T1 | **preview 部署默认指向哪个 D1**（生产库？还是 preview 未绑定？） | 在 preview 分支的 `/api/*` 里回显 `env.DB` 查询到的某个哨兵行（或 `SELECT` 一个只在生产库存在的表），对比 `373f31e2.<project>.pages.dev` 与 production 域的输出 |
| T2 | Git 集成构建时 wrangler 配置文件实际从哪个目录读取 | 在 `frontend/wrangler.toml` 里设一个可观测的 `vars`（如 `CONFIG_PROBE = "frontend-root"`），并在仓库根放另一份带不同值的配置，观察 preview/production 运行时 `env.CONFIG_PROBE` |
| T3 | `pages_build_output_dir` 缺失时到底是 warning 还是 fatal | 临时移除该键，分别跑 `npx wrangler pages dev` 与 `npx wrangler pages deploy`，记录输出与退出码 |
| T4 | Pages 项目是否接受 `wrangler.json` / `wrangler.jsonc` | 用 `wrangler pages download config --force` 生成，或手写 JSON 版配置后跑一次 `wrangler pages deploy`，记录校验结果 |
| T5 | Pages 实际能接受多少个环境变量 / Secrets | 在测试项目里逐批增加明文变量直到部署失败，记录数字与错误文案；对照 Workers 的 64 / 5 KB |
| T6 | `[env.preview]` 在 **Git 集成**流程下是否生效（文档语境偏 `wrangler pages deploy`） | 用 `[env.preview]` 覆盖一个可观测 `vars`，在 preview 分支推送，检查运行时值 |
| T7 | 同一仓库存在两份配置文件时，CI 构建是否会误取 | 在 `cron-worker/` 下跑一次 `npx wrangler pages deploy`（应报 "not a valid Pages configuration file"），确认查找边界 |

---

## 9. 与既有报告的口径一致性

- **Pages 无 Cron Triggers**：沿用 `cloudflare-free-tier-constraints.md` §2.1 与 `cloudflare-cron-and-timezone-facts.md` §1；本文件仅补充 **[官方明确]** 对照表：migrate-from-pages 兼容矩阵中 `Cron Triggers | Workers ✅ | Pages ❌`、`Queue Consumers | ✅ | ❌`、`Secrets | ✅ | ✅`、`Environment Variables | ✅ | ✅`、`Monorepos | ✅ | ✅`（<https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>，**Aug 14, 2026**）。
- **D1 共享靠同一 `database_id`**：本文件 §4.1 给出该字段的官方定义与 `preview_database_id` 语义差异，与 `cloudflare-free-tier-constraints.md` §2.2/§2.3 一致。
- **Pages Functions 计入 Workers 配额**：`cloudflare-auth-platform-facts.md` §1 第 5 条与 Pages Limits 页口径一致（本文件 §6.2 引用同句）。
- **`functions/_middleware` 与 `_routes.json`**：`cloudflare-auth-platform-facts.md` §5 已核实；本文件 §2.2 补充 `_routes.json` 必须放**构建输出目录**、`functions/` 必须放**项目根**这一对位置约束的官方原文。
- **本文件新增、前述报告未覆盖的**：Pages 的 wrangler 配置支持白名单（含源码级"不支持项"）、`pages_build_output_dir` / `main` 的互斥校验、`[env.*]` 只允许 `preview`/`production`、`.dev.vars` 的 git 纪律、Pages 环境变量/Secrets 数量上限的缺口。

---

*本文件为可审计事实清单。所有 [官方明确] 结论均附 `developers.cloudflare.com` / Cloudflare 官方博客 / `cloudflare/workers-sdk` 源码 URL 与文档 Last updated 日期（源码附 main 分支快照日期 2026-09-16）；[官方间接] 与 [未找到一手来源] 已逐条标注。§8 的缺口未用推测填充，涉及"行为"的结论一律标注为未证实并给出实测方法。*
