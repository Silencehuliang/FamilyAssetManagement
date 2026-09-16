# T9 浏览器侧一手事实：iOS PWA 会话持久性 & Passkey 可行性

> 产出票：#9 «鉴权与访问控制方案»（本报告是其证据链的一手部分）

- **调研时间**：2026-09-16（本文所有 URL 的采集日期均为 **2026-09-16**）
- **范围**：Cloudflare Pages 上的 React SPA，iOS Safari「添加到主屏幕」PWA 独立窗口，同域 `/api/*`，HttpOnly Cookie 承载不透明会话 token；2 人自用、公网可见
- **允许的来源等级**：Apple 官方文档 / WebKit 博客与 bug tracker / W3C·IETF 规范 / MDN（标注为「文档级」）/ iCloud 用户指南 / 依赖库与平台的官方 README·CHANGELOG·docs
- **排除**：二手博客、知乎/掘金、StackOverflow 高赞。二手内容只在「线索」位置提及，不计入结论
- **标注约定**：`事实` = 附有一手原文引用；`推断` = 我的推理，已显式标注
- **未找到一手来源的项**：集中在文末「未证实 / 未找到」一节，未用推测填充

---

## 任务 A：iOS PWA 下的 Cookie 与会话持久性

### A1 存储容器：Home Screen web app 与 Safari 是否共享网站数据

**结论：不共享。** iOS 上「添加到主屏幕」且以 standalone 启动的站点，其 cookie / localStorage / IndexedDB 与 Safari **是彼此隔离的两套容器**；在 Safari 里登录过，从主屏幕图标启动**不会**处于登录态（必须在 web app 内再登录一次）。`事实`

证据：

1. **WebKit 官方常青文档 Tracking Prevention in WebKit**，章节 "Home Screen Web Application Domain Exempt From ITP"：
   > "The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm. In addition, **the website data of home screen web applications is kept isolated from Safari** and thus will not be affected by ITP's classification of tracking behavior in Safari."
   URL: https://webkit.org/tracking-prevention/ ｜采集 2026-09-16

2. **WebKit bug tracker 明确称为「by design」**（bug 181849，"Add to homescreen" apps don't share storage with Safari）：
   > "The current behavior (on Apple platforms) is by design. **Home Screen apps are created as isolated entities without shared state with the browser.**"
   — Comment 3，2022-02-01 15:33:01 PST
   URL: https://bugs.webkit.org/show_bug.cgi?id=181849 ｜采集 2026-09-16
   （同一 bug 的 Comment 1 提到历史上唯一可用的 hack 是把会话数据塞进 `window.location.query`；属 bug tracker 中的开发者评论，不是官方支持的手段）

3. **Apple 官方 WWDC23 session「What's new in web apps」(10120)**，区分 iOS 与 Mac：
   > "**Home Screen web apps have a standalone, app-like experience on iOS, with separate cookies and storage from the browser.**"
   > "As I mentioned earlier, **to make web apps work great out of the box for most users, we copy website cookies when a web app on Mac is added to the Dock.** … From that point on, cookies are separate between Safari and the web app."
   > "**If the user logs into your web page in their default browser, they will not be logged into the web app that has already been added to the Dock, since cookies and storage are separate after the web app is added.**"
   URL: https://developer.apple.com/videos/play/wwdc2023/10120/ ｜采集 2026-09-16
   → 注意：「创建时把 Safari 的 cookie 复制进 web app」这条官方只对 **Mac（Add to Dock）** 说明；对 iOS 只说明「separate cookies and storage」，**未找到**任一处 Apple 文档声称 iOS 上有同类复制。

4. **iOS 26 起隔离成为默认形态**（WebKit 官方博客 "News from WWDC25: WebKit in Safari 26 beta"）：
   > "Now, we are bringing this new behavior to iOS and iPadOS. **By default, every website added to the Home Screen opens as a web app.** If the user prefers to add a bookmark that opens in their default browser, they can turn off 'Open as Web App', even if the site is configured to be a web app."
   URL: https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ ｜采集 2026-09-16
   → 即：原来「无 manifest 的收藏夹会走 Safari、从而共享 cookie」这条退路在 iOS 26+ 默认关闭。
   （Mac 侧同源说明：https://support.apple.com/104996 — "A web app functions independently of Safari. It shares no browsing history, cookies, website data or settings"）

### A2 ITP 的 7 天规则适用范围

**结论：7 天上限只作用于「脚本可写存储」，即 `document.cookie` 写出的 cookie + IndexedDB / LocalStorage / SessionStorage / Media keys / Service Worker 注册与缓存；由 HTTP 响应头 `Set-Cookie` 设置的第一方 cookie 不在其中，WebKit 工程师明确答复「会被遵守」。** `事实`

