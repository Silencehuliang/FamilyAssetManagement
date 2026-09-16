# 一手事实调研：iOS/Safari PWA 离线深度与 Service Worker 策略

> 产出票：#10 «PWA 与移动端离线策略»（本报告是其证据链的一手部分）

- **采集日期**：2026-09-16（以下所有 URL 均于该日访问）
- **范围 / 采信来源**：Apple 官方支持文档（support.apple.com）、WebKit 官方博客（webkit.org/blog）与 bug tracker（bugs.webkit.org）、W3C/WICG 规范、WHATWG HTML Living Standard、MDN（标注为「文档级」）、Chrome for Developers / Workbox 官方文档（标注为「Chrome 系官方」）。
- **不采信**：二手博客、知乎/掘金、StackOverflow、php.cn 等。凡提到只作为「线索」且不计入结论。
- **取证限制（重要，如实记录）**：
  1. 本环境只能网页抓取，无法 curl/grep。`developer.chrome.com` 直连抓取持续失败，改用官方同一套文档的本地化镜像站 `developer.chrome.google.cn`（Chrome for Developers 官方域名，内容同源），下文标 URL 时两者都给出。
  2. MDN 的「浏览器兼容性」表由脚本动态渲染，抓不到表格。故改用 MDN 渲染该表的**上游数据** `mdn/browser-compat-data`（GitHub raw JSON）。这是 MDN 官方数据源，本文标为「MDN 文档级（BCD 原始数据）」。
  3. WHATWG `input.html` 中 number 状态「for authors」的散文段（含 "not appropriate" 一段）在抓取时被截断/折叠，**未能取得逐字原文**；该点改用 MDN 文档级原文（见 §9）。已在「未证实」节登记该缺口。

---

# 块 I：iOS/Safari 的存储与后台能力

## 1. 存储配额与驱逐政策

**结论（一句话）**：WebKit 官方口径是**两套配额**——单 origin 配额 + 全局（overall）配额，按**磁盘总容量的百分比**给出（浏览器类 App：单 origin ≤60%、overall ≤80%）；**standalone 的 Home Screen web app 与浏览器 App 待遇相同**；驱逐按 **LRU、以 origin 为单位整体删除**，触发条件为「超 overall 配额 / 系统存储压力 / 长期无交互」；官方**没有给出任何固定 GB 上限数字**。

**证据**（来源：WebKit 官方博客 *Updates to Storage Policy*，2023-08-10，https://webkit.org/blog/14403/updates-to-storage-policy/ ）：

- 配额类型与适用范围：
  > "There are two types of quota in WebKit: origin quota and overall quota."
  > "Starting in Safari 17.0, and in WebKit apps for iOS 17, iPadOS 17 and macOS Sonoma:"
  > "For a browser app, the origin quota is up to 60% of the total disk space."
  > "For other apps, the origin quota is up to 15% of the total disk space."
  > "For a browser app, overall quota is up to 80% of the total disk space."
  > "For other apps, overall quota is up to 20% of the total disk space."
  > "A cross-origin frame uses a different storage partition than the frame it is embedded in to prevent tracking, and thus it has a different quota. The quota is currently 10% of the main frame's origin quota."
  > "With this change, Safari 17.0 no longer prompts users about a website wanting to use more space."
- **standalone web app 的区别**（正面回答票面问题）：
  > "When a web app is running standalone (as Home Screen Web App on iOS or Web App added to dock on macOS), it has the same origin quota and overall quota as when it is opened in a browser app."
- 受配额约束的存储类型：
  > "the policy discussed in this post is mostly related to the types created by storage APIs: localStorage, Cache API, IndexedDB, Service Worker, and File System. Other types like cookies and HTTP cache are currently not subject to the policy below — for example, they are not bounded by quota."
- 驱逐规则原文：
  > "Eviction means automatic website data deletion that is not initiated by the user or website. It can happen under a few conditions: when exceeding the overall quota, when the system is under storage pressure, or when the site has not been interacted with by the user for some time (see Intelligent Tracking Prevention)."
  > "WebKit normally evicts data on an origin basis: the data of an origin will be deleted as a whole. The ordering of origins to be deleted is decided using a least-recently-used policy. The last use time is the time of the last user interaction, or the time of the last storage operation."
  > "Origin might be excluded from eviction if it has active page at the time of eviction, or its storage is in persistent mode."

**补充**（MDN 文档级补充「旧版本行为」，来源 https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ）：
> "In earlier versions of Safari, an origin is given an initial 1 GiB quota. Once the origin reaches this limit, Safari asks the user for permission to let the origin store more data."

---

## 2. `navigator.storage.estimate()` 与 `persist()` 在 Safari

