# 家庭财务系统 · Cloudflare Pages 三条部署通道 + 免费配额数字 — 一手事实清单

> **采集日期**：2026-09-16（以下所有 URL 均于该日访问）
> **范围**：`developers.cloudflare.com` 官方文档（含各页 `.md` 源文件与其 JSON-LD `dateModified`）、Cloudflare 官方 Changelog、`cloudflare/wrangler-action` 仓库 README、`docs.github.com`（仅用于 GitHub Actions 免费分钟数）。
> **二手来源声明**：本次检索命中的博客 / 知乎 / 掘金 / CSDN / Cloudflare Community 帖子**一律不作为结论依据**；仅在「官方未找到」处作为「存在此说法但无一手来源」的旁证列出，并明确标注。
> **取证方式**：只读网页抓取（WebFetch）。**本环境无法 `curl` / 无法直接访问文件系统做验证**，故凡涉及「实际会不会计数」的行为，一律标 [未证实] 并写入 §7「需实测」。
> **标注规则**：
> - **[官方明确]** = 官方文档 / 官方 Changelog 原文逐字写明；
> - **[官方间接]** = 由官方原文可逻辑推导，但官方无逐字表述；
> - **[未找到一手来源]** = 官方文档未给出该表述或数字；
> - **[未证实]** = 无官方原文，且无法由原文推导，只能实测的行为性结论。
> **与前文的衔接**：本文不重复 `cloudflare-free-tier-constraints.md` / `cloudflare-auth-platform-facts.md` / `cloudflare-cron-and-timezone-facts.md` 已核实的内容；凡与那三份报告重合处，本文只做「口径复述 + 补引文」。
> **易变事实提醒**：下列所有数字与版本号均为 **2026-09-16 快照**。Cloudflare 文档的 `dateModified` 逐条标注（部分页面**不显示** Last updated，已注明）。

---

## 0. 结论速览（先给判断）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 三条通道能否在同一个 Pages 项目上并存 | **[官方明确]** 项目类型**不可互转**；但 **Git 集成项目仍可用 Wrangler 手动部署**（`wrangler pages deploy`），**反向不行**（Direct Upload 项目不能后接 Git 集成）。dashboard 拖拽上传对 Git 集成项目不可用 |
| 2 | Git 集成支持哪些 Git 提供方 | **[官方明确]** 仅 **GitHub 与 GitLab**；自建实例不支持；Bitbucket 需走 Direct Upload + 自建 CI |
| 3 | monorepo 的 root directory | **[官方明确]** 默认用仓库根目录；monorepo 需在 **Root directory (advanced) > Path** 指定 |
| 4 | Direct Upload 是否支持 Git 集成的自动部署 | **[官方明确]** 不支持。官方原文：「If you choose Direct Upload, you cannot switch to Git integration later.」 |
| 5 | 官方 GitHub Action | **[官方明确]** `cloudflare/wrangler-action`，Pages 官方示例用 `command: pages deploy ... --project-name=...`。**版本口径有冲突**（文档写 `@v3`，仓库 README 已改为 `@v4`）见 §8 |
| 6 | public 仓库里跑 GitHub Actions 是否免费 | **[官方明确]** 「The use of standard GitHub-hosted runners is free：In public repositories」；**larger runners 例外，始终计费** |
| 7 | 「500 builds per month」的计数口径 | **[官方明确]** 只有 「500 builds per month」这一个数字；**[未找到一手来源]** 官方**未明文**说明 direct upload 是否计入、preview 是否计入、以及是每账户还是每项目 |
| 8 | 并发构建 | **[官方明确]** Free **1 build at a time**；「Concurrent builds are counted **per account**」 |
| 9 | 回滚能力 | **[官方明确]** 任何「成功构建的 production deployment」都是合法回滚目标；preview deployment **不是**合法回滚目标。**[未找到一手来源]** 官方未给「保留多少个 deployment」的数字 |
| 10 | Pages 项目数上限（Free） | **[官方明确]** **100 projects per account**，且「This limit is not routinely increased」；发布后 48 小时内新建项目数另有限制 |
| 11 | Pages Functions 计入 Workers 100,000/天 | **[官方明确]** 是。原文：「Requests to your Pages Functions count towards your quota for the Workers Free plan」 |
| 12 | 纯静态请求是否不计数 / 无限免费 | **[官方明确]** 是：「On both free and paid plans, requests to static assets are free and unlimited. A request is considered static when it does not invoke Functions.」**未找到相反表述** |
| 13 | `_routes.json` 缺失时 | **[官方明确]** 「once you add Functions on a Pages project, **all requests by default will invoke your Function**」；同时官方声明该文件在检测到 `functions` 目录时**会被自动生成**（Pages CI 或 Wrangler 发布时） |
| 14 | D1 查询算子请求吗，额度是多少 | **[官方明确]（但有冲突）** 是子请求。**冲突**：Workers Limits 页 + 2026-02-11 Changelog 说 Free **50 个外部子请求 / 1,000 个对 Cloudflare 服务的子请求**；而 D1 Limits 页仍写 `Queries per Worker invocation ... 1000 (Workers Paid) / 50 (Free)`。详见 §3.4 与 §8 |
| 15 | 改 cron 表达式后是否要重新部署 | **[官方明确]** 是（Wrangler 部署会用配置里的 `triggers` **替换**原有 cron）；生效可能需 **up to 15 minutes** |
| 16 | 删除 cron | **[官方明确]** `"crons": []`（空数组 = 全部移除）或 dashboard 删除；`triggers` / `crons` 为 `undefined` 时**保留**现有 cron |
| 17 | Cron 5 个/账户 | **[官方明确]** 是 per **account**（`Number of Cron Triggers per account | 5 | 250`）；同一账户多个 Worker **共享**这 5 个额度 |
| 18 | 本地 D1 数据在哪 / 怎么重置 | **[官方明确]** `.wrangler/state`；可随时删除该目录重置，Miniflare 下次 `dev` 会重建 |
| 19 | 本地测试 `scheduled()` | **[官方明确]** `wrangler dev --test-scheduled` → `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"`。注意：**不是** `/__scheduled`（见 §5.4） |
| 20 | wrangler 版本 / jsonc | **[官方明确]** 支持 Node 的 Current/Active/Maintenance 版本；官方推荐 `wrangler.jsonc`（「some newer Wrangler features will only be available to projects using a JSON config file」），JSON 支持自 **Wrangler v3.91.0** 起 |

---

## 1. Pages 的三条部署通道

### 1.1 官方对三条通道的定位（逐字）

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/>（Last updated **Aug 25, 2026**）

> “Deploy your Pages project by connecting to your Git provider, uploading prebuilt assets directly to Pages with Direct Upload or using C3 from the command line.”

**[官方明确]** 两条「正统」通道的定位，逐字来自各自的 Get started 页：

- **Git 集成**（<https://developers.cloudflare.com/pages/get-started/git-integration/>，Last updated **Apr 21, 2026**）：
  > “The Git integration enables automatic builds and deployments every time you push a change to your connected GitHub or GitLab repository.”
- **Direct Upload**（<https://developers.cloudflare.com/pages/get-started/direct-upload/>，Last updated **Apr 21, 2026**）：
  > “Direct Upload enables you to upload your prebuilt assets to Pages and deploy them to the Cloudflare global network. **You should choose Direct Upload over Git integration if you want to integrate your own build platform** or upload from your local computer.”

- **第三条（`wrangler pages deploy` + CI）** 官方单列一篇 How-to，标题即定位（<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>，Last updated **Apr 21, 2026**）：
  > “Cloudflare Pages supports directly uploading prebuilt assets, allowing you to use custom build steps for your applications and deploy to Pages with Wrangler. This guide will teach you how to deploy your application to Pages, using continuous integration.”

  → **[官方明确]** 官方把「`wrangler pages deploy` + GitHub Actions/CircleCI/Travis CI」定义为 **Direct Upload 的一种用法**，而非与 Direct Upload 并列的第三条独立通道。

### 1.2 三条通道能否并存（关键）

**[官方明确]** 结论：**项目类型不可互转**，但**同一个 Git 集成项目可以被 Wrangler 手动部署**。

| 方向 | 官方原文 | 来源 |
|---|---|---|
| Git 集成 → Direct Upload | “If you deploy using the Git integration, **you cannot switch to Direct Upload later**. However, if you already use a Git-integrated project and do not want to trigger deployments every time you push a commit, you can disable automatic deployments on all branches. **Then, you can use Wrangler to deploy directly to your Pages projects** and make changes to your Git repository without automatically triggering a build.” | <https://developers.cloudflare.com/pages/get-started/git-integration/>（Apr 21, 2026）；同句亦见 <https://developers.cloudflare.com/pages/configuration/git-integration/>（Apr 21, 2026）与 <https://developers.cloudflare.com/pages/platform/known-issues/>（May 6, 2026）「Git configuration」节 |
| Direct Upload → Git 集成 | “If you choose Direct Upload, **you cannot switch to Git integration later**. You will have to create a new project with Git integration to use automatic deployments.” | <https://developers.cloudflare.com/pages/get-started/direct-upload/>（Apr 21, 2026） |
| Direct Upload 项目内混用 Wrangler / 拖拽 | “Within a Direct Upload project, you can switch between creating deployments with either Wrangler or drag and drop. **For existing Git-integrated projects, you can manually create deployments using `wrangler deploy`. However, you cannot use drag and drop on the dashboard with existing Git-integrated projects.**” | <https://developers.cloudflare.com/pages/get-started/direct-upload/>（Apr 21, 2026） |

**⚠️ 官方原文的一处措辞疑点**：上表第三行官方写的是 `wrangler deploy`（链接指向 General commands 的 `deploy`）。按本页其余部分与 1.1 的定位，Pages 部署应为 `wrangler pages deploy`。**该处疑为文档笔误，本清单不据此改写官方原意**；落到本项目时应以 `wrangler pages deploy <DIR>` 为准（见 <https://developers.cloudflare.com/pages/get-started/direct-upload/> 的 Wrangler CLI 一节）。

### 1.3 Git 集成的支持面：提供方 / 镜像 / Node 版本 / monorepo