证据：

1. **WebKit 博客 ITP 2.1（ITP 首次引入该限制）**：
   > "With ITP 2.1, **all persistent client-side cookies, i.e. persistent cookies created through `document.cookie`, are capped to a seven day expiry.**"
   > "Implementation Details — **Only cookies created through `document.cookie` are affected by this change.**"
   > "Will This Change Log Users Out? — Authentication cookies should be Secure and HttpOnly to protect them against man-in-the-middle attacks, cross-site scripting attacks, and speculative execution attacks. **Cookies created through `document.cookie` cannot be HttpOnly which means authentication cookies should not be affected by the lifetime cap. If they are, you need to set your authentication cookies in an HTTP response and mark them Secure and HttpOnly.**"
   URL: https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/ ｜采集 2026-09-16

2. **WebKit 博客 "Full Third-Party Cookie Blocking and More"（2020-03-24）**，7 天上限扩展到其余脚本可写存储：
   > "Now ITP has aligned the remaining script-writable storage forms with the existing client-side cookie restriction, deleting all of a website's script-writable storage after seven days of Safari use without user interaction on the site. These are the script-writable storage forms affected (excluding some legacy website data types): Indexed DB / LocalStorage / Media keys / SessionStorage / Service Worker registrations and cache"
   > "**A Note On Web Applications Added to the Home Screen** … Web applications added to the home screen are not part of Safari and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer. **We do not expect the first-party in such a web application to have its website data deleted.**"
   URL: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ｜采集 2026-09-16

3. **WebKit 常青文档的当前措辞**：
   > "7-Day Cap on All Script-Writeable Storage — Trackers executing script in the first-party context often make use of first-party storage to save and recall cross-site tracking information. Therefore, **ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website.** The latter storage forms are: IndexedDB / LocalStorage / Media keys / SessionStorage / Service Worker registrations and cache"
   URL: https://webkit.org/tracking-prevention/ ｜采集 2026-09-16

4. **WebKit bug 237350（Web App Added to Home Screen Cookies Deleted After 7 Days）——直接对应本项目形态的问答**。John Wilander（WebKit 工程师）：
   > Comment 1（2022-03-02 10:21:23 PST）: "**The only things that should be capped to 7 days for the main domain of Home Screen web apps are: - Cookies created in JavaScript. - Cookies created in 3rd-party CNAME-cloaked HTTP responses. Non CNAME-cloaked server-set cookies and HTML storage should not be deleted for the main domain of Home Screen web apps.**"
   > Comment 4（2022-03-02 14:46:39 PST）: "It doesn't since it's not ITP actively deleting the cookie but rather **a policy that all script-written cookies are capped to a max 7-day expiry**. It's the expiry mechanism of cookies."
   > Comment 7（2022-03-08 19:29:50 PST），回答「服务端下发 HttpOnly、expiry 设 28 天会不会被遵守」: "**Yes.**" … "**In shipping software, there's no cap on the expiry of server-set first-party cookies.** However, browsers have reached consensus on a ~400-day expiry cap on all cookies. … None of those caps are shipping though."
   URL: https://bugs.webkit.org/show_bug.cgi?id=237350 ｜采集 2026-09-16

5. **Home Screen web app 的第一方域名被显式豁免**（WebKit 博客 "CNAME Cloaking and Bounce Tracking Defense"，2020-11-12）：
   > "Home Screen Web Application Domain Exempt From ITP — … we have implemented **an explicit exception for the first-party domain of home screen web applications to make sure ITP always skips that domain in its website data removal algorithm.** In addition, the website data of home screen web applications is kept isolated from Safari…"
   URL: https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/ ｜采集 2026-09-16

### A3 PWA 独立窗口 fetch 是否携带同域 Cookie / 已知缺陷

**结论：没有找到任何 Apple/WebKit 官方说明把 Home Screen web app 当作第三方上下文；反过来，WebKit bug tracker 中记录了「cookie 会被带上、但偶发携带**过期值**」的缺陷（iOS 17.x 起，状态仍为 NEW）。** `事实`（对「未被当第三方」这一否定结论，属「已检索但未找到相反说明」）

证据：