**结论（一句话）**：`estimate()` 在 **Safari 17.0** 起支持、`persist()` / `persisted()` / `getDirectory()` 在 **Safari 15.2** 起支持（桌面与 iOS 同版本号口径）；`persist()` **确实可用**，Safari **不弹权限框**，而是按启发式自动批准/拒绝，WebKit 官方明确说启发式**包含「是否作为 Home Screen Web App 打开」**；但**没有找到任何官方说法称「已添加到主屏幕即自动获得持久化存储」**，`persisted()` 也**不是**恒为 false。

**证据**

1. MDN 文档级（BCD 原始数据，`api/StorageManager.json`，https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/StorageManager.json ）：
   > `"persist": { "support": { "safari": { "version_added": "15.2" }, "safari_ios": "mirror" } }`
   > `"persisted": { "support": { "safari": { "version_added": "15.2" }, "safari_ios": "mirror" } }`
   > `"getDirectory": { "support": { "safari": { "version_added": "15.2" } } }`
   > `"estimate": { "support": { "safari": { "version_added": "17" }, "safari_ios": "mirror" } }`
   > `"usageDetails": { "support": { "safari": { "version_added": false } } }`
   （`"safari_ios": "mirror"` 表示沿用 safari 的值；`usageDetails` 在 Safari 上为 **false**，即不可用。）
2. WebKit 官方确认「Safari 17.0 起 Storage API 完整支持」，https://webkit.org/blog/14403/updates-to-storage-policy/ ：
   > "Starting in Safari 17.0, and in WebKit apps for iOS 17, iPadOS 17 and macOS Sonoma, the Storage API is fully supported."
   > "An origin can check whether storage is in persistent mode with `StorageManager.persisted()` and request to change the mode to be persistent with `StorageManager.persist()`. **WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App.**"
3. MDN 文档级说明 Safari 的批准机制（https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ）：
   > "Safari and most Chromium-based browsers, such as Chrome or Edge, automatically approve or deny the request based on the user's history of interaction with the site and do not show any prompts to the user."
4. `persist()` 的返回值语义，MDN 文档级（https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist ）：
   > "…returns a `Promise` that resolves to `true` if permission is granted and bucket mode is persistent, and `false` otherwise. The browser may or may not honor the request, depending on browser-specific rules."

**缺口**：官方**没有**「添加到主屏幕的 web app 自动获得持久化存储」这类表述。可得到的最近表述是第 2 条的「heuristics like whether the website is opened as a Home Screen Web App」（即**作为启发式的一个因素**，不等于自动授予）。→ 见「未证实」节。

---

## 3. Background Sync（`ServiceWorkerRegistration.sync` / `SyncManager`）—— 最关键一条

**结论（一句话）**：**Safari / iOS Safari 完全不支持 Background Sync，也不支持 Periodic Background Sync**（MDN 数据为 `false`）；规范层面它只是 **WICG 社区组报告、不在 W3C 标准轨道上**；WebKit 官方仅有 2018 年提交、**至今状态仍为 NEW** 的 feature request（bug 182565），**没有任何实现计划或发布说明**。

**证据**

1. 规范状态与 URL（来源：https://wicg.github.io/background-sync/spec/ ，页面自述）：
   > 标题：*Web Background Synchronization*；副标题：*Draft Community Group Report, 10 November 2021*
   > "This specification was published by the Web Platform Incubator Community Group. It is not a W3C Standard nor is it on the W3C Standards Track."
2. MDN 文档级（BCD 原始数据 `api/SyncManager.json`，https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/SyncManager.json ）：
   > `"SyncManager": { "support": { "chrome": { "version_added": "49" }, "firefox": { "version_added": false }, "safari": { "version_added": false, "impl_url": "https://webkit.org/b/182565" }, "safari_ios": "mirror" } }`
   > `"register": { "support": { "safari": { "version_added": false } } }`
   > `"getTags": { "support": { "safari": { "version_added": false } } }`
   > `"worker_support": { "support": { "safari": { "version_added": false } } }`
3. MDN 文档级（BCD 原始数据 `api/ServiceWorkerRegistration.json`，https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ServiceWorkerRegistration.json ）：
   > `"sync": { "support": { "chrome": { "version_added": "49" }, "firefox": { "version_added": false }, "safari": { "version_added": false }, "safari_ios": "mirror" } }`
   > `"periodicSync": { "support": { "chrome": { "version_added": "80" }, "firefox": { "version_added": false }, "safari": { "version_added": false }, "safari_ios": "mirror" } }`
4. WebKit 官方唯一相关条目（https://bugs.webkit.org/show_bug.cgi?id=182565 ）：
   > 标题：`Feature: Add support for the ServiceWorkerRegistration's SyncManager interface`
   > 状态：**NEW**；Reported **2018-02-07**；Component 未实现。
   > 该 bug 里只有外部开发者请愿与用例，**没有任何 WebKit 开发者表示会实现或给出排期**。最后一条评论日期为 2026-07-13（内容为无意义文本）。
   （旁证：WebKit 公司侧人员 2019 年只提了顾虑 "Exposing it without an install action would be worrisome."，未承诺实现。）