**[官方明确]** **Git 提供方**（来源：<https://developers.cloudflare.com/pages/configuration/git-integration/>，Last updated **Apr 21, 2026**）：

> “Cloudflare supports connecting Cloudflare Pages to **your GitHub and GitLab repositories**. Pages **does not currently support connecting self-hosted instances** of GitHub or GitLab.”
> “If you using a different Git provider (e.g. **Bitbucket**) or a self-hosted instance, you can start with a **Direct Upload** project and deploy using a **CI/CD provider (e.g. GitHub Actions) with Wrangler CLI**.”

- **GitHub 在列**：[官方明确]。GitHub 集成有单独子页 <https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/>。
- **Known issues 侧的同一结论**（<https://developers.cloudflare.com/pages/platform/known-issues/>，Last updated **May 6, 2026**）：
  > “**GitHub and GitLab are currently the only supported platforms for automatic CI/CD builds.** Direct Upload allows you to integrate your own build platform or upload from your local computer.”
- 另有 **[官方明确]** 的权限要求（GitLab 侧）与 preview 限制：「Commits/PRs from **forked repositories will not create a preview**」（同 Known issues 页）。

**[官方明确]** **构建镜像与 Node 版本**（来源：<https://developers.cloudflare.com/pages/configuration/build-image/>，Last updated **Apr 21, 2026**）：

- 当前默认 v3 构建镜像（**Ubuntu 22.04.2 / x86_64**，跑在 gVisor 容器里）：

  | 语言/工具 | 默认版本（v3） | 支持版本 | 覆盖用环境变量 | 覆盖用文件 |
  |---|---|---|---|---|
  | Node.js | **22.16.0** | Any version | `NODE_VERSION` | `.nvmrc`, `.node-version` |
  | Go | 1.24.3 | Any version | `GO_VERSION` | — |
  | Bun | 1.2.15 | Any version | `BUN_VERSION` | — |
  | Python | 3.13.3 | Any version | `PYTHON_VERSION` | `.python-version`, `runtime.txt` |
  | Ruby | 3.4.4 | Any version | `RUBY_VERSION` | `.ruby-version` |
  | npm | 10.9.2 | 随 Node | — | — |
  | pnpm | 10.11.1 | Any version | `PNPM_VERSION` | — |
  | Yarn | 4.9.1 | Any version | `YARN_VERSION` | — |
  | Hugo | 0.147.7 | Any version | `HUGO_VERSION` | — |
  | Zola | 0.22.1 | Any version | `ZOLA_VERSION` | — |

  > “Under Supported versions, "Any version" refers to support for all versions of the language or tool **including versions newer than the Default version**.”

- 覆盖方式（逐字）：
  > “To override default versions of languages and tools in the build system, you can either set the desired version through **environment variables** or by **adding files to your project**.”
- **v3 迁移与弃用时间表**（**[官方明确]**，同一页）：
  > “**v1 build image**: If you are using the Pages v1 build image, your project will be **automatically moved to v3 on September 15, 2026**.”
  > “**v2 build image**: If you are using the Pages v2 build image, your project will be **automatically moved to v3 on February 23, 2027**.”
  > “Going forward, the v3 build image will receive rolling updates to preinstalled software per the policy below. There will be no further build image version changes.”
- **v3 已知限制**（同页，用于判断能否依赖自动探测）：
  > “Specifying Node.js versions as **codenames** (for example, `hydrogen` or `lts/hydrogen`). / Detecting Yarn version from `yarn.lock` file version. / Detecting pnpm version detection based `pnpm-lock.yaml` file version. / Detecting Node.js and package managers from `package.json` -> `"engines"`. / `pipenv` and `Pipfile` support.”

  → **[官方明确]** 在 v3 下**不要依赖 `package.json > engines` 来指定 Node 版本**，要用 `NODE_VERSION` 或 `.nvmrc` / `.node-version`。

  **⚠️ 与另一页的冲突**：Known issues 页（**May 6, 2026**）仍写 > “By default, Cloudflare uses **Node `12.18.0`** in the Pages build environment.” 这与 Build image 页（**Apr 21, 2026**）的 v3 默认 **Node 22.16.0** 直接冲突。两页都保留，见 §8。

**[官方明确]** **monorepo / root directory**（来源：<https://developers.cloudflare.com/pages/get-started/git-integration/>，Last updated **Apr 21, 2026**）：

> “Cloudflare Pages begins by working from your repository's **root directory**. The entire build pipeline, including the installation steps, will begin from this location. If you would like to change this, specify a new root directory location through the **Root directory (advanced) > Path** field.”
> “The root directory is where your site's content lives. **If not specified, Cloudflare assumes that your linked Git repository is the root directory. The root directory needs to be specified in cases like monorepos**, where there may be multiple projects in one repository.”

同句亦见 <https://developers.cloudflare.com/pages/configuration/build-configuration/>（Last updated **Apr 21, 2026**）。

**构建成功判定**（**[官方明确]**，build-configuration 页，对本项目「构建失败要阻断部署」很关键）：
> “Pages determines whether a build has succeeded or failed by reading the **exit code** returned from the user supplied build command. **Any non-zero return code will cause a build to be marked as failed.** An exit code of 0 will cause the Pages build to be marked as successful and assets will be uploaded **regardless of if error logs are written to standard error**.”
> 官方另给：「If you are not using a preset, use `exit 0` as your **Build command**.」

**注入的系统环境变量**（**[官方明确]**，build-configuration 页）：
`CI=true`、`CF_PAGES=1`、`CF_PAGES_COMMIT_SHA`、`CF_PAGES_BRANCH`、`CF_PAGES_URL`。

**React (Vite) 的官方 preset**（**[官方明确]**，同页 framework presets 表）：build command `npm run build`，build directory `dist`。

### 1.4 Direct Upload 项目是否支持 Git 集成的自动部署

**[官方明确]** **不支持**。原文见 §1.2 表格第二行。

补充边界（**[官方明确]**，<https://developers.cloudflare.com/pages/get-started/direct-upload/>）：
- Direct Upload 项目**没有 production branch 控制 UI**：
  > “If your project is a Direct Upload project, you will not have the option to configure production branch controls. To update your production branch, you will need to manually call the **Update Project** endpoint in the API.”
- Direct Upload 的**上传上限**（同页 Troubleshoot > Limits，逐字表）：

  | Upload method | File limit | File size |
  |---|---|---|
  | Wrangler | 20,000 files | 25 MiB |
  | Drag and drop | 1,000 files | 25 MiB |

- **Functions 对拖拽上传不可用**：
  > “**Drag and drop deployments made from the Cloudflare dashboard do not currently support compiling a `functions` folder** of Pages Functions. To deploy a `functions` folder, you must use **Wrangler**. When deploying a project using Wrangler, if a `functions` folder exists where the command is run, that `functions` folder will be uploaded with the project.”
  > “However, note that a `_worker.js` file is supported by both Wrangler and drag and drop deployments made from the dashboard.”

  → 对「Git 集成 + `functions/` 目录」的项目：**Git 集成本身会编译 `functions/`**（否则 Pages Functions 无法工作）；本条限制只约束 dashboard 拖拽。

### 1.5 GitHub Actions：官方 action 与官方示例

**[官方明确]** **官方推荐做法**（来源：<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>，Last updated **Apr 21, 2026**）。官方给出的 Pages 部署 workflow 原文：

```yaml
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      deployments: write
    name: Deploy to Cloudflare Pages
    steps:
      - name: Checkout
        uses: actions/checkout@v6
      # Run your project's build step
      # - name: Build
      #   run: npm install && npm run build
      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy YOUR_DIRECTORY_OF_STATIC_ASSETS --project-name=YOUR_PROJECT_NAME
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

官方要点（逐字）：
> “The `${{ secrets.GITHUB_TOKEN }}` will be automatically provided by GitHub Actions with the `contents: read` and `deployments: write` permission. This will enable our Cloudflare Pages action to create a Deployment on your behalf.”
> “This workflow automatically triggers on the current git branch, **unless you add a `branch` option to the `with` section**.”

**云凭据**（同页，逐字步骤）：在 GitHub repo 里建两个 secret：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`；Cloudflare 侧 API Token 权限需 **Account → Cloudflare Pages → Edit**。

**凭据输入方式**（同页）：
```bash
CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> npx wrangler pages deploy <DIRECTORY> --project-name=<PROJECT_NAME>
```

**[官方明确]** **官方 action 仓库存在**：`cloudflare/wrangler-action`（<https://github.com/cloudflare/wrangler-action>）。其 README 给出 Pages（production & preview）用例：

```yaml
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    name: Deploy
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: actions/checkout@v6
      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy YOUR_DIST_FOLDER --project-name=example
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```
README 逐字：
> “If a push to a **non-production branch** is done, it will **deploy as a preview deployment**.”
> “The action now **defaults to Wrangler v4**. If you need to stay on Wrangler v3, you can pin the version explicitly:” `wranglerVersion: "3.90.0"`
> “Action version syntax is newly supported… `uses: cloudflare/wrangler-action@v4`… Previously supported syntax e.g. `cloudflare/wrangler-action@3.x.x` is no longer supported — the prefix `v` is now necessary.”

**⚠️ 版本口径冲突**：官方 Pages 文档（**Apr 21, 2026**）示例仍写 `@v3`；`wrangler-action` 仓库 README 已全面改为 `@v4`（仓库中有一条 commit message 为 “Update all wrangler-action@v3 references to v4”，GitHub 页面显示 **Jun 6, 2026**；`action.yml` 有一条 “fix: migrate action runtime from node20 to node24”，显示 **May 12, 2026**）。**两边都保留**，见 §8。落到本项目时以**仓库当前 README** 为准更安全（`@v4`），但需实测确认 `@v4` 对 Pages 子命令的行为。

**[官方明确]** **public 仓库的 GitHub Actions 分钟数**（来源：<https://docs.github.com/en/billing/concepts/product-billing/github-actions>，页面**未显示 Last updated 日期**）：

> “GitHub Actions usage is **free** for **self-hosted runners** and for **public repositories** that use **standard GitHub-hosted runners**.”
> “The use of standard GitHub-hosted runners is free: — **In public repositories** — For GitHub Pages — For Dependabot”
> “**Larger runners are always charged for, even when used by public repositories** or when you have quota available from your plan.”