1. **WebKit bug 272325 "REGRESSION (iOS 17.x): Session cookies being reset randomly in a Home Screen web app"**。报告者（商用低代码平台）原文：
   > "The observed issue is that after the login, having already three session cookies, we suddenly detect that the 'Cookie' header contains values different than the ones set after the login. … **Note that `document.cookie` has the expected cookie values.** … So, only some underlying iOS mechanism could be switching valid session cookies by others which were set several requests back."
   > "We can replicate the issue on a PWA installed on iPad 17.4.1 with the default browser Safari … After close/reopen the PWA, we confirm that session cookies A and B are automatically reset to the persistent default ones."
   同期 WebKit 工程师 Alexey Proskuryakov 参与复现（在 iOS 17.5 beta 上未能复现，但复现者称在 iOS 18.1 仍遇到）。
   **Status: NEW**（Resolution 字段为空，未见 "Fixed in"）｜Reported 2024-04-08
   URL: https://bugs.webkit.org/show_bug.cgi?id=272325 ｜采集 2026-09-16
   → 该记录同时正面证明了：**PWA 独立窗口的请求是会携带同域 HttpOnly 会话 cookie 的**（否则不会出现「携带了旧值」这一现象）。

2. **WebKit bug 255524 "REGRESSION (Safari 16.4): Safari sometimes doesn't send cookies for assets requests and javascript fetch requests"**：Safari 在 `<script>` 资源请求与 `fetch()` 请求上偶发不带 `SameSite=Lax` 会话 cookie，服务端因此重发 `Set-Cookie`，导致会话丢失；复现环境含 iPadOS 16.4/16.4.1；**Status: RESOLVED CONFIGURATION CHANGED**，但报告线程中直到 Safari 16.6 / STP 174 仍有人反馈。
   URL: https://bugs.webkit.org/show_bug.cgi?id=255524 ｜采集 2026-09-16

3. **反例（官方口径）**：WebKit bug 280630（[iOS] `navigator.credentials.get` fails on newly-opened tab in non-Safari browsers，RESOLVED WONTFIX）中 Apple 工程师 pascoe@apple.com 说明的是 WKWebView `document.hasFocus()` 的前提问题，**不涉及** Home Screen web app 被当第三方。

### A4 `SameSite` 在 iOS PWA 下的行为

**结论：未找到任何一手来源说明 `SameSite` 在 Home Screen web app 独立窗口中有独立于 Safari 的语义差异；PWA 专属的 SameSite 异常记录为「无」。但 Safari 侧存在已记录的 Lax 丢失缺陷（含经由 Service Worker fetch handler 的一类，已于 iOS 15.4 修复）。** `事实`

证据：

1. **语义（文档级，MDN "Set-Cookie" → SameSite）**：
   > "`Lax` Send the cookie only for requests originating from the same site that set the cookie, and for cross-site requests that meet both of the following criteria: The request is a top-level navigation … **This would exclude, for example, requests made using the `fetch()` API, or requests for subresources from `<img>` or `<script>` elements**, or navigations inside `<iframe>` elements. … The request uses a safe method: in particular, this excludes `POST`, `PUT`, and `DELETE`."
   URL: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie ｜采集 2026-09-16（标注：文档级）
   → 对本项目：同域 `/api/*` 的 `fetch` 属 same-site，Lax 不影响它；Lax 影响的是**从外部站点的跳转进入**（首次导航）。而 PWA 独立窗口的 start_url 加载发生在 app 启动时，属 top-level navigation。

2. **Safari 的 Lax 缺陷（一手：WebKit bug tracker）**：
   - bug 226386 "Requests sent by Safari lack SameSite=Lax cookies when a service worker with a fetch event handler is involved"（Reported 2021-05-28，由 John Wilander 拆分自 219650）：报告者用服务端日志（非 DevTools 假象）确认 cookie 确实未发送；Youenn Fablet 提交并落地修复：
     > "Committed r286656 (244969@main) … **This change should be present in STP 139, iOS 15.4 Beta, and macOS 12.3 Beta.**"
     URL: https://bugs.webkit.org/show_bug.cgi?id=226386 ｜采集 2026-09-16
   - bug 219650 "Cookies set with SameSite=Lax are not sent during redirects in Safari"，**RESOLVED CONFIGURATION CHANGED**（John Wilander 尝试复现未成功，并指出 popup/`window.open()` 是导航特例）。
     URL: https://bugs.webkit.org/show_bug.cgi?id=219650 ｜采集 2026-09-16
   - bug 255524（见 A3）：Lax + `fetch`/资源请求偶发丢失；线程中多次出现「去掉 SameSite 属性」或「改成 None」的规避报告（**属报告者经验，非官方建议**）。
3. **未找到**：任何 WebKit bug / 博客 / Apple 文档指认「standalone 模式下 SameSite 判定与 Safari 不同」。

### A5 `Set-Cookie` 的持久性上限