**结论措辞**：Safari 不支持 Background Sync；也不支持 Periodic Background Sync。**未找到**任何 WebKit 官方发布说明或博客宣布支持/计划支持。

---

## 4. Service Worker 在 iOS Safari 的支持与已知限制

**结论（一句话）**：SW 自 **iOS 11.3 / Safari 11.1** 起支持，且**只在 Safari、SFSafariViewController 和「保存到主屏幕的 Web 应用」中可用**（当时 WKWebView 不支持）；「Home Screen web app 独立窗口里 SW 照常工作」有官方依据（配额与存储策略上都与浏览器同等待遇），但 WebKit bug tracker 记录了多条 Home Screen + SW 的缺陷；**「SW registrations 与 Cache Storage 属于 7 天无交互即清除的脚本可写存储」已被官方两处原文确认**，且 **Home Screen web app 的第一方域名明文豁免**——但该豁免**以 manifest `display` 为 `standalone`/`fullscreen` 为前提**。

**证据**

1. 支持版本（WebKit 官方博客 *Workers at Your Service*，https://webkit.org/blog/8090/workers-at-your-service/ ）：
   > "Support is available in Safari Technology Preview 48, macOS High Sierra 10.13.4 and iOS 11.3 beta seed 2."
   > "Update: A previous version of this post stated the Service Worker API is available in all applications using WKWebView. At this time **it is only available in Safari, applications that use SFSafariViewController, and web applications saved to your home screen.**"
   Apple 官方发布说明旁证（Safari 11.1 release notes，https://developer.apple.com/library/archive/releasenotes/General/WhatsNewInSafari/Articles/Safari_11_1.html ）：
   > "Safari 11.1 ships with iOS 11.3 and macOS 10.13.4."
2. **7 天清除涵盖 SW registrations 与 cache**（WebKit 官方 2020 博文，https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ）：
   > "Now ITP has aligned the remaining script-writable storage forms with the existing client-side cookie restriction, deleting all of a website's script-writable storage after seven days of Safari use without user interaction on the site. These are the script-writable storage forms affected (excluding some legacy website data types): — Indexed DB — LocalStorage — Media keys — SessionStorage — **Service Worker registrations and cache**"
3. **Home Screen web app 第一方域名豁免**（同 2 的博文，标题段 *A Note On Web Applications Added to the Home Screen*）：
   > "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer. **We do not expect the first-party in such a web application to have its website data deleted.**"
   WebKit 官方技术总览页同样写明（https://webkit.org/tracking-prevention/ ）：
   > "### Home Screen Web Application Domain Exempt From ITP — The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm."
   同页 *7-Day Cap on All Script-Writeable Storage* 列表同样含 "Service Worker registrations and cache"。
4. **豁免的前提条件**（WebKit bug 232302，状态 RESOLVED WONTFIX，Reported 2021-10-26，https://bugs.webkit.org/show_bug.cgi?id=232302 ）——报告人称 manifest `display` 设为 `minimal-ui`、即仍在 Safari 中打开，数据 7 天后被删；John Wilander（WebKit）回复：
   > "There is no way to get an exception in Safari. If you adjust your manifest to use either the "standalone" or "fullscreen" display mode, your home screen web application will open full-screen in Web.app and you will get the behavior you want."
5. Home Screen web app + SW 的**已知缺陷**（WebKit bug tracker）：
   - https://bugs.webkit.org/show_bug.cgi?id=225083 — *REGRESSION (iOS 14.5): PWA's / Home Screen Apps with Service Workers intermittenly fail to open offline*，Reported 2021-04-26，**RESOLVED FIXED**（r276845 / 237196@main）：
     > "On iOS/iPad OS 14.5 and 14.6 Beta, PWA/Home Screen Apps with Service Workers are intermittently failing to open when the iPad/iPhone is disconnected from the internet."
   - https://bugs.webkit.org/show_bug.cgi?id=190269 — *IOS 12 - Service worker cache not shared when added to homescreen*（2018-09）；WebKit 于评论中说明：
     > "This fix is included in iOS 12.1.1 and iOS 12.1.2, and most definitely iOS 12.1."
   - https://bugs.webkit.org/show_bug.cgi?id=252544 — *Initial ServiceWorkerWindowClient in a Home Screen web app launched to handle notificationclick handler is inert for a short period*，Reported 2023-02-20，状态 **NEW**：
     > "The "message" event callback will not triggered if the web app is not opened."（即通知点开后新开的 web app 客户端在短时间内收不到 SW 的 postMessage）
6. **版本号一处不一致（如实登记）**：BCD 中 `"ServiceWorkerRegistration": { "safari": { "version_added": "11.1" }, "safari_ios": "mirror" }`，把 iOS 也映成 11.1；而 Apple/WebKit 的官方口径是 **iOS 11.3**。两方口径并存，以 Apple/WebKit 原文为准（`safari_ios` 的编号体系问题）。

---

## 5. iOS 的 Web Push（`PushManager` / `showNotification`）