→ **[官方明确]** 本项目仓库为 **public**，使用标准 `ubuntu-latest` runner **不计入** 2,000 分钟/月 的私有仓库免费额度；**但 larger runners 不论仓库可见性都计费**。

**基线分钟单价**（同页，仅作参照，public 仓库用不到）：
`Linux 2-core (x64) actions_linux $0.006/min`；`Windows 2-core $0.010/min`；`macOS $0.062/min`。

---

## 2. Pages 构建与部署的免费配额

### 2.1 「500 builds per month」的确切表述与计数口径

**[官方明确]** 数字与表述（来源：<https://developers.cloudflare.com/pages/platform/limits/>，Last updated **Sep 5, 2026**；JSON-LD `dateModified = 2026-09-05`）：

> “**Builds**
> Each time you push new code to your Git repository, Pages will build and deploy your site. Build limits depend on your plan:
>
> |  | Free | Pro | Business |
> | --- | --- | --- | --- |
> | Builds | **1 build at a time** | 5 concurrent builds | 20 concurrent builds |
> | Builds per month | **500** | 5,000 | 20,000 |
>
> **Builds will timeout after 20 minutes. Concurrent builds are counted per account.**”

**[官方明确]** 另一处用 **deploys** 措辞（来源：<https://developers.cloudflare.com/pages/>，Last updated **Aug 25, 2026**）：

> “Learn about limits that apply to your Pages project (**500 deploys per month on the Free plan**).”

**计数口径 —— 逐条如实回答（这是本节最重要的部分）**

| 子问题 | 结论 | 依据 |
|---|---|---|
| `git push` 触发构建算 1 次？ | **[官方明确]** 是。定义句即「Each time you push new code to your Git repository, Pages will build and deploy your site」，且该句是 Builds 一节对「build」的唯一定义 | Pages Limits（Sep 5, 2026） |
| **Direct Upload / `wrangler pages deploy` 是否也计入这 500？** | **[未找到一手来源]**。官方 Limits 页、Direct Upload 页、CI How-to 页、Build configuration 页、Branch deployment controls 页**均未出现**任何「direct upload 计数 / 不计数」的表述。Builds 一节的定义句只描述 Git push 这一种触发方式 | 逐页核对：Limits / Direct Upload / Use Direct Upload with CI / Build configuration / Branch deployment controls / Pages overview，**无一条相关表述** |
| **Preview 部署（每个 PR / 每个非生产分支）是否计入？** | **[未找到一手来源]** 作为「是否计入 500」的表述。**能确证的只有**：任一非生产分支的 push 会触发一次**完整构建与部署**（即消耗一次 build 动作），以及预览部署「活跃数量」无限 | **[官方明确]** 「Any additional changes to the `development` branch will continue to update this `373f31e2.user-example.pages.dev` preview address」（<https://developers.cloudflare.com/pages/configuration/preview-deployments/>，Jun 3, 2026）；「By default, Pages will trigger a deployment any time you commit to either your production or preview environment」（<https://developers.cloudflare.com/pages/configuration/branch-build-controls/>，Apr 21, 2026）→ **推论**：preview 的每次 push 都要跑一次构建，逻辑上应计入；**但官方未明文**，见 §7 |
| 是**每账户**还是**每项目**？ | **[未找到一手来源]**。官方只对**并发构建**写明「counted **per account**」，对 500/月**没有**说明口径 | Pages Limits（Sep 5, 2026） |
| 计数周期何时重置？ | **[未找到一手来源]** 官方未写重置时间点（月历月初 vs 订阅日） | — |
| 未使用的额度能否累积？ | **[未找到一手来源]** | — |

**可作为「不计数」说法的最强旁证（但属二手，不得作为结论）**：Cloudflare Community 帖 `Builds vs. Deployments`（<https://community.cloudflare.com/t/builds-vs-deployments/494717>，2023-04-08）中，论坛 MVP 回复称 wrangler 发布不计入 build 限额；另一帖 `Cloudflare Pages Limit Reset Time` 中论坛回复称「delete 历史部署不会降低计数；计数在每月 1 日重置」。**两条均为社区来源，本清单标为 [未证实]，不得引用为官方事实。**

### 2.2 并发构建数上限（免费）

**[官方明确]** **Free = 1 build at a time**；「Concurrent builds are counted **per account**」。
来源：<https://developers.cloudflare.com/pages/platform/limits/>（Last updated **Sep 5, 2026**），Builds 表。

**⚠️ 表头陷阱**：该表的列头是 `Free | Pro | Business`，列头下的第一行名为 `Builds`，值分别是 `1 build at a time` / `5 concurrent builds` / `20 concurrent builds`。即 **Free 的并发度 = 1**，不是 500。**构建超时 = 20 分钟**（同页）。

### 2.3 部署的保留与回滚能力（免费）

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/configuration/rollbacks/>（Last updated **Apr 21, 2026**）：

> “Rollbacks allow you to instantly revert your project to a previous **production** deployment.”
> “**Any production deployment that has been successfully built is a valid rollback target.** When your project has rolled back to a previous deployment, you may still rollback to deployments that are newer than your current version. **Note that preview deployments are not valid rollback targets.**”

操作路径（逐字）：**Deployments** → **All deployments** → 目标项三点菜单 → **Rollback to this deployment**。

**[官方明确]** **保留数量 = 未找到官方数字**。Pages Limits 页**没有**任何「保留 N 个 deployment」的条目；Rollbacks 页也未给保留上限。可确证的只有：

- **[官方明确]** 预览部署的**活跃**数量无限：「You can have an **unlimited number of preview deployments active** on your project at a time.」（Pages Limits，Sep 5, 2026）
- **[官方明确]** 预览部署的 hash 地址是**永久可访问**的：「These are **atomic and may always be visited in the future**.」（<https://developers.cloudflare.com/pages/configuration/preview-deployments/>，Jun 3, 2026）
- **[官方明确]** 可删除历史部署：`npx wrangler pages deployment delete <DEPLOYMENT_ID> --project-name <PROJECT_NAME>`（`--force` / `-f` 跳过确认并可强制删除被 alias 的部署）；**分支的最新部署不可删除**。（preview-deployments 页）
- **[官方明确]** Known issue：**部署数超过 100 时可能无法删除整个 Pages 项目**，需先逐个删部署（<https://developers.cloudflare.com/pages/platform/known-issues/>，May 6, 2026）。→ 反过来推：**官方并不承诺保留上限**，实际可能长期保留大量部署。

### 2.4 Pages 项目数上限（免费）

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/platform/limits/>（Last updated **Sep 5, 2026**）：

> “**Projects**
> Cloudflare Pages has a limit of **100 projects per account**. **This limit is not routinely increased.**”
> “The Workers project limit (**100 on Free**, 500 on paid plans) is **separate from** the Pages project limit.”
> “In order to protect against abuse of the service, Cloudflare limits the number of new Pages projects you can create **within your first 48 hours** of using the service…”

（该节开头声明「Below are limits observed by the **Cloudflare Free plan**」，故 100 = Free 值。）

### 2.5 其余 Pages 层限额（一并核对，供配额表使用）

**[官方明确]** 全部来源：<https://developers.cloudflare.com/pages/platform/limits/>（Last updated **Sep 5, 2026**），除另注外。

| 项 | Free 值 | 备注（逐字/摘要） |
|---|---|---|
| 单站点文件数 | **20,000** | 「Cloudflare Pages sites can contain up to 20,000 files on the Free plan.」Paid 100,000，需设 `PAGES_WRANGLER_MAJOR_VERSION=4` |
| 单文件大小 | **25 MiB** | 「The maximum file size for a single Cloudflare Pages site asset is 25 MiB.」 |
| custom domains / 项目 | **100** | 「This limit is on a per-project basis.」 |
| `_headers` | **100 条规则**；单条 **2,000 字符** | 更大的 header 建议改用 Pages Functions |
| `_redirects` | 静态 **2,000** + 动态 **100** = 合计 **2,100** | 超出建议用 Bulk Redirects |
| 预览部署（活跃数） | **无限** | 见 §2.3 |
| 用户（可管理站点的 dashboard 用户） | **无限** | 「unlimited number of users」 |
| Build 超时 | **20 分钟** | 「Builds will timeout after 20 minutes.」 |

**[官方明确]** Direct Upload 的上传文件数上限（<https://developers.cloudflare.com/pages/get-started/direct-upload/>，Apr 21, 2026）：Wrangler **20,000 files**、拖拽 **1,000 files**；两者单文件均为 **25 MiB**（与上面 25 MiB 一致）。

---

## 3. Pages Functions 请求 vs Workers 配额

### 3.1 Functions 请求计入 Workers 的 100,000 请求/天

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/pricing/>（Last updated **Sep 8, 2026**）：

> “**Free Plan**
> Requests to your Pages Functions **count towards your quota for the Workers Free plan**. For example, you could use **50,000 Functions requests and 50,000 Workers requests** to use your full **100,000 daily request usage**. The free plan daily request limit **resets at midnight UTC**.”

> “**Paid Plans**
> Requests to your Pages functions count towards your quota for Workers Paid plans, **including requests from your Function to KV or Durable Object bindings**.”

**[官方明确]** 同口径亦见：
- <https://developers.cloudflare.com/pages/platform/limits/>（Sep 5, 2026）：
  > “Requests to Pages functions **count towards your quota for Workers plans**, including requests from your Function to KV or Durable Object bindings. Pages supports the Standard usage model.”
- <https://developers.cloudflare.com/workers/platform/pricing/>（Last updated **Aug 28, 2026**）：
  > “**Pages Functions billing** — All Pages Functions are billed as Workers. All pricing and inclusions in this document apply to Pages Functions.”

**[官方明确]** Workers Free 的请求额度与超限行为（<https://developers.cloudflare.com/workers/platform/limits/>，**页面未显示 Last updated 日期**）：

> “Accounts on the Workers Free plan have a daily request limit of **100,000 requests, resetting at midnight UTC**. When a Worker exceeds this limit, Cloudflare returns **Error 1027**.”
> 路由层的 fail mode 表：`Fail open` = “Bypasses the Worker. Requests behave as if no Worker is configured.”；`Fail closed` = “Returns a Cloudflare 1027 error page. Use this for security-critical Workers.”