**结论：第一方、非 CNAME/IP 伪装的服务端 cookie 没有 ITP 施加的寿命上限；实际天花板是规范/浏览器共识的 ~400 天上限，WebKit 官方邮件确认 「Apple WebKit 和 CFNetwork 支持 400 天 max-age 上限」。因此 30 天 `Max-Age` 会被遵守。** `事实`（「30 天会被遵守」另有 A2 第 4 条的 WebKit 工程师直接答复）

证据：

1. **WebKit 工程师在 webkit-dev 邮件列表的官方立场（2022-01-25，John Wilander）**：
   > "**Apple WebKit and CFNetwork (HTTP stack for Apple ports of WebKit) support a 400-day max-age upper limit with some caveats.** We think there should always be a limit (your case 1), that user agents should be free to use a lower or a higher limit, and that 400 days is a good recommended limit to put in the spec (your case 2 but softer)."
   URL: http://mail-archive.com/webkit-dev@lists.webkit.org/msg30402.html ｜采集 2026-09-16（说明：这是 webkit-dev 公开邮件列表正文的存档镜像页；lists.webkit.org 对应页面本次访问返回 403，故引用此镜像）
   （旁证：Google Chrome 的 chromestatus 条目把该提案的立场记为 "Safari: Positive"：https://chromestatuslite.com/feature/4887741241229312 ｜第三方记录，仅作旁证）

2. **IETF 规范文本（draft-ietf-httpbis-rfc6265bis）**：
   > "The user agent MUST limit the maximum value of the `Max-Age` attribute. The limit SHOULD NOT be greater than 400 days (34560000 seconds) in duration. The RECOMMENDED limit is 400 days in duration, but the user agent MAY adjust the limit (see Section 7.2). **Max-Age attributes that are greater than the limit MUST be reduced to the limit.**"
   URL: https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-10.txt ｜采集 2026-09-16

3. **例外（会让服务端 cookie 也被压到 7 天）** — WebKit 常青文档：
   > "CNAME and Third-Party IP Address Cloaking Defense — **ITP detects third-party CNAME cloaking and third-party IP address cloaking requests and caps the expiry of any cookies set in the HTTP response to 7 days.**"
   URL: https://webkit.org/tracking-prevention/ ｜采集 2026-09-16
   → 对本项目：`/api/*` 与页面同域、由 Cloudflare 同一侧响应，不属该情形（`推断`，但「同域/同 IP」为其定义所需反例）。

---

## 任务 B：Passkey / WebAuthn 在 iOS PWA + Cloudflare Workers 的可行性

### B6 iOS PWA 独立窗口里的 WebAuthn

**结论：可以调用（有 WebKit bug tracker 记录为证，报告者在 Home Screen web app 内完成注册并触发 Face ID），但「从哪个 iOS 版本起官方支持」未找到 Apple/WebKit 的明确声明；同时有多个未修复的 PWA 相关 WebAuthn 缺陷。** `事实`（版本下限 → 未找到一手来源）

证据：

1. **WebKit bug 291258 "WebAuthn authentication prompt appears in a different web app after navigation"**（Reported 2025-04-08，OS: iOS 18，**Status: NEW**）：
   > "Environment: Platform: iOS (tested via Home Screen installed Web App) … Affected API: `navigator.credentials.get` (WebAuthn)"
   > "Steps to reproduce: Install the demo web app to the Home Screen. Open the app and **register a security key using WebAuthn**. Rapidly tap the 'Login' button multiple times — this triggers `navigator.credentials.get` several times in quick succession. … After a few seconds, **the Face ID prompt (or equivalent system biometric authentication modal) appears — inside the other app**, not the original one."
   > "After several rounds of testing this behavior, **WebAuthn stops working entirely across all installed web apps. The only way to recover is to restart the device.**"
   URL: https://bugs.webkit.org/show_bug.cgi?id=291258 ｜采集 2026-09-16

2. **其他未修复缺陷（均一手）**：
   - bug 273712 "WebAuthn/passkeys intermittently stop functioning (hangs or doesn't resolve promise)"，**Status: NEW**："Calls to `navigator.credentials.get` appear to have intermittently started either no-op'ing or never resolve the promise…" URL: https://bugs.webkit.org/show_bug.cgi?id=273712
   - bug 241126 "Error after calling `navigator.credentials.get()` twice"（2022-05-31，**NEW**）："…calling `navigator.credentials.get()` a second time will result in the following error: 'This request has been cancelled by the user'. … **This is problematic for Single Page Apps, especially if standalone**…" URL: https://bugs.webkit.org/show_bug.cgi?id=241126