**结论（一句话）**：Web Push 自 **iOS / iPadOS 16.4** 起支持，且**仅限「已添加到主屏幕的 Web App」**（Safari 标签页里不行），且订阅需由**直接用户手势**触发；Apple 用同一套 APNs。

**证据**

1. WebKit 官方博客 *Web Push for Web Apps on iOS and iPadOS*，2023-02-16，https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ ：
   > "Now with iOS and iPadOS 16.4, we are adding support for Web Push to **Home Screen web apps**."
   > "A web app that has been added to the Home Screen can request permission to receive push notifications **as long as that request is in response to direct user interaction** — such as tapping on a 'subscribe' button provided by the web app."
   > "Web Push on iOS and iPadOS uses the same Apple Push Notification service that powers native push on all Apple devices. You do not need to be a member of the Apple Developer Program to use it."
2. MDN 文档级（BCD `api/ServiceWorkerRegistration.json`）：
   > `"pushManager": { "safari": { "notes": "Notifications are supported on macOS Ventura and later.", "version_added": "16" }, "safari_ios": { "notes": "Notifications are supported in web apps saved to the home screen.", "version_added": "16.4" } }`
   > `"showNotification": { "safari_ios": { "version_added": "16.4", "notes": "Notifications are supported in web apps saved to the home screen." } }`
   > `showNotification` 的选项参数在 Safari 全部为 false：`options_actions_parameter` / `options_badge_parameter` / `options_data_parameter` / `options_image_parameter` / `options_renotify_parameter` / `options_requireInteraction_parameter` / `options_vibrate_parameter` = `"safari": { "version_added": false }`。

---

# 块 II：Service Worker 更新策略与移动端录入

## 6. SW 更新语义与官方推荐做法

**结论（一句话）**：`skipWaiting()` 的规范/MDN 语义是「强制让 waiting 的 SW 立即变成 active」；**Chrome 系官方文档明确警告**在安装阶段无条件 `skipWaiting()`「可能是个坏主意」，会让旧页面在新 SW 接管后混用版本、破坏懒加载子资源；官方推荐的更新提示模式是 `workbox-window` 监听 `waiting` 事件 → 用户确认 → `messageSkipWaiting()` → 监听 `controlling` → reload。

**证据**

1. MDN（文档级）`skipWaiting()`，https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting ：
   > "The **`skipWaiting()`** method of the `ServiceWorkerGlobalScope` interface **forces the waiting service worker to become the active service worker.**"
   > "While `self.skipWaiting()` can be called at any point during the service worker's execution, it will only have an effect if there's a newly installed service worker that might otherwise remain in the `waiting` state."
2. 规范侧（Service Workers Nightly / Editor's Draft，https://w3c.github.io/ServiceWorker/ ，抓取时页面标注 *Editor's Draft, 2026-08-12*）：
   > "A service worker has an associated **skip waiting flag**. Unless stated otherwise it is unset."
   > "The skip waiting flag of a service worker causes activation of the service worker registration to occur while service worker clients are using the service worker registration, `navigator.serviceWorker.controller` immediately reflects the active worker…"
   （方法体的逐字步骤段在抓取中被截断，未能取得；见「未证实」。）
3. **Chrome 系官方警告**（Workbox 官方文档 *A service worker's life* → Handling service worker updates → Installation，https://developer.chrome.com/docs/workbox/service-worker-lifecycle ，镜像可用地址 https://developer.chrome.google.cn/docs/workbox/service-worker-lifecycle?hl=en ）：
   > "**Tip: You can speed up activation of updated service workers by calling `self.skipWaiting`, but this may be a bad idea. The old service worker may have handled fetches during page startup, but the new service worker then takes control later on. This can break stuff like lazily-loaded subresources until the next navigation request.**"
   > "One thing to note is that an updated service worker gets installed alongside the previous one. This means the old service worker is still in control of any open pages, and following installation, the new one enters a waiting state until it's activated."
4. **官方推荐模式**（Workbox *Handling service worker updates with immediacy*，https://developer.chrome.com/docs/workbox/handling-service-worker-updates ，镜像 https://developer.chrome.google.cn/docs/workbox/handling-service-worker-updates?hl=en ）：
   > "…you may want to give the user a heads up that there's a pending service worker update, and then automate the process of switching over to the new service worker."
   > `wb.addEventListener('waiting', (event) => { showSkipWaitingPrompt(event); });` … `if (updateAccepted) { wb.messageSkipWaiting(); }` … `wb.addEventListener('controlling', () => { window.location.reload(); });`
   > "If they accept, `messageSkipWaiting()` tells the waiting service worker to invoke `self.skipWaiting()`, meaning it will begin to activate."
   > 何时**必须**给提示："If you're serving precached HTML. In this case, you should *strongly* consider offering a reload button on service worker updates, since updates to that HTML won't be recognized until the updated service worker takes control."
   > `generateSW` 的 `skipWaiting` 选项默认值为 `false`："…you have its `skipWaiting` option set to `false` (the default)"。