**[官方明确]** Pages 侧的等价开关（<https://developers.cloudflare.com/pages/functions/routing/>，Last updated **Apr 21, 2026**）：

> “**Fail open / closed** — If on the Workers Free plan, you can configure how Pages behaves when your **daily free tier allowance of Pages Functions requests is exhausted**… "Fail open" means that **static assets will continue to be served**, even if Pages Functions would ordinarily have run first. "Fail closed" means an **error page will be returned**, rather than static assets.”
> “The daily request limit for Pages Functions can be removed entirely by upgrading to Workers Standard.”

### 3.2 纯静态请求（被 `_routes.json` exclude）是否不计数、无限免费

**[官方明确] —— 这是本项目最关键的一句原文**，来源：<https://developers.cloudflare.com/pages/functions/pricing/>（Last updated **Sep 8, 2026**）：

> “**Static asset requests**
> On both free and paid plans, **requests to static assets are free and unlimited**. **A request is considered static when it does not invoke Functions.** Refer to Functions invocation routes to learn more about when Functions are invoked.”

**[官方明确]** 同义的官方第二处（<https://developers.cloudflare.com/pages/functions/routing/>，Last updated **Apr 21, 2026**）：

> “**On a purely static project, Pages offers unlimited free requests.** However, once you add Functions on a Pages project, **all requests by default will invoke your Function**. To continue receiving **unlimited free static requests**, exclude your project's static routes by creating a `_routes.json` file. This file will be automatically generated if a `functions` directory is detected in your project when you publish your project with Pages CI or Wrangler.”

**[官方明确]** 第三处（<https://developers.cloudflare.com/pages/functions/routing/>，例 2 下方注）：
> “Any route inside the `/build` directory will not invoke the Function and **will not incur a Functions invocation charge**.”

**是否存在「静态请求也有某额度」的相反表述？**
- **在 Pages 文档范围内：未找到**。Pages Functions Pricing、Pages Limits、Pages Functions Routing、Pages Functions Metrics 四页**均无**「静态请求上限 / 静态请求额度」类表述；口径一致为 **free and unlimited**。
- **但在 Workers（Static Assets）侧存在一处措辞张力**（<https://developers.cloudflare.com/workers/platform/pricing/>，Aug 28, 2026），需引用以免以后误用：
  > 脚注 3：“**Requests to static assets are free and unlimited.**”
  > 脚注 4：“When **Workers Caching** is enabled, requests served from the Worker's cache are **billed at the same per-request rate as requests that invoke the Worker**. This includes requests to **static assets** and worker-to-worker invocations. CPU time is only billed when the Worker runs (on a cache miss or bypass).”
  → **[官方明确]** 这是 **Workers Static Assets + Workers Caching** 的规则，**不等同于 Pages**；但它是「静态请求并非无条件免费」的唯一官方反例。**未找到**任何证据表明该规则适用于 Pages 的 `_routes.json` 静态路径。**标为边界，需实测**（§7）。

### 3.3 `_routes.json` 缺失时会怎样

**[官方明确]** 默认行为（<https://developers.cloudflare.com/pages/functions/routing/>，Last updated **Apr 21, 2026**）：

> “However, once you add Functions on a Pages project, **all requests by default will invoke your Function**.”

→ 即：**若没有任何 exclude，全部请求（含静态资源）都会先跑 Function ⇒ 全部计入 Workers 100,000/天 的 Functions 请求额度。**

**[官方明确]** 但「文件真的不存在」这一前提在官方描述里会被自动消除：

> “This file **will be automatically generated** if a `functions` directory is detected in your project **when you publish your project with Pages CI or Wrangler**.”

**[未找到一手来源]** 官方**未给出**自动生成时 `include` / `exclude` 的**具体内容**（哪些路径被排除）。因此：「自动生成出来的 `_routes.json` 到底会不会把 `/assets/*` 之类的静态路径排除掉」**官方无明文**，必须实测（见 §7）。

**`_routes.json` 结构（[官方明确]，同页）**：
```json
{
  "version": 1,
  "include": ["/*"],
  "exclude": []
}
```
> “**version**: Defines the version of the schema. Currently there is only one version of the schema (version 1)…”
> “**include**: Defines routes that will be invoked by Functions. Accepts wildcard behavior.”
> “**exclude**: Defines routes that will not be invoked by Functions. Accepts wildcard behavior. **`exclude` always take priority over `include`.**”
> “**Wildcards match any number of path segments (slashes).** For example, `/users/*` will match everything after the `/users/` path.”
> 放置位置：“It should be placed in the **build directory** of your project.”

**Limits（[官方明确]，同页）**：
> “You must have at least one include rule. / You may have no more than **100 include/exclude rules combined**. / Each rule may have no more than **100 characters**.”

**对项目最直接的一句（[官方明确]，同页）**：
```json
{
  "version": 1,
  "include": ["/*"],
  "exclude": ["/build/*"]
}
```
> “Any route inside the `/build` directory will not invoke the Function and **will not incur a Functions invocation charge**.”

→ 本项目形态：`include: ["/api/*"]` + 其余静态路径不 include（或显式排除），即可让 React 静态资源不进 Functions 额度。**注意 include 至少 1 条**，故不能写成 `include: []`。

**函数调用指标口径（[官方明确]，<https://developers.cloudflare.com/pages/functions/metrics/>，Last updated Apr 21, 2026）**：
> “**Total**: All incoming requests registered by a Function. **Requests blocked by WAF or other security features will not count.**”
> “**Subrequests**: Requests triggered by calling `fetch` from within a Function. **When your Function fetches a static asset, it will count as a subrequest.** A subrequest that throws an uncaught error will not be counted.”
> “**Internal Error** … **These requests are not counted towards usage for billing purposes.**”

### 3.4 Pages Functions 的子请求额度（D1 查询算不算、走哪个额度）

**[官方明确]** 子请求的定义（<https://developers.cloudflare.com/workers/platform/limits/>，**页面未显示 Last updated 日期**）：

> “A subrequest is any request a Worker makes using the **Fetch API** or to Cloudflare services like **R2, KV, or D1**.”

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Subrequests per invocation | **50** | 10,000 (up to 10M) |
| Subrequests to **internal services** | **1,000** | Matches configured limit (default 10,000) |

> 补充（同页）：“Each subrequest in a redirect chain counts against this limit… You can change the subrequest limit per Worker using the `limits` configuration in your Wrangler configuration file.”

**[官方明确]** 官方 Changelog 对本条给出**最直白的表述**（<https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/>，**2026-02-11**）：

> “Workers no longer have a limit of 1000 subrequests per invocation… By default, Workers on paid plans are now limited to **10,000 subrequests per invocation**, but this limit can be increased up to 10 million by setting the new `subrequests` limit in your Wrangler configuration file.”
> “**Workers on the free plan remain limited to 50 external subrequests and 1,000 subrequests to Cloudflare services per invocation.**”

→ **[官方明确]** **D1 属于「Cloudflare services」（内部服务），故 Free 下 D1 查询走 1,000/invocation 这一档，而不是 50 这一档。** 这是本次调研相对既有报告（`cloudflare-free-tier-constraints.md` §4.3 写「免费版每个 Worker/Pages 调用最多 50 次 D1 查询」）的**修正点**。

**⚠️ 但存在官方内部冲突**：D1 Limits 页（<https://developers.cloudflare.com/d1/platform/limits/>，Last updated **Apr 21, 2026**）仍写：

> `Queries per Worker invocation (read subrequest limits) | **1000 (Workers Paid) / 50 (Free)**`

该行链接到 Workers Limits 的 `#subrequests` 锚点，而其**自身数字与 Workers Limits 页 + 2026-02-11 Changelog 不一致**（D1 页日期 **2026-04-21** 晚于 Changelog 的 **2026-02-11**，可能未同步）。**两边都保留，见 §8；配额核算建议按更保守的口径规划，并以实测（`meta` / dashboard 子请求指标）确认。**

**D1 侧的其他相关上限（[官方明确]，D1 Limits 页，Apr 21, 2026）**：
> “You can open up to **six connections** (to D1) simultaneously for each invocation of your Worker.”
> “Each individual D1 database is **inherently single-threaded**, and processes queries one at a time.”（队列满返回 **"overloaded" error**）
> `Maximum SQL query duration | 30 seconds`
> `Maximum bound parameters per query | 100`
> `Maximum SQL statement length | 100,000 bytes (100 KB)`
> Batch：“Limits for individual queries (listed above) apply to **each individual statement** contained within a batch statement.”

**Pages Functions 的 CPU 上限**：沿用既有报告结论 —— **[官方明确]** 官方只写「按 Workers 计费 / 占用 Workers 配额 / 超 CPU 会报错」，**未逐字写 Pages Functions 的 CPU = 10 ms**（见 `cloudflare-auth-platform-facts.md` §1 缺口 1）。本文不重复论证。

---

## 4. Cron Worker 的部署

> 本节与 `cloudflare-cron-and-timezone-facts.md` 互补；cron 表达式语法、时区、失败语义等**不重复**，只补「部署流程 / 改 cron 是否要重部署 / 删除 / 账户级 5 个」的原文。

### 4.1 `wrangler deploy` 部署带 `triggers.crons` 的 Worker：官方流程

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated **Sep 4, 2026**）

1. **先写 handler**：
   > “To respond to a Cron Trigger, you must add a `"scheduled"` handler to your Worker.”
   ```js
   export default {
     async scheduled(controller, env, ctx) {
       console.log("cron processed");
     },
   };
   ```
2. **再改配置**（Wrangler 配置文件，jsonc/toml 双示例）：
   ```jsonc
   {
     "triggers": {
       // Schedule cron triggers:
       // - At every 3rd minute
       // - At 15:00 (UTC) on first day of the month
       // - At 23:59 (UTC) on the last weekday of the month
       "crons": ["*/3 * * * *", "0 15 1 * *", "59 23 LW * *"]
     }
   }
   ```
   > “If a Worker is managed with Wrangler, **Cron Triggers should be exclusively managed through the Wrangler configuration file.**”
   > 多环境可把 `triggers` 放到 `env.<name>` 下（同页示例）。