3. **用户手势要求已于 iOS 17.4 取消**（一方=库官方文档记录 WebKit bug 264444 与 Apple 开发者论坛）：
   > SimpleWebAuthn docs, Browser Quirks → Safari: "Websites viewed in Safari running **in iOS 17.4 and macOS 14.4 and later** are free to invoke WebAuthn as needed. There is an internal rate limiter within Safari… **Versions of Safari running in iOS 17.3 and macOS 14.3 and earlier** … allow websites to make **one** call to `navigator.credentials.create()` or `navigator.credentials.get()` … for every browser navigation event without requiring a user gesture… When using a Single-Page Application (SPA) this limit only gets reset after reloading the page."
   URL: https://simplewebauthn.dev/docs/advanced/browser-quirks ｜采集 2026-09-16

**重要区分（避免误伤结论）**：**第三方 App 内嵌 WKWebView 不支持 WebAuthn（除非持有浏览器 entitlement）**，但 Home Screen web app 不是这种场景。依据：Apple Developer 论坛帖中经 WebKit bug 237380 得出的结论——"WebAuthn is not supported in WKWebView unless your app specifically has the Web Browser entitlement in which case it is then enabled"（https://developer.apple.com/forums/thread/705432 ，采集 2026-09-16，论坛帖，置信度较低，标为线索）；以及 WebKit 博客关于 Digital Credentials 的说明 "By the way, Digital Credentials is not yet supported in WKWebView"（https://webkit.org/blog/17333/ ，采集 2026-09-16）。

### B7 Passkey 的同步与恢复

**结论：Passkey 通过 iCloud 钥匙串端到端加密同步；即使所有设备都丢失，也可通过 iCloud 钥匙串托管（escrow）恢复——需 iCloud 账户+密码、回复注册手机号的短信、再输入设备锁屏密码，共只允许 10 次认证尝试，第 10 次失败后托管记录被销毁。** `事实`

证据（Apple 官方支持文档 "About the security of passkeys"）：
> "**Passkeys sync across a user's devices using iCloud Keychain.** iCloud Keychain is end-to-end encrypted with strong cryptographic keys not known to Apple and rate limited to help prevent brute-force attacks even from a privileged position on the cloud backend, and **are recoverable even if the user loses all their devices.**"
> "**Recovery security** … **Passkeys can be recovered through iCloud keychain escrow**, which is also protected against brute-force attacks, even by Apple. … **To recover a keychain, a user must authenticate with their iCloud account and password and respond to an SMS sent to their registered phone number. After they authenticate and respond, the user must enter their device passcode. iOS, iPadOS, and macOS allow only 10 attempts to authenticate. After several failed attempts, the record is locked and the user must call Apple Support to be granted more attempts. After the tenth failed attempt, the escrow record is destroyed.** Optionally, a user can set up an account recovery contact…"
> "New devices, as they sign in to iCloud, join the iCloud Keychain syncing circle in one of two ways: By pairing with and being sponsored by an existing iCloud Keychain device; or By using iCloud Keychain recovery."
> "Protections on accessing Apple Account … **any Apple Account using iCloud Keychain requires two-factor authentication.**"
URL: https://support.apple.com/en-us/102195 ｜采集 2026-09-16

旁证（Apple 官方营销页）：https://developer.apple.com/passkeys/ — "Because passkeys are synced with iCloud Keychain, they're available across Apple devices." ｜采集 2026-09-16

### B8 `@simplewebauthn/server` 在 Cloudflare Workers 上

**结论：官方 README 把 Cloudflare Workers 列为兼容运行时；库自 v7.0.0 起已「完全脱离 Node 的 `Buffer` 与 `crypto`，改用 `Uint8Array` + WebCrypto」。未找到任何官方关于必须开启 `nodejs_compat` 的说明；也**未找到**任何官方性能/开销量级说明。** `事实`（前两句）/ 未找到（后两句）

证据：

1. **官方 README（MasterKale/SimpleWebAuthn，14.0.x）**：
   > "SimpleWebAuthn can be installed from NPM and JSR in **Node LTS 22.x and higher**, **Deno v2.4.x and higher** projects, and **other compatible runtimes (Cloudflare Workers, Bun, etc...)**"
   URL: https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/README.md ｜采集 2026-09-16
   （JSR 包页面同样标注 "Works with Cloudflare Workers, Node.js, Deno, Bun"：https://jsr.io/@simplewebauthn/server ）