5. `clients.claim()` 的语义与风险，MDN 文档级，https://developer.mozilla.org/en-US/docs/Web/API/Clients/claim ：
   > "**`claim()`** … allows an active service worker to set itself as the `controller` for all clients within its `scope`. This triggers a `controllerchange` event…"
   > "When a service worker is initially registered, pages won't use it until they next load. The `claim()` method causes those pages to be controlled immediately. **Be aware that this results in your service worker controlling pages that loaded regularly over the network, or possibly via a different service worker.**"

---

## 7. Workbox 官方能力

**结论（一句话）**：Workbox 是 Chrome 团队官方维护的 SW 工具库，文档托管在 developer.chrome.com/docs/workbox；`workbox-precaching` 用 precache manifest 里每个 URL 的 `revision`（构建期生成的**内容哈希**）判断「同 URL 内容是否变了」，官方**明确警告**不要手写 revision；`workbox-window` 提供 `waiting` / `controlling` 事件与 `messageSkipWaiting()` 来完成「提示后更新」流程。

**证据**

1. 官方定位（Chrome 系官方，https://developer.chrome.com/docs/workbox/what-is-workbox ，镜像 https://developer.chrome.google.cn/docs/workbox/what-is-workbox?hl=en ）：
   > "Workbox is a set of modules that simplify common service worker routing and caching. Each module available addresses a specific aspect of service worker development."
   文档入口（仍在 Chrome for Developers 官方域名下、并链接官方 GitHub）：https://developer.chrome.com/docs/workbox/ → "Workbox on GitHub — File issues, read release notes, and browse the source code."
2. **revision 机制原文**（Chrome 系官方，https://developer.chrome.com/docs/workbox/modules/workbox-precaching ，镜像 https://developer.chrome.google.cn/docs/workbox/modules/workbox-precaching?hl=en ）：
   > "URLs that already include versioning information (like a content hash) are used as cache keys without any further modification. **URLs that don't include versioning information have an extra URL query parameter appended to their cache key representing a hash of their content that Workbox generates at build time.**"
   > "…`workbox-precaching` will look at the new list and determine which assets are completely new and which of the existing assets need updating, **based on their revisioning**. Any new assets, or updating revisions, will be added to the cache during the new service worker's `install` event."
   > "`workbox-precaching` expects an array of objects with a `url` and `revision` property. This array is sometimes referred to as a **precache manifest**…"
   > "The first object (`/index.html`) explicitly sets a revision property, **which is an auto-generated hash of the file's contents.** … By passing a revision property to `precacheAndRoute()`, **Workbox can know when the file has changed and update it accordingly.**"
   > "**Warning:** It's strongly recommended that you use one of Workbox's build tools to generate this precache manifest. **Never hardcode revision info into a "hand written" manifest, as precached URLs will not be kept up to date unless the revision info reflects the URL's contents!**"
   > 预缓存路由的默认策略："The response strategy used in this route is cache-first…"
3. `workbox-window` 的更新流程（Chrome 系官方，https://developer.chrome.com/docs/workbox/using-workbox-window ）：
   > "The goals of this module are: To simplify service worker registration and updates by helping developers identify critical moments of the service worker lifecycle… To prevent developers from making common mistakes, such as registering a service worker in the wrong scope."
   > "That recipe relies on a special helper method for `self.skipWaiting` called `messageSkipWaiting`, which sends a message with a `type` value of `SKIP_WAITING`."
4. `workbox-window` 还负责等 `load` 再注册（同 3）：
   > "`Workbox.register` takes care of waiting until the `window` `load` event before registering the service worker. This is desirable in situations where precaching is involved so bandwidth contention that may delay page startup can be avoided."
   （注：票面提到的 `registerRoute` 属于 `workbox-routing` 模块，与 precache manifest 的 `revision` 是两件事；Workbox 官方把 `registerRoute()` 描述为"request matching"，见 what-is-workbox 页。）

**未找到**：官方文档中**没有**给出「Workbox 当前版本号」或一句「长期支持/LTS」承诺的逐字表述；只能确认文档仍在 developer.chrome.com 官方域名下并持续更新（页面出现 CDN 引用 `workbox-window.prod.mjs` 6.4.1 / 6.2.0 等版本号，可作版本线索，但不是版本声明）。

---

## 8. `beforeinstallprompt` 在 Safari，以及 iOS 的官方安装路径

**结论（一句话）**：Safari（含 iOS Safari）**完全不支持** `beforeinstallprompt` / `BeforeInstallPromptEvent`（MDN 数据为 `false`，且该特性**非标准**）；iOS 上的官方安装方式是 **共享 → 添加到主屏幕**（Apple 官方用户手册）；**iOS 26 起「添加到主屏幕默认以 web app 打开」**已由 WebKit 官方博客写明，且用户可关掉该开关退回书签。

**证据**