3. **部署**：`wrangler deploy`（[官方明确]，见 4.2 的替换语义 + `wrangler deploy` 命令页的 `--triggers` / `--schedule` / `--schedules` 选项）。
   > `wrangler deploy` 选项（<https://developers.cloudflare.com/workers/wrangler/commands/workers/>，Last updated **Sep 4, 2026**）：
   > “`--triggers`, `--schedule`, `--schedules` `string[]` optional — **Cron schedules to attach to the deployed Worker.**”
4. **传播延迟**（[官方明确]，cron-triggers 页）：
   > “Cron Trigger changes take time to propagate. Changes such as adding a new Cron Trigger, updating an old Cron Trigger, or deleting a Cron Trigger may take **several minutes (up to 15 minutes)** to propagate to the Cloudflare global network.”

### 4.2 修改 cron 表达式后是否需要重新部署

**[官方明确]** **需要**。决定性原文（来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>，Last updated **Sep 4, 2026**，「Remove a Cron Trigger > Via the Wrangler configuration file」节）：

> “**When deploying a Worker with Wrangler any previous Cron Triggers are replaced with those specified in the `triggers` array.**
> - If the `crons` property is an **empty array** then **all the Cron Triggers are removed**.
> - If the `triggers` or `crons` property are **`undefined`** then the **currently deploy Cron Triggers are left in-place**.”

→ **[官方明确]** cron 是**部署时随配置一起推送**的（声明式、全量替换），因此**改表达式 = 改配置 = 重新 `wrangler deploy`**。仅改本地配置文件而不部署，线上不会变。

**[官方间接]** 配套证据（同页 + `wrangler deploy` 页）：官方把 Wrangler 配置视为唯一真相源——“It is recommended best practice to treat your Wrangler developer environment as a **source of truth** for your Worker configuration, and **avoid making changes via the Cloudflare dashboard**”;“If you change your environment variables in the Cloudflare dashboard, **Wrangler will override them the next time you deploy**.”

### 4.3 删除 cron 的做法

**[官方明确]** 两条官方路径（同页）：

- **配置文件（推荐，Wrangler 管理的 Worker）**：把 `triggers.crons` 设为**空数组**：
  ```jsonc
  {
    "triggers": {
      // Remove all cron triggers:
      "crons": []
    }
  }
  ```
  然后 `wrangler deploy`。**注意**：若把 `triggers` / `crons` 写成 `undefined`（即整个字段删掉），官方明确「currently deploy Cron Triggers are **left in-place**」——**不会删除**。
- **Dashboard**：
  > “Workers & Pages → Select your Worker → **Triggers** → select the three dot icon next to the Cron Trigger you want to remove → **Delete**.”
  > 添加侧路径为 “Overview → select your Worker → **Settings** → **Triggers** → **Cron Triggers**”。

### 4.4 免费版 5 个 Cron Triggers / 账户 + 多 Worker 是否共享

**[官方明确]** Workers Limits 页「Account plan limits」表（<https://developers.cloudflare.com/workers/platform/limits/>，**页面未显示 Last updated 日期**）：

| Feature | Workers Free | Workers Paid |
|---|---|---|
| Number of Cron Triggers **per account** | **5** | **250** |

> → **[官方明确]** 行名逐字为 **per account**，故**同一账户下所有 Worker 的 Cron Trigger 数量合计 ≤ 5（Free）**，多个 Worker **共享**这 5 个额度。

**[官方明确]** 同一数字在 Cron Triggers 页的侧证（<https://developers.cloudflare.com/workers/configuration/cron-triggers/>，Sep 4, 2026）：
> “**Limits** — Refer to Limits to track the maximum number of Cron Triggers **per Worker**.”

**⚠️ 措辞不一致（保留双方，见 §8）**：Cron Triggers 页写 **per Worker**（指路句），Workers Limits 表的实际行名写 **per account**。**以 Limits 页的表为准 = 每账户 5 个**（与 `cloudflare-cron-and-timezone-facts.md` §1 结论一致）。

**[官方明确]** 相关 CPU 与墙钟（Workers Limits 页）：
- `CPU time per Cron Trigger | 10 ms (Free) | 30 s（间隔 < 1h）/ 15 min（间隔 ≥ 1h）(Paid)`
- Wall time：`Cron Triggers | 15 minutes | Scheduled Workers have a maximum wall time of 15 minutes per invocation.`

---

## 5. 本地开发工具链

### 5.1 `wrangler pages dev` 的官方用法

**[官方明确]** 来源：<https://developers.cloudflare.com/pages/functions/local-development/>（Last updated **Apr 21, 2026**）：

> “The main command for local development on Pages is **`wrangler pages dev`**. This will let you run your Pages application locally, which includes **serving static assets and running your Functions**.”