2. **官方 CHANGELOG v7.0.0 / v8.3.2**：
   > "The highlight of this release is the rearchitecture of `@simplewebauthn/server` to start allowing it to be used in more environments than Node. This was accomplished by **refactoring the library completely away from Node's `Buffer` type and `crypto` package, and instead leveraging `Uint8Array` and the WebCrypto Web API for all cryptographic operations.**"
   > "v8.3.2 … [server] The `cbor-x` dependency is now used **without pulling in the Node-specific stream API for better Web API environment compatibility**"
   URL: https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md ｜采集 2026-09-16
   （注：v8.0.0 的 changelog 原文把 Cloudflare Workers 列为 "periodically tested but **unofficially** supported"；v14 的 README 已改为直接列入兼容运行时列表。）
3. **`nodejs_compat`**：Cloudflare 官方文档说明该 flag 是需显式开启的（"Unlike most other compatibility flags, we do not expect the `nodejs_compat` to become active by default at a future date."）——
   URL: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ｜采集 2026-09-16
   → **未找到** SimpleWebAuthn 官方就 `nodejs_compat` 的说明（README / docs / troubleshooting 均未提）。
4. **签名验证开销**：**未找到一手来源**。README、`simplewebauthn.dev/docs/packages/server`、`/docs/advanced/browser-quirks` 均无与 PBKDF2 或其他算法的性能对比或量级说明。文末「未证实」列此项。

### B9 Workers WebCrypto 是否支持 ES256 / RS256 验签

**结论：支持。Cloudflare 官方算法表对 `ECDSA` 与 `RSASSA PKCS1 v1.5` 的 `verify()` 均打勾；ES256 = COSE `-7`、RS256 = `-257`（W3C WebAuthn 规范给出）。曲线仅支持 WebCrypto 标准曲线 P-256 / P-384 / P-521，P-256 在列。** `事实`

证据：

1. **Cloudflare Workers 官方文档 Web Crypto → Supported algorithms**：
   > "Workers implements all operations of the WebCrypto standard, as shown in the following table. A checkmark (✓) indicates that this feature is believed to be fully supported according to the spec."
   > 表中：`RSASSA PKCS1 v1.5` → sign ✓, verify ✓, exportKey ✓, importKey ✓；`ECDSA` → sign ✓, verify ✓, exportKey ✓, importKey ✓
   URL: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ ｜采集 2026-09-16
2. **曲线范围**（Cloudflare 员工 Kenton Varda 在官方社区的回答）："At present we only support the curves that are in the WebCrypto standard: **'P-256', 'P-384', and 'P-521'**" —
   URL: https://community.cloudflare.com/t/is-there-support-for-the-k-256-curve-in-ecdsa-webcrypto/242459 ｜采集 2026-09-16（厂商员工答复，标为次强来源）
3. **算法标识映射（W3C 规范，Recommendation 2026-08-25）**，§1.3.1 Registration 示例：
   > `{ type: "public-key", alg: -7 // "ES256" as registered in the IANA COSE Algorithms registry }`
   > `{ type: "public-key", alg: -257 // Value registered by this specification for "RS256" }`
   URL: https://www.w3.org/TR/webauthn-3/ ｜采集 2026-09-16
4. **MDN 对 `verify()` 的算法支持（文档级）**：
   > "To use ECDSA, pass an `EcdsaParams` object. … **The `verify()` method supports the same algorithms as the `sign()` method.**"
   URL: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify ｜采集 2026-09-16

---

## A 的结论对本项目会话方案的直接影响

**问题：用 HttpOnly Cookie 承载会话 token，在 iOS PWA 下是否可靠？**