1. MDN 文档级（BCD `api/BeforeInstallPromptEvent.json`，https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/BeforeInstallPromptEvent.json ）：
   > `"support": { "chrome": { "version_added": "44" }, "firefox": { "version_added": false }, "safari": { "version_added": false }, "safari_ios": "mirror" }`
   > `"status": { "experimental": true, "standard_track": false, "deprecated": false }`
   （`prompt` / `userChoice` / `platforms` 在 Safari 同样为 `false`。）
2. MDN 页面抬头（文档级，https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent ）：
   > "**Non-standard:** This feature is not standardized. We do not recommend using non-standard features in production, as they have limited browser support, and may change or be removed."
3. iOS 官方安装路径（Apple 官方用户手册，https://support.apple.com/en-us/guide/iphone/iphea86e5236/ios ；抓取时被重定向到 zh-cn 本地化版本，URL 结构同上）：
   > 原文（zh-cn 本地化）："在 iPhone 上前往 Safari 浏览器 App。前往网站。轻点…，然后轻点"共享"。…向下滚动选项列表，然后轻点"添加到主屏幕"。…打开"作为网页 App 打开"。轻点"添加"。"
   > "网页 App 的图标会添加到主屏幕。轻点图标时，该网站会像 App 一样打开。你可以接收网页 App 的通知并像退出任何 App 一样退出网页 App。"
   （该页为 iOS 26 版用户指南 `.../iphea86e5236/26/ios/26`，含 "Open as Web App" 开关，与 iOS 26 行为一致。）
4. iOS 26 起默认以 web app 打开（WebKit 官方博客 *WebKit Features in Safari 26.0*，2025-09-15，https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ ，小节 *Every site can be a web app on iOS and iPadOS*）：
   > "Now, we are revising the behavior on iOS 26 and iPadOS 26. **By default, every website added to the Home Screen opens as a web app.** If the user prefers to add a bookmark for their browser, they can disable "Open as Web App" when adding to Home Screen — even if the site is configured to be a web app."
   > "Giving users a web app experience simply no longer *requires* a manifest file. It's similar to how Home Screen web apps on iOS and iPadOS never required Service Workers … yet including Service Workers in your code can greatly enhance the user experience."

---

## 9. 移动端金额输入的键盘控制

**结论（一句话）**：`inputmode` 在 **Safari 12.1 / iOS Safari 12.2** 起支持（MDN 数据），规范原文对 `decimal` 的定义是「能输入小数、显示本地化数字键与**格式分隔符**」；`<input type="number">` 有 MDN 明列的坑（**不支持 `pattern`**、默认 `step=1` 导致小数被判非法、隐式 role 是 `spinbutton`，官方建议改用 `inputmode="numeric"` + `pattern`）；iOS 上确有 WebKit bug 记录的**小数分隔符与键盘不一致**问题。

**证据**