```sh
npx wrangler pages dev <DIRECTORY-OF-ASSETS>
```
> “You can press `b` to open the browser on your local site, (available, by default, on **http://localhost:8788**).”
> “If you have a Wrangler configuration file configured for your Pages project, you can run `wrangler pages dev` **without specifying a directory**.”
> HTTPS：`npx wrangler pages dev --local-protocol=https <DIRECTORY-OF-ASSETS>`（或配置里的 `local_protocol`）

**[官方明确]** 完整选项表（来源：<https://developers.cloudflare.com/workers/wrangler/commands/pages/>，**页面未显示 Last updated 日期**）：

```
npx wrangler pages dev [DIRECTORY] [COMMAND]
```
关键可选项（逐字摘要）：

| 选项 | 说明 |
|---|---|
| `--d1 <D1_BINDING>` | “D1 database to bind (--d1 D1_BINDING)” |
| `--kv` (`-k`) | “KV namespace to bind (--kv KV_BINDING)” |
| `--r2` | “R2 bucket to bind (--r2 R2_BINDING)” |
| `--do` (`-o`) | “Durable Object to bind (--do DO_BINDING=CLASS_NAME@SCRIPT_NAME)” |
| `--binding` (`-b`) | “Bind variable/secret (KEY=VALUE)” |
| **`--persist-to <path>`** | “Specify directory to use for local persistence (**defaults to `.wrangler/state`**)” |
| `--compatibility-date` / `--compatibility-flags` | compatibility 检查用 |
| `--port` / `--ip` / `--inspector-port` / `--proxy` | 本地服务端口/代理 |
| `--script-path` | “The location of the single Worker script if not using functions [default: `_worker.js`]” |
| `--local-protocol` | `"http" \| "https"` |
| `--live-reload` | Auto reload HTML pages |
| `--log-level` / `--show-interactive-dev-session` | 日志/交互 |

**⚠️ 注意（易踩）**：当前官方 `wrangler pages dev` 选项表**没有 `--local` 与 `--remote` 这两个 flag**（只有 `--local-protocol`）。`wrangler pages dev` **本身就是本地模式**。`--local` / `--remote` 是 `wrangler d1 ...`（见 5.3）与 `wrangler dev` 的选项。**不要照搬旧文档里的 `wrangler pages dev --local`。**

### 5.2 如何给 `wrangler pages dev` 挂本地 D1

**[官方明确]** 两种官方做法（来源：<https://developers.cloudflare.com/pages/functions/bindings/>，Last updated **Jun 25, 2026**）：

> “You can interact with your D1 database bindings locally in one of two ways:
> - **Configure your Pages project's Wrangler file** and run `npx wrangler pages dev`.
> - **Pass arguments to `wrangler pages dev` directly.**”

方式 A —— 命令行直接传（逐字）：
```sh
npx wrangler pages dev <OUTPUT_DIR> --d1 NORTHWIND_DB=xxxx-xxxx-xxxx-xxxx-xxxx
```
> “If your D1 database is bound to your Pages Function via the `NORTHWIND_DB` binding and the `database_id` in your Wrangler file is `xxxx-xxxx-xxxx-xxxx-xxxx`, access this database in local development by running: …”
> 优先级：“If a binding is specified in a Wrangler configuration file **and** via a command-line argument, **the command-line argument takes precedence**.”

方式 B —— Wrangler 配置文件里声明 D1 binding。**Pages 场景的官方配置**（来源：<https://developers.cloudflare.com/d1/best-practices/local-development/>，Last updated **Jun 25, 2026**）：

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
> “**`preview_database_id`: "DB" // Required for Pages local development**”
> “You can then execute queries and/or run migrations against a local database as part of your local development process by passing the `--local` flag to wrangler:”
```sh
wrangler d1 execute YOUR_DATABASE_NAME \
  --local --command "CREATE TABLE IF NOT EXISTS users ( user_id INTEGER PRIMARY KEY, email_address TEXT, created_at INTEGER, deleted INTEGER, settings TEXT);"
```
> “The preceding command would execute queries the **local only** version of your D1 database. **Without the `--local` flag, the commands are executed against the remote version** of your D1 database running on Cloudflare's network.”

**⚠️ Pages 的本地 D1 硬约束（[官方明确]，同页）**：
> “**You can only develop against a *local* D1 database when using Cloudflare Pages** by creating a minimal Wrangler configuration file in the root of your Pages project.”
> “**It is currently not possible to develop against a *remote* D1 database when using Cloudflare Pages.**”

**⚠️ 两页对 `preview_database_id` 的说法不一致**：D1 本地开发页说「Required for Pages local development」；Pages Functions 的两页（<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>、<https://developers.cloudflare.com/pages/functions/bindings/>，均 Last updated **Jun 25, 2026**）的示例里**只出现 `database_id`，未出现 `preview_database_id`**。**两边都保留**，见 §8；实操上以 D1 页（明确标 Required）为准，并实测。

**[官方明确]** Pages Functions 侧的补充（<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>，Last updated **Jun 25, 2026**）：
> “When using Wrangler in the default local development mode, **files will be written to local storage instead of the preview or production database**.”
> “The Wrangler configuration file **applies locally when using `wrangler pages dev`**.”
> `pages_build_output_dir` 为 **required**，示例 `./dist`。

### 5.3 本地 D1 数据存在哪 / 如何重置 / `--local` vs `--remote`

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/local-development/local-data/>（Last updated **Jun 25, 2026**）：

> ““**Where local data gets stored** — By default, both Wrangler and the Vite plugin store local binding data in the same location: **the `.wrangler/state` folder in your project directory**. This folder stores data in subdirectories for all local bindings: KV namespaces, R2 buckets, D1 databases, Durable Objects, etc.”
> “**Clearing local storage** — You can **delete the `.wrangler/state` folder at any time to reset your local environment**, and Miniflare will recreate it the next time you run your `dev` command. You can also delete specific sub-folders within `.wrangler/state` for more targeted clean-up.”
> “**Changing the local data directory** — Use the `--persist-to` flag with `wrangler dev`. **You need to specify this flag every time you run the `dev` command**”
> “The local persistence folder (like `.wrangler/state` or any custom folder you set) **should be added to your `.gitignore`**.”
> 组合用法：“If you run `wrangler dev --persist-to <DIRECTORY>` to specify a custom location for local data, you must also include the same `--persist-to <DIRECTORY>` when running other Wrangler commands that modify local data (and be sure to include the `--local` flag).”

**[官方明确]** 默认的本地资源创建与「本地 ≠ 生产」（同页 + <https://developers.cloudflare.com/workers/local-development/>，Last updated **Aug 20, 2026**）：
> “When you run either `wrangler dev` or `vite`, Miniflare automatically creates **local versions** of your resources (like KV, D1, or R2). … **newly created local resources won't contain any data** — you'll need to use Wrangler commands with the `--local` flag to populate them. **Changes made to local resources won't affect production data.**”
> “`wrangler dev` runs the local `workerd` runtime with **`TZ=UTC`** to match the production Cloudflare runtime. `Date` and `Intl` APIs inside your Worker observe UTC during local development, **regardless of your machine's timezone**.”

**D1 的 `--local` vs `--remote`（[官方明确]，`wrangler d1 execute` 选项表，<https://developers.cloudflare.com/workers/wrangler/commands/d1/>，页面未显示 Last updated 日期）**：

| Flag | 逐字说明 |
|---|---|
| `--local` | “Execute commands/files against a **local** DB for use with `wrangler dev`” |
| `--remote` | “Execute commands/files against a **remote** D1 database for use with remote bindings or your deployed Worker” |
| `--persist-to` | “Specify directory to use for local persistence (**for use with `--local`**)” |
| `--preview` | “Execute commands/files against a **preview** D1 database”（default: false） |
| `--command` / `--file` | SQL 串 / `.sql` 文件；官方明确 “You must provide either `--command` or `--file` for this command to run successfully.” |
| `--json` | 输出 JSON |

`d1 export` / `d1 migrations list` / `d1 migrations apply` 同样有 `--local` / `--remote` / `--preview`；`--persist-to` 只与 `--local` 搭配（“you must use `--local` with this flag”）。

**⚠️ 注意**：`wrangler d1 execute` 的 `--local` / `--remote` 无默认值提示；而文档正文（D1 本地开发页）明确「Without the `--local` flag, the commands are executed against the **remote** version」。两份官方文本对「不传 flag 时的默认」表述不完全一致，**务必显式传 flag**。

### 5.4 本地测试 `scheduled()` handler

**[官方明确]** 来源：<https://developers.cloudflare.com/workers/configuration/cron-triggers/>（Last updated **Sep 4, 2026**），「Test Cron Triggers locally」节：

> “Test Cron Triggers using Wrangler with **`wrangler dev`**… This exposes a **`/cdn-cgi/local/scheduled`** route, which can be used to test using an HTTP request.”
```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```
> “By default, the endpoint returns the scheduled handler outcome as text. To return the structured scheduled handler result as JSON, pass `?format=json`.”
```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json"
```
```json
{
  "outcome": "ok",
  "noRetry": false
}
```
> “The `noRetry` field is `true` when the scheduled handler calls `controller.noRetry()`.”
> “To simulate different cron patterns, a **`cron` query parameter** can be passed in.”
```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```
> “Optionally, you can also pass a **`time`** query parameter to override `controller.scheduledTime` in your scheduled event listener.”
```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&time=1745856238000"
```

**[官方明确]** `--test-scheduled` flag 的官方描述（<https://developers.cloudflare.com/workers/wrangler/commands/workers/>，Last updated **Sep 4, 2026**）：

> “`--test-scheduled` `boolean` (default: `false`) optional — Exposes a **`/cdn-cgi/local/scheduled`** fetch route which will trigger a scheduled event (Cron Trigger) for testing during development. To simulate different cron patterns, a `cron` query parameter can be passed in: `/cdn-cgi/local/scheduled?cron=*+*+*+*+*`.”

**⚠️ 路由名更正（对问题中假设的更正）**：**当前官方文档的路由是 `/cdn-cgi/local/scheduled`，不是 `/__scheduled`。** 本次检索的全部官方页面（Cron Triggers 页、wrangler commands/workers 页）**均未出现** `/__scheduled` 这一路径。若在旧版 wrangler 或旧文档里见过 `/__scheduled`，**属历史写法，本次未找到任何当前官方一手来源支持它**。

**版本要求（[官方间接]）**：Cron Triggers 页与 `wrangler dev` 页都未给 `--test-scheduled` 的最低 wrangler 版本。**未找到一手来源。**

### 5.5 wrangler 的版本要求与 `wrangler.toml` vs `wrangler.jsonc`

**[官方明确]** **Node 版本要求**（来源：<https://developers.cloudflare.com/workers/wrangler/install-and-update/>，**页面未显示 Last updated 日期**）：

> “**Wrangler System Requirements**
> We support running the Wrangler CLI with the **Current, Active, and Maintenance** versions of Node.js. Your Worker will always be executed in `workerd`, the open source Cloudflare Workers runtime.
> Wrangler is only supported on **macOS 13.5+, Windows 11**, and Linux distros that support **glib 2.35**.”

→ **[官方明确]** 对开发者环境（**Windows + PowerShell**）：官方支持下限是 **Windows 11**；Node 必须落在 Node.js 官方的 Current / Active LTS / Maintenance 三个通道内（即**不接受 EOL 版本**）。官方**未给**一个具体的最低 Node 版本号。

**[官方明确]** 另一处给了具体数字（来源：<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>，Last updated **Apr 21, 2026**）：
> “**Wrangler requires a Node version of at least `16.17.0`.** You must upgrade your Node.js version if your version is lower than `16.17.0`.”

→ **两者并存**（一个是「跟着 Node 支持窗口走」，一个是「硬地板 16.17.0」），见 §8。实操建议：用当前 LTS（远高于 16.17.0）。

**[官方明确]** 安装方式与推荐版本（install-and-update 页）：
> “Since Cloudflare recommends **installing Wrangler locally in your project** (rather than globally)…”
```sh
npm i -D wrangler@latest
```
> “**Caution** — If Wrangler is not installed, running `npx wrangler` will use the **latest** version of Wrangler.”

**[官方明确]** **wrangler 4 的存在与推荐**（两处独立证据）：
- Pages Limits 页（Sep 5, 2026）关于 100,000 文件上限：“To enable this increased limit, set the environment variable **`PAGES_WRANGLER_MAJOR_VERSION=4`** in your Pages project settings.”
- `wrangler-action` README：“The action now **defaults to Wrangler v4**. If you need to stay on Wrangler v3, you can pin the version explicitly: `wranglerVersion: "3.90.0"`.”
→ **[官方明确]** **官方生态已以 Wrangler v4 为当前版本**；v3 通过显式 pin 仍可用。**未找到**任何官方页面写「必须用 v3」或「推荐 v3」。

**[官方明确]** `wrangler.toml` vs `wrangler.jsonc`（来源：<https://developers.cloudflare.com/workers/wrangler/configuration/>，**页面未显示 Last updated 日期**）：

> “As of **Wrangler v3.91.0** Wrangler supports both **JSON (`wrangler.json` or `wrangler.jsonc`)** and **TOML (`wrangler.toml`)** for its configuration file. Prior to that version, only `wrangler.toml` was supported.”
> “**Cloudflare recommends using `wrangler.jsonc` for new projects**, and **some newer Wrangler features will only be available to projects using a JSON config file.**”
> “The format of Wrangler's configuration file is exactly the same across both languages, only the syntax differs.”
> “You can use one of the many available online converters to easily switch between the two.”

**[未找到一手来源]** 官方**未说明**当 `wrangler.toml` / `wrangler.json` / `wrangler.jsonc` **同时存在**时的优先级顺序。

> **交叉提示**：`wrangler d1 migrations apply` 会自动备份（“After applying, a backup will be captured. … When running the apply command in a CI/CD environment or another non-interactive command line, **the confirmation step will be skipped, but the backup will still be captured.**”），且 “If applying a migration results in an error, **this migration will be rolled back, and the previous successful migration will remain applied.**”（<https://developers.cloudflare.com/workers/wrangler/commands/d1/>，无日期）。

### 5.6 D1 migrations 的官方流程与目录约定

**[官方明确]** 来源：<https://developers.cloudflare.com/d1/reference/migrations/>（Last updated **Jun 8, 2026**）：

> “Database migrations are a way of versioning your database. **Each migration is stored as an `.sql` file in your `migrations` folder.** The `migrations` folder is **created in your project directory when you create your first migration**.”
> “**Every migration file in the `migrations` folder has a specified version number in the filename. Files are listed in sequential order.** Every migration file is an SQL file where you can specify queries to be run.”
> “**Binding name vs Database name** — When running a migration script, you can use either the binding name or the database name. However, **the binding name can change, whereas the database name cannot**. Therefore, to avoid accidentally running migrations on the wrong binding, **you may wish to use the database name** for D1 migrations.”
> “By default, migrations are created in the `migrations/` folder in your Worker project directory. **Creating migrations will keep a record of applied migrations in the `d1_migrations` table found in your database.**”

**文件名规则（[官方明确]，`d1 migrations create` 命令页）**：
> “This will generate a new versioned file inside the 'migrations' folder. … An example filename looks like: `0000_create_user_table.sql` — **The filename will include a version number and the migration name you specify.**”

**可定制项（[官方明确]，migrations 页）**：`migrations_table`（默认 `d1_migrations`）、`migrations_dir`、`migrations_pattern`（glob，用于 ORM 生成的嵌套目录布局，例如 `"migrations_pattern": "migrations/*/migration.sql"`）。规则：“When set, `migrations_dir` must also be set. / The pattern must start with whatever `migrations_dir` is set to. / Each migration's name is recorded in the migrations table as the path relative to `migrations_dir`.”

**命令与 flag（[官方明确]，`wrangler d1` 命令页，无日期）**：

| 命令 | 说明 | `--local` / `--remote` / `--preview` |
|---|---|---|
| `wrangler d1 migrations create [DATABASE] [MESSAGE]` | 生成带版本号的新迁移文件 | — |
| `wrangler d1 migrations list [DATABASE]` | “View a list of **unapplied** migration files” | 三者皆有 |
| `wrangler d1 migrations apply [DATABASE]` | “Apply any unapplied D1 migrations” | 三者皆有 |

官方流程（三句中，逐字）：
```sh
# 本地
npx wrangler d1 migrations apply <DATABASE> --local
# 远程（生产）
npx wrangler d1 migrations apply <DATABASE> --remote
```
> “**Foreign key constraints** — When applying a migration, you may need to temporarily disable foreign key constraints. To do so, call **`PRAGMA defer_foreign_keys = true`** before making changes that would violate foreign keys.”

> **注意（旧文档移除）**：`wrangler d1 migrations apply` 的 `--remote` 官方说明为 “Execute commands/files against a **remote** DB for use with `wrangler dev --remote`”（措辞偏旧），但语义即「打到线上库」。同时 `--remote` 与 `--local` 是**互斥的一个动作的两个目标**，别同时传。

---

## 6. 免费配额汇总核对表（**只给官方数字与原文，不做用量估算**）

> 本表由主 Agent 用于配额核算，**不含任何用量估算**。所有数字均为 **2026-09-16 快照**。
> 「文档日期」列：`—` 表示该页**不显示** Last updated。

| # | 配额项 | 官方数字（Workers/Pages **Free**） | 来源 URL | 文档日期 |
|---|---|---|---|---|
| 1 | Workers 请求 | **100,000 / day**，`resetting at midnight UTC`；超限返回 **Error 1027** | <https://developers.cloudflare.com/workers/platform/limits/> | — |
| 2 | Pages Functions 请求 | 并入 #1：「count towards your quota for the Workers Free plan」；例：50,000 Functions + 50,000 Workers = 满 100,000 | <https://developers.cloudflare.com/pages/functions/pricing/> | Sep 8, 2026 |
| 3 | Pages 纯静态请求 | **free and unlimited**（「A request is considered static when it does not invoke Functions.」）；纯静态项目「unlimited free requests」 | <https://developers.cloudflare.com/pages/functions/pricing/>；<https://developers.cloudflare.com/pages/functions/routing/> | Sep 8, 2026；Apr 21, 2026 |
| 4 | CPU time / HTTP 请求 | **10 ms** | <https://developers.cloudflare.com/workers/platform/limits/> | — |
| 5 | CPU time / Cron Trigger | **10 ms** | 同上 | — |
| 6 | Memory | **128 MB** / isolate | 同上 | — |
| 7 | Worker 体积 / 启动时间 | **64 MiB**（uncompressed）/ **1 second** startup | 同上 | — |
| 8 | 子请求 / invocation | **50**（外部）；**1,000**（对 Cloudflare 内部服务，含 D1） | 同上；<https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/> | —；**2026-02-11** |
| 9 | 同时出站连接 / 请求 | **6** | <https://developers.cloudflare.com/workers/platform/limits/> | — |
| 10 | D1 读行 | **5,000,000 / day**（`Free limits reset daily at 00:00 UTC`） | <https://developers.cloudflare.com/d1/platform/pricing/> | Apr 21, 2026 |
| 11 | D1 写行 | **100,000 / day**（同上重置） | 同上 | Apr 21, 2026 |
| 12 | D1 存储 | 单库 **500 MB**（Free）/ 账户合计 **5 GB**（Free） | <https://developers.cloudflare.com/d1/platform/limits/> | Apr 21, 2026 |
| 13 | D1 数据库数 / 账户 | **10**（Free）；Paid 50,000 | 同上 | Apr 21, 2026 |
| 14 | D1 Time Travel（PITR） | **7 days**（Free）；restore 限 **10 次 / 10 分钟 / 库** | 同上 | Apr 21, 2026 |
| 15 | D1 单行 / 单语句上限 | 行 **2 MB**；SQL 语句 **100 KB**；绑定参数 **100**；查询时长 **30 s**；列 **100/表** | 同上 | Apr 21, 2026 |
| 16 | D1 连接数 | 每次 Worker invocation 最多 **6** 个同时连接 | 同上 | Apr 21, 2026 |
| 17 | Cron Triggers / 账户 | **5**（Free）；Paid 250 | <https://developers.cloudflare.com/workers/platform/limits/> | — |
| 18 | Pages 构建 / 月 | **500**（Free）；Pro 5,000；Business 20,000。另表述：「500 deploys per month on the Free plan」 | <https://developers.cloudflare.com/pages/platform/limits/>；<https://developers.cloudflare.com/pages/> | Sep 5, 2026；Aug 25, 2026 |
| 19 | Pages 并发构建 | **1 build at a time**（Free）；并发「counted **per account**」 | <https://developers.cloudflare.com/pages/platform/limits/> | Sep 5, 2026 |
| 20 | Pages 单次构建超时 | **20 minutes** | 同上 | Sep 5, 2026 |
| 21 | Pages 项目数 / 账户 | **100**（Free），「not routinely increased」 | 同上 | Sep 5, 2026 |
| 22 | Pages 单站点文件数 | **20,000**（Free）；Paid 100,000（需 `PAGES_WRANGLER_MAJOR_VERSION=4`） | 同上 | Sep 5, 2026 |
| 23 | Pages 单文件大小 | **25 MiB** | 同上 | Sep 5, 2026 |
| 24 | Pages 预览部署（活跃） | **unlimited** | 同上 | Sep 5, 2026 |
| 25 | Pages custom domains / 项目 | **100**（Free）；per-project | 同上 | Sep 5, 2026 |
| 26 | Workers 数 / 账户 | **100**（Free）；Paid 500 | <https://developers.cloudflare.com/workers/platform/limits/> | — |
| 27 | 环境变量 / Worker | **64**（Free，secrets + text）；单变量 **5 KB** | 同上 | — |
| 28 | 请求体大小 | **100 MB**（Free plan，按 **Cloudflare 账户计划**而非 Workers 计划） | 同上 | — |
| 29 | 响应体大小 | **No enforced limit**；CDN cache 上限 **512 MB**（Free/Pro/Business） | 同上 | — |
| 30 | Pages Functions `_routes.json` 规则数 | **100 条**（include+exclude 合计）；每条 **≤100 字符**；**至少 1 条 include** | <https://developers.cloudflare.com/pages/functions/routing/> | Apr 21, 2026 |
| 31 | Pages `_headers` / `_redirects` | `_headers`：**100 条**，单条 **2,000 字符**；`_redirects`：静态 **2,000** + 动态 **100** = **2,100** | <https://developers.cloudflare.com/pages/platform/limits/> | Sep 5, 2026 |
| 32 | Pages Build 镜像 | 默认 **v3**（Ubuntu 22.04.2，gVisor）；默认 **Node 22.16.0** | <https://developers.cloudflare.com/pages/configuration/build-image/> | Apr 21, 2026 |
| 33 | GitHub Actions 分钟（public 仓库） | **免费**（standard GitHub-hosted runners）；larger runners **始终计费** | <https://docs.github.com/en/billing/concepts/product-billing/github-actions> | — |

---

## 7. 未找到 / 未证实 / 需实测

### A. 未找到一手来源（官方文档未给该表述或数字）

1. **Direct Upload / `wrangler pages deploy` 是否计入 500 builds/月** —— 逐页核对 Limits、Direct Upload、Use Direct Upload with CI、Build configuration、Branch deployment controls、Pages overview 六页，**无任何相关表述**（§2.1）。
2. **Preview 部署是否计入 500 builds/月** —— 只能确证「非生产分支的每次 push 会触发一次构建与部署」，**官方未明文**是否计入配额（§2.1）。
3. **500/月 是「每账户」还是「每项目」** —— 官方只对**并发构建**写明 per account（§2.1）。
4. **500/月 的重置时间点**（月历月初 vs 订阅日）—— 无官方表述（§2.1）。
5. **Pages 保留多少个 deployment** —— Limits 与 Rollbacks 页均无数字；`pages/configuration/deployments/` 页面 404（§2.3）。
6. **`_routes.json` 自动生成时的具体内容**（会排除哪些路径）—— 官方只说「会被自动生成」，未给内容（§3.3）。
7. **`wrangler pages dev --test-scheduled` 的最低 wrangler 版本** —— 无官方表述（§5.4）。
8. **`wrangler.toml` / `wrangler.json` / `wrangler.jsonc` 同时存在时的优先级** —— 官方未说明（§5.5）。
9. **Pages 文档中任何「静态请求有额度上限」的相反表述** —— **未找到**；口径统一为 free and unlimited（§3.2）。
10. **Pages Functions 的 CPU 上限逐字数字** —— 官方只写「按 Workers 计费 / 占 Workers 配额 / 超 CPU 会报错」，未逐字写「10 ms」（沿用 `cloudflare-auth-platform-facts.md` §1 的缺口，本文未推翻）。
11. **`INSERT ... ON CONFLICT DO UPDATE`（upsert）的写行计数口径** —— 沿用既有报告的缺口，本次未新增证据（`cloudflare-auth-platform-facts.md` §6）。

### B. 未证实（无官方原文，且无法推导，只能实测）

12. **在 Git 集成项目上用 `wrangler pages deploy` 是否会额外消耗 build 配额**（§2.1 的推论在行为层无法从官方文本闭合）。
13. **Pages 的静态路径在同时开启 Cloudflare 缓存规则 / Workers Caching 类能力时，是否仍保持「free and unlimited」** —— Workers Pricing 脚注 4 是唯一官方反例，但**只针对 Workers**，是否类推到 Pages **未证实**（§3.2）。
14. **`preview_database_id` 是否真的为 Pages 本地 D1 开发的必要条件** —— D1 本地开发页写 “Required”，Pages Functions 两页未提该字段（§5.2）。
15. **`wrangler d1 execute` 不传 `--local`/`--remote` 时的实际默认目标** —— 命令页无默认值说明，D1 正文说默认 remote，**两处表述不等价**（§5.3）。
16. **`cloudflare/wrangler-action@v4` 对 `pages deploy` 子命令的行为与 `@v3` 是否有差异**（README 未逐条列 breaking change 对 Pages 的影响）（§1.5）。
17. **同一 Worker 多条 cron 在同一分钟触发时是并发还是串行** —— 沿用既有报告的缺口，本次未新增证据（`cloudflare-cron-and-timezone-facts.md` §8）。

### C. 需实测（本项目落地前必须自测的项目）

18. **构建计数实测**：连续做 3 次「Git push 触发构建」、3 次「`wrangler pages deploy`（Direct Upload 项目）」、3 次「非生产分支 push」，对照 dashboard 的用量视图/构建列表，确认 `wrangler pages deploy` 与 preview 是否被计入 500 —— **这是本项目选通道的决定性实验**。
19. **`_routes.json` 实测**：在 Pages 上部署 `include: ["/api/*"]` + 静态资源路径，用 `curl` 逐路径验证静态请求是否真的不进 Functions（对比 Functions metrics 的 **Total** 曲线）。
20. **D1 子请求额度实测**：在 Free 计划下构造一次性发出 >50 条 D1 查询的 Function，观察是否在 51 条处失败；以此判定 Free 的 D1 查询上限是 **50** 还是 **1,000**（§3.4、§8 的冲突）。
21. **`/cdn-cgi/local/scheduled` 实测**：确认当前 wrangler 版本下该路由可用、`?cron=` 与 `?time=` 生效（并确认 `/__scheduled` 是否已彻底不可用）。
22. **Git 集成项目 + `wrangler pages deploy` 共存实测**：确认手动部署会生成新的 production deployment，且 dashboard 的 Git 自动部署仍可被 branch control 暂停。

---

## 8. 互相矛盾 / 口径不一致之处（**保留双方，不抹掉**）

| # | 冲突点 | 说法 A（逐字 + 日期） | 说法 B（逐字 + 日期） | 处理建议 |
|---|---|---|---|---|
| 1 | **Free 下 D1 查询（子请求）上限** | D1 Limits 页：`Queries per Worker invocation (read subrequest limits) \| 1000 (Workers Paid) / **50 (Free)**` —— <https://developers.cloudflare.com/d1/platform/limits/>，Last updated **Apr 21, 2026** | Workers Limits 页：`Subrequests to internal services \| **1,000** (Free) \| …`；2026-02-11 Changelog：「Workers on the free plan remain limited to **50 external subrequests and 1,000 subrequests to Cloudflare services** per invocation」—— <https://developers.cloudflare.com/workers/platform/limits/>（无日期）；<https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/>，**2026-02-11** | **两个数字都在官方站上**。Changelog（更晚且更具体）支持 1,000；D1 页（更晚日期但逻辑更旧）仍写 50。**配额核算先按 50 做保守预算，并用 §7-20 的实测确认** |
| 2 | **Pages 构建镜像的默认 Node 版本** | Build image 页：v3 默认 **Node.js 22.16.0** —— <https://developers.cloudflare.com/pages/configuration/build-image/>，Last updated **Apr 21, 2026** | Known issues 页：「By default, Cloudflare uses **Node `12.18.0`** in the Pages build environment.」—— <https://developers.cloudflare.com/pages/platform/known-issues/>，Last updated **May 6, 2026** | Known issues 该句明显未跟上 v1/v2/v3 迁移（v1 镜像已于 **2026-09-15** 自动迁 v3）。**以 Build image 页为准，但落地时显式设 `NODE_VERSION` 以消除不确定性** |
| 3 | **Cron 配额是 per Worker 还是 per account** | Cron Triggers 页：「Refer to Limits to track the maximum number of Cron Triggers **per Worker**」—— <https://developers.cloudflare.com/workers/configuration/cron-triggers/>，Last updated **Sep 4, 2026** | Workers Limits 页 Account plan limits 表行名：`Number of Cron Triggers **per account** \| 5 \| 250` —— <https://developers.cloudflare.com/workers/platform/limits/>（无日期） | 两页指向同一张表；**以表行名 per account 为准（= 每账户 5 个）**，与 `cloudflare-cron-and-timezone-facts.md` §1 一致 |
| 4 | **`cloudflare/wrangler-action` 用 v3 还是 v4** | Pages CI 文档示例：`uses: cloudflare/wrangler-action@**v3**` —— <https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>，Last updated **Apr 21, 2026** | wrangler-action README：「The action now **defaults to Wrangler v4**」；示例用 `@v4`；仓库内有 commit “Update all wrangler-action@v3 references to v4”（页面显示 **Jun 6, 2026**）—— <https://github.com/cloudflare/wrangler-action> | **以仓库 README（更新的官方一手源）为准 = `@v4`**；文档页示例待官方同步 |
| 5 | **wrangler 的 Node 版本要求** | install-and-update 页：「We support running the Wrangler CLI with the **Current, Active, and Maintenance** versions of Node.js」—— <https://developers.cloudflare.com/workers/wrangler/install-and-update/>（无日期） | Pages CI 页：「Wrangler requires a Node version of **at least `16.17.0`**」—— <https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>，Last updated **Apr 21, 2026** | 不冲突但不等价：前者是「跟随 Node 支持窗口」，后者是旧硬地板。**用当前 LTS 即可同时满足** |
| 6 | **Pages 500/月的措辞：builds vs deploys** | 「Builds per month \| **500**」—— <https://developers.cloudflare.com/pages/platform/limits/>，**Sep 5, 2026** | 「**500 deploys per month** on the Free plan」—— <https://developers.cloudflare.com/pages/>，**Aug 25, 2026** | 同一配额的两个叫法。**官方未澄清二者是否严格等价**（尤其对 Direct Upload），这正是 §2.1 的核心缺口 |
| 7 | **`preview_database_id` 是否必需** | D1 本地开发页：`"preview_database_id": "DB" // **Required for Pages local development**` —— <https://developers.cloudflare.com/d1/best-practices/local-development/>，Last updated **Jun 25, 2026** | Pages Functions 的 wrangler-configuration 页与 bindings 页的示例**只有 `database_id`，无 `preview_database_id`** —— <https://developers.cloudflare.com/pages/functions/wrangler-configuration/>、<https://developers.cloudflare.com/pages/functions/bindings/>，均 Last updated **Jun 25, 2026** | 同日不同说法。**按 D1 页（标注 Required）配置**，并做 §7-19/22 类实测 |
| 8 | **Git 集成项目手动部署的命令名** | Direct Upload 页：「For existing Git-integrated projects, you can manually create deployments using **`wrangler deploy`**」—— <https://developers.cloudflare.com/pages/get-started/direct-upload/>，**Apr 21, 2026** | 同页 Wrangler CLI 一节与全站其余 Pages 文档一律用 **`wrangler pages deploy`** | **判为文档笔误**，实操用 `wrangler pages deploy <DIR>`；若要用 `wrangler deploy` 需实测确认 |
| 9 | **静态请求「免费无限」的例外** | Pages Functions Pricing：「On both free and paid plans, requests to static assets are **free and unlimited**」—— **Sep 8, 2026** | Workers Pricing 脚注 4：「When **Workers Caching** is enabled, requests served from the Worker's cache are **billed at the same per-request rate**… This includes requests to **static assets**」—— **Aug 28, 2026** | 两条官方文本**作用域不同**（Pages vs Workers Static Assets）。**不抹掉任何一方**；Pages 侧目前无相反表述，但值得在 §7-13 实测确认 |

---

## 9. 对「本地开发 vs 生产」环境划分的直接影响（事实层，不含方案）

> 每条标 **[事实]**（有一手来源）或 **[推断]**（我基于事实的判断，官方未逐字确认）。

1. **[事实]** `wrangler pages dev` 是**本地模式、无 `--local` flag**；绑定来自 Wrangler 配置文件或命令行参数，**命令行参数优先**（§5.1、§5.2）。
2. **[事实]** 本地 D1 与远端 D1 是**两套数据**：本地写在 `.wrangler/state`，删掉该目录即重置；**Pages 项目无法对远端 D1 做本地开发**（「It is currently not possible to develop against a *remote* D1 database when using Cloudflare Pages.」）（§5.2、§5.3）。
   → **[推断]** 「本地开发」与「生产」在 D1 上是**物理隔离**的两份数据；任何以「本地看起来对」为依据的验证，都不能证明生产数据正确。
3. **[事实]** `wrangler dev` 的本地 workerd 以 **`TZ=UTC`** 运行（与生产一致），**不受本机时区影响**（§5.3）。
   → **[推断]** 本地测「业务日 / 周界 / 月界」时，得到的是 UTC 行为，与本机 Windows 时区无关；边界换算必须在应用层显式做（与 `cloudflare-cron-and-timezone-facts.md` §6/§9 结论一致）。
4. **[事实]** 本地 cron 测试走 `wrangler dev --test-scheduled` + `/cdn-cgi/local/scheduled`，**不是** `/__scheduled`（§5.4）。
5. **[事实]** 迁移与本地/远端目标由 `--local` / `--remote` 显式选择，且 `--persist-to` 必须**每次**与 `--local` 一起传（§5.3、§5.6）。
6. **[事实]** 官方明确把 Wrangler 配置视为**唯一真相源**，并警告 dashboard 上的改动会在下次 `wrangler deploy` 被覆盖（§4.2）。

---

*本文件为可审计事实清单：所有 [官方明确] 结论均附 `developers.cloudflare.com` / `docs.github.com` / `github.com/cloudflare` 来源 URL 与文档 Last updated（或 Changelog 发布日期），采集日期均为 **2026-09-16**。[官方间接] / [未找到一手来源] / [未证实] 已逐条单独标注，请勿当作官方承诺；§8 的冲突项已保留双方，不做单方面删改。*