- **可靠的部分（`事实`）**：`Set-Cookie` 下发的第一方 HttpOnly 会话 cookie **不受** ITP「7 天脚本可写存储」上限约束；Home Screen web app 的第一方域名被显式豁免于 ITP 的数据清理；同域 `/api/*` 的 `fetch` 属 same-site，`SameSite=Lax` 不会阻断它；30 天 `Max-Age` 会被遵守（上限共识约 400 天）。**HttpOnly Cookie 承载不透明 token 这条路在 iOS PWA 下是成立的。**
- **必须接受的前提（`事实`）**：iOS 上 PWA 与 Safari **是两套独立存储**。用户在 Safari 登录过 ≠ 在 PWA 里已登录；反过来在 PWA 里登录也不等于 Safari 登录。**用户必须在 PWA 里（每个设备各一次）单独登录一次**，此后会话由 PWA 自己那套 cookie 容器维持。iOS 26 起「添加到主屏幕默认以 web app 打开」让这一分离成为默认路径。`推断`：这对 2 人自用的项目不构成障碍，只要登录页在 PWA 内可用且会话寿命够长。
- **真实风险清单（`事实`）**：① WebKit bug 272325（iOS 17.x 起，PWA 内会话 cookie 偶发被回退成旧值导致随机登出；**至今 Status: NEW**）；② bug 255524（Safari 16.4 起 `fetch`/资源请求偶发不带 `Lax` cookie，已标记 RESOLVED CONFIGURATION CHANGED 但线程仍有人反馈）；③ 用户清除 Safari/PWA 网站数据、删除并重新添加主屏幕图标 → 会话按预期失效（设计使然，见 A1）。
- **若不可靠，替代形态是什么？**
  - **主形态（`推断`，建议保持不变）**：仍用 `Set-Cookie` + HttpOnly 不透明 token，`Max-Age` 取长值（如 30–90 天，无需追随 400 天上限），`Secure` + `SameSite=Lax`（同域 `fetch` 不受影响；若将来出现跨站跳转回站点的登录流程再评估）。**不要**改成 localStorage + `Authorization` 头：那会把 token 放进脚本可写存储，同时吃下 7 天脚本可写存储上限与 XSS 可读这两个问题（依据 A2 引文）。
  - **必须并存的设计**：把「Safari 里登录」与「PWA 里登录」当成两个独立会话上下文来设计——即会话建立必须是幂等、可重复的（用户在两个上下文各自登录一次不会互相踢掉）。**不要**设计任何依赖「Safari 的 cookie 会被带进 PWA」的流程。
  - **若随机登出真的成为痛点（`推断`，成本较高，暂不建议）**：被动接受"重新登录一次"是最省事的兜底；WebKit tracker 里唯一被记录的跨容器传递手段是把数据塞进在添加主屏幕时被冻结的 `window.location` query（bug 181849 Comment 1），**这不是官方支持能力**，且会把凭据写进 URL/历史，不建议采用。

## B 的结论：Passkey 路线是否值得复议

**可行性判断**：
- **技术上可行（`事实`）**：iOS Home Screen web app 内可完成 WebAuthn 注册与断言（bug 291258 记录）；iOS 17.4+ 取消了用户手势限制、改为速率限制（库官方 docs 引 WebKit bug 264444）；服务端侧 `@simplewebauthn/server` 官方 README 直接把 Cloudflare Workers 列为兼容运行时，库已改为纯 WebCrypto 实现；Workers 的 WebCrypto 表对 `ECDSA.verify` 与 `RSASSA PKCS1 v1.5.verify` 打勾，曲线含 P-256（即 ES256 与 RS256 均可验）。
- **但它是"额外一条路"，不是"会话方案的替代"（`推断`）**：Passkey 解决的是**认证**（登录时不再需要密码/不再需要长期凭据），它不提供持续会话。登录成功后仍然要落一个会话凭据——回到 A 的结论，也就是 HttpOnly cookie。**因此在 iOS PWA 上，Passkey 并不能绕开 A 里的存储隔离问题**：用户第一次在 PWA 里登录，依然要在 PWA 上下文内完成一次 WebAuthn 仪式。

**代价清单**：
| 项 | 内容 | 性质 |
|---|---|---|
| 实现复杂度 | 需要注册/断言两端点、challenge 存储与一次性消费、credential 公钥与 counter 持久化、RP ID/origin 校验；`verifyRegistrationResponse`/`verifyAuthenticationResponse` 只是其中一段 | `推断`（基于库 docs 的 API 形态） |
| 依赖 | 至少 `@simplewebauthn/server`（+ 前端 `@simplewebauthn/browser`）；数据落在一个 KV/D1 表；需固定 origin/RP ID（PWA 与 Safari 同域，不构成额外约束） | `事实`（README/安装章节） |
| 前端兼容坑 | iOS ≤17.3 仍需遵守「每次页面加载一次调用」的手势/额度模型，SPA 下额度不重载不重置；库官方文档专门为 Safari 维护了一节 quirks | `事实` |
| 浏览器缺陷风险 | PWA 下已记录且未修复的缺陷：跨 web app 弹出 Face ID 提示并可致 **全部 web app 的 WebAuthn 失效直到重启设备**（291258）、promise 偶发永不 resolve（273712）、连续两次 `get()` 报错（241126） | `事实` |
| 恢复路径风险 | 依赖 iCloud 钥匙串：同步需开启 iCloud 钥匙串且账户需 2FA；全部设备丢失时经 escrow 恢复，需账户密码 + 注册手机号短信 + 设备锁屏密码，**仅 10 次尝试，第 10 次失败后托管记录销毁**；无恢复联系人则需走 Apple 支持 | `事实`（Apple 102195） |
| 本项目额外风险 | 该项目只有 2 个用户、需要跨设备可用：一旦某人的 iCloud 钥匙串状态异常（或用非 Apple 设备/Android 登录），Passkey 会变成比密码更糟的体验；库官方**没有任何**关于验证开销的量级说明，无法据此论证「比 PBKDF2 快/慢」 | `推断` + `未找到一手来源` |