1. `inputmode` 支持版本（MDN 文档级，BCD `html/global_attributes.json`，https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/global_attributes.json ）：
   > `"inputmode": { "support": { "safari": { "version_added": "12.1" }, "safari_ios": { "version_added": "12.2", "notes": "Before iOS 13, `inputmode=\"none\"` had no effect." }, "chrome": { "version_added": "66" }, "firefox": { "version_added": "95" } } }`
2. **WHATWG HTML 规范原文**（Living Standard，页面标注 *Last Updated 15 September 2026*，https://html.spec.whatwg.org/multipage/interaction.html#input-modalities:-the-inputmode-attribute ）：
   > "The `inputmode` content attribute is an enumerated attribute that specifies what kind of input mechanism would be most helpful for users entering content."
   > `numeric` — "The user agent should display a virtual keyboard capable of numeric input. This keyword is useful for PIN entry."
   > `decimal` — "**The user agent should display a virtual keyboard capable of fractional numeric input. Numeric keys and the format separator for the locale should be shown.**"
   > `none` — "The user agent should not display a virtual keyboard."；`text` — "The user agent should display a virtual keyboard capable of text input in the user's locale."
3. MDN 的行为描述（文档级，https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode ）：
   > `decimal` — "Fractional numeric input keyboard containing the digits and decimal separator for the user's locale (typically `.` or `,`). **Devices may or may not show a minus key (`-`).**"
   > `numeric` — "Numeric input keyboard, but only requires the digits 0–9. Devices may or may not show a minus key."
   > "It's important to understand that the `inputmode` attribute **doesn't cause any validity requirements to be enforced on input.**"
4. `type=number` 的已知问题（MDN 文档级，https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number ）：
   > "**`<input type="number">` elements do not support use of the `pattern` attribute** for making entered values conform to a specific regex pattern."
   > "One issue with number inputs is that their **step size is 1 by default**. If you try to enter a number with a decimal value that's not a whole number (such as "1.1"), it will be considered invalid. … If you want to allow arbitrary decimal values, you can set the `step` value to `"any"`."
   > "The implicit role for the `<input type="number">` element is `spinbutton`. If spinbutton is not an important feature for your form control, **consider *not* using `type="number"`. Instead, use `inputmode="numeric"` along with a `pattern` attribute** that limits the characters to numbers and associated characters. With `<input type="number">`, there is a risk of users accidentally incrementing a number when they're trying to do something else."
   > "**Warning:** Logically, you should not be able to enter characters inside a number input other than numbers. Some browsers allow invalid characters, others do not…"
5. 规范侧对 number 可输入字符的间接依据（WHATWG HTML，https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#valid-floating-point-number ）：
   > "A string is a **valid floating-point number** if it consists of: 1. Optionally, a U+002D HYPHEN-MINUS character (-). 2. One or both of the following… 3. Either a U+0065 LATIN SMALL LETTER E character (e) or a U+0045 LATIN CAPITAL LETTER E character (E)."
   > "The Infinity and Not-a-Number (NaN) values are not valid floating-point numbers."
   （即 `-`、`e`/`E`、`+`（E 后的符号）在语法上被允许，与「移动端 `type=number` 可能敲出 e/+/-」的说法一致。）
6. **iOS 上输入法键与输入值不一致的 WebKit bug**（一手：bug tracker）：
   - https://bugs.webkit.org/show_bug.cgi?id=247242 — 标题 *Locale inconsistency in `inputmode="decimal"` and `input type="number"`*，Reported **2022-10-30**，状态 **NEW**：
     > "iPhone decimal keyboard does not always match with the decimal separator used in number input."
     > "…have iPhone region set to location that uses comma as decimal separator (for example Estonia) … Safari displays the input as "1,99". — try to edit the field — **Decimal keyboard has "." instead of ",".**"
   - https://bugs.webkit.org/show_bug.cgi?id=197916 — 标题 *`inputmode="numeric"` should show a number pad with digits 0-9, instead of the numeric keyplane*，Reported 2019-05-15，**RESOLVED FIXED**（补丁 r245338 后 `inputmode="numeric"` 显示 0–9 数字键盘）。
   - https://bugs.webkit.org/show_bug.cgi?id=200226 — *Wrong keyboard for `inputmode=numeric"`*，Reported 2019-07-29，**RESOLVED DUPLICATE** of 197916；报告原文指出 iOS 侧行为差异：
     > "But in iOS Safari, "numeric" creates a keyboard with more keys instead of fewer. …（作者因此被迫用 decimal）… this is assuming I don't care about **the negative key missing from decimal, which is another bug**."

**未找到（重要）**：**没有任何一手来源说「iOS Safari 不支持 `inputmode="decimal"`」**——MDN 数据显示 Safari 12.1 / iOS 12.2 起支持，WebKit bug 247242 的表述也是「键盘分隔符与输入框分隔符不一致」而非「被忽略/降级为普通键盘」。票面里「iOS 上不显示小数点」的说法只能追溯到二手来源（如 php.cn 的教程文章，已排除），**不作为结论**。

---

# 对离线策略的直接影响

1. **【事实】** Safari 不支持 `ServiceWorkerRegistration.sync` / `SyncManager`，也不支持 `periodicSync`（MDN 数据均为 `false`；WebKit bug 182565 至今 NEW）。⇒ 离线写入队列**不能**依赖 Background Sync 在后台自动重放，只能在「前台时机」（页面可见、`online` 事件、`visibilitychange`→visible、用户操作后）重放。
2. **【事实】** ITP 的「7 天无交互即清除」明确包含 **Service Worker registrations and cache**；但 **Home Screen web app 的第一方域名被明文豁免**，且该豁免在 WebKit bug 232302 中被确认**要求 manifest `display` 为 `standalone`（或 `fullscreen`）**。⇒ manifest 必须写 `display: "standalone"`；若写 `minimal-ui` / 不写，数据仍会被清。
3. **【事实】** 单 origin 配额是「≤60% 磁盘」这种**动态百分比**，且官方明确 "quota might change based on factors like existing usage and site visit frequency"，且 "there is no guarantee that a site can store that much"。⇒ 任何写存储的代码都必须处理 `QuotaExceededError`，不能假设「够用」。
4. **【事实】** `persist()` 在 Safari 15.2+ 可用、不弹框、按启发式自动批准/拒绝；官方只说启发式**包含**「是否作为 Home Screen Web App 打开」。⇒ 可以在启动时调 `persist()` 并记录 `persisted()` 结果**用于观测**，但**不能**把它当作「离线数据一定安全」的保证。**【推断】** 就本项目（2 人自用、每次记账都开同一 Home Screen web app）而言，`persisted()` 大概率返回 true，但这是推断，未见官方承诺。
5. **【事实】** `skipWaiting()` 无条件在 install 阶段调用被 Chrome 系官方文档定性为 "may be a bad idea"（新旧 SW 混用会破坏懒加载子资源）。⇒ 采用官方推荐的 `workbox-window` `waiting` → 提示 → `messageSkipWaiting()` → `controlling` → reload 流程；不要 `self.skipWaiting()` + `clients.claim()` 一把梭。**【推断】** 本项目是 SPA 且离线优先，属于官方说的「serving precached HTML」场景，官方建议 "strongly consider offering a reload button"。
6. **【事实】** 对同一 URL（尤其 `index.html`、以及 `/api/*` 之外的入口）的内容变更检测，Workbox 靠 precache manifest 的 `revision` 内容哈希；官方警告不要手写 revision。⇒ 用 `vite-plugin-pwa` / `workbox-build` 走构建期生成，绝不在 manifest 里硬编码 revision。
7. **【事实】** `navigator.storage.estimate().usageDetails` 在 Safari 为 `false`（不可用）；`inputmode` 的 `decimal` 在 iOS 上存在 WebKit 未修的 bug 247242（键盘分隔符与输入值分隔符不一致）。⇒ 金额输入不要依赖 `type=number`（`pattern` 被忽略、`step` 默认 1、隐式 role 是 spinbutton），用 `type="text"` + `inputmode="decimal"` + 自己的解析/校验；**【推断】** 同时要做「`,`/`.` 双分隔符容错」以绕过 247242。
8. **【事实】** iOS 上 `beforeinstallprompt` 不存在（`safari: false`，且非标准）；官方引导路径只有「共享 → 添加到主屏幕」；iOS 26 起默认即按 web app 打开。⇒ 不要写任何 `beforeinstallprompt` 处理逻辑；引导安装只能靠 Apple 官方路径的图文说明，而 iOS 26+ 用户基本不需要额外开关操作。