**建议（`推断`）**：本票不必复议成「用 Passkey 取代会话方案」。若做，也只作为**登录方式增强**（保留密码/一次性码作兜底），并且必须在 iOS PWA 真机上验完 291258 / 273712 / 241126 三个缺陷的实际表现后再决定是否允许它成为主登录路径。

---

## 未证实 / 未找到一手来源

- **iOS 上「添加到主屏幕」是否会像 Mac 那样把 Safari 的 cookie 复制进 web app**：Apple 文档只对 Mac（Add to Dock）说明会复制；对 iOS 只说明「separate cookies and storage from the browser」。**未找到**任一 Apple/WebKit 文档确认或否认 iOS 存在同类一次性复制 → 默认按「不复制」来设计。
- **WebAuthn 在 iOS Home Screen web app 中的起始支持版本**：**未找到** Apple/WebKit 官方版本声明。WebKit tracker 中可确认在 PWA 内可用且被官方受理的最早记录为 2025-04-08 的 bug 291258（iOS 18 环境）。
- **`SameSite` 在 iOS PWA 独立窗口是否有独立于 Safari 的异常**：**未找到**任何一手来源（WebKit bug / 博客 / Apple 文档）记录此类差异；相关记录均为 Safari 一般性缺陷。
- **WebKit 是否已在出货版本中启用 400 天 cookie 上限**：Wilander 2022-01-25 在 webkit-dev 称 "Apple WebKit and CFNetwork … support a 400-day max-age upper limit"，但同一工程师在 2022-03-08 的 bug 237350 评论中称 "browsers have reached consensus on a ~400-day expiry cap on all cookies … **None of those caps are shipping though**"。两条一手陈述**时间不同、结论不一致**，均保留；建议不要把 >400 天的 `Max-Age` 当可依赖的持久性来源。
- **`@simplewebauthn/server` 签名验证的开销量级**：README / CHANGELOG / docs 中**均无**性能或与 PBKDF2 的对比说明 → 无法给出一手结论。
- **`@simplewebauthn/server` 是否需要 `nodejs_compat`**：**未找到**该库官方的相关说明（README 只说 Cloudflare Workers 属兼容运行时）。
- **仓库外线索（不计入结论）**：WebKit bug 255524 线程中「去掉 SameSite 属性」「改用 `SameSite=None`」的规避做法，以及 bug 181849 Comment 1 的 `window.location.query` 传递法，均为报告者经验/开发者评论，非官方建议。

## 来源清单（全部一手，均于 2026-09-16 采集）

- WebKit Tracking Prevention（常青文档）https://webkit.org/tracking-prevention/
- WebKit 博客 ITP 2.1 https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/
- WebKit 博客 Full Third-Party Cookie Blocking and More https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- WebKit 博客 CNAME Cloaking and Bounce Tracking Defense https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/
- WebKit 博客 News from WWDC25: WebKit in Safari 26 beta https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- WebKit bug tracker：181849 / 219650 / 226386 / 237350 / 241126 / 255524 / 272325 / 273712 / 291258（URL 见上文各条）
- Apple WWDC23 session 10120 What's new in web apps https://developer.apple.com/videos/play/wwdc2023/10120/
- Apple 支持 About the security of passkeys https://support.apple.com/en-us/102195
- Apple 支持 Use Safari web apps on Mac https://support.apple.com/104996
- Apple Developer Passkeys Overview https://developer.apple.com/passkeys/
- W3C WebAuthn Level 3 (Recommendation, 2026-08-25) https://www.w3.org/TR/webauthn-3/
- draft-ietf-httpbis-rfc6265bis-10 https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-10.txt
- webkit-dev 邮件列表（400 天上限立场）http://mail-archive.com/webkit-dev@lists.webkit.org/msg30402.html
- MDN Set-Cookie（文档级）https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- MDN SubtleCrypto.verify（文档级）https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify
- Cloudflare Workers Web Crypto https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare Workers Compatibility flags https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- SimpleWebAuthn README https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/README.md
- SimpleWebAuthn CHANGELOG https://github.com/MasterKale/SimpleWebAuthn/blob/master/CHANGELOG.md
- SimpleWebAuthn docs：Server https://simplewebauthn.dev/docs/packages/server ｜ Browser Quirks https://simplewebauthn.dev/docs/advanced/browser-quirks