---

# 未证实 / 未找到一手来源

1. **「已添加到主屏幕的 web app 自动获得持久化存储」**：**未找到**任何官方表述。最接近的是 WebKit 博客「WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App」——只是**启发式因素之一**，不是自动授予。
2. **`persist()` 在 Home Screen web app 中的具体返回值**、以及在 iOS 上 `persisted()` 是否可能长期为 `false`：**未找到**官方说明或 WebKit 源码级证据（尝试抓取 `WebKit/WebKit` 仓库中 StorageManager 源码路径返回 404，未能定位到实现文件）。
3. **WebKit 对 Background Sync 的实现计划**：**未找到**。bug 182565 状态仍为 NEW，无排期、无实现分支、无发布说明。仅有 2019 年 WebKit 人员一句顾虑（"Exposing it without an install action would be worrisome."）。
4. **Service Worker 规范中 `skipWaiting()` 方法体的逐字步骤文本**：抓取 https://w3c.github.io/ServiceWorker/ 时在 §3.6 附近被截断，**未取得** §4.1.4 的方法定义正文。已取得的是「skip waiting flag」相关原文（见 §6.2）。
5. **WHATWG HTML 规范中 number 状态「for authors」的散文段**（含 "The type=number state is not appropriate for input that happens to only consist of numbers…" 以及同段对 `inputmode` 的建议）：**未取得逐字原文**（多页版 `input.html` 抓取时该小节被折叠/截断）。该点已改用 MDN 文档级原文（§9.4）——MDN 同义表述为 "The `number` input type should only be used for incremental numbers… The `number` input type is not appropriate for values that happen to only consist of numbers but aren't strictly speaking a number, such as postal codes in many countries or credit card numbers."
6. **「`<input type="number">` 无法控制千分位」**：**未找到**一手原文明确这么说。只能引 MDN 的相邻事实（`pattern` 不支持、`step` 默认 1、隐式 role `spinbutton`）。
7. **「iOS Safari 不支持 `inputmode="decimal"` / 不弹小数点键盘」**：**未找到**一手来源；相反，MDN/BCD 说 Safari 12.1 / iOS 12.2 起支持，WebKit bug 247242 描述的是「分隔符不一致」。票面该说法疑似源自二手教程，**不采信**。
8. **`ServiceWorkerRegistration.safari_ios` 版本号不一致**：BCD 为 `"mirror"`（等价 11.1），Apple/WebKit 官方口径为 iOS 11.3。两方口径均已保留；本文以 Apple/WebKit 原文为准，但**该冲突本身未获裁决**。
9. **Workbox 官方文档中「当前版本号」与「是否长期维护」的逐字声明**：**未找到**。只能确认文档仍托管在 developer.chrome.com 官方域名、并在文中引用 `workbox-window` 6.4.1 / 6.2.0 等 CDN 版本，以及 what-is-workbox 页面链接到官方 GitHub。
10. **取证工具限制导致的缺口**：`developer.chrome.com` 直连抓取失败，本次 Workbox 引文均取自官方镜像 `developer.chrome.google.cn`（同源文档）；MDN 兼容表取自 `mdn/browser-compat-data`（MDN 渲染该表的上游数据）。两处均非「二手转述」，但**抓取路径与票面指定的主域名不同**，特此登记。
