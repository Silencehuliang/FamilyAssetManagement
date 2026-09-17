/* eslint-env serviceworker */
/* ============================================================================
 * Service Worker —— 🔴 骨架阶段，**尚未提供离线能力**
 *
 * 契约：docs/specs/offline-sync-contract.md §7
 *
 * 本文件当前只实现「与契约不冲突的骨架部分」：
 *   ✔ 更新流程用**用户确认**路径（绝不无条件 skipWaiting）
 *   ✔ 提供 runtime 缓存清空入口（登出 / 会话失效时用）
 *   ✔ 任何情况下都**不缓存** /api/login、/api/session、/api/export 与非 GET 请求
 *
 * ⛔ 尚未实现（在补齐之前，任何「离线可用」的说法都不成立）：
 *   - §7.2 静态资源 precache（必须走 workbox-precaching，
 *     `revision` 由**构建期内容哈希**生成，**禁止手写** —— 所以这里刻意留空）
 *   - §7.2 /api/* GET 的 NetworkFirst + `cachedAt` 时刻记录
 *   - §7.2 分析页 GET 一律不缓存
 *   - §8 离线只读降级与队列合并显示
 *
 * ⚠️ 现在直接注册它是安全的：它不缓存任何东西，只是把更新流程的位置占住。
 *    但**不要**在没有上面那些实现的情况下把 SW 当作离线方案。
 * ========================================================================== */

const SW_VERSION = "v0-skeleton";

/** 静态资源 precache 的缓存名（当前为空，见文件头 ⛔） */
const PRECACHE = `hl-precache-${SW_VERSION}`;
/** 运行时（/api/* GET）的缓存名 */
const RUNTIME = `hl-runtime-${SW_VERSION}`;

/** 永不缓存的路径 —— 登入态判定与会话探测，缓存它们会制造一个陈旧的身份视图。 */
const NEVER_CACHE_PATHS = ["/api/login", "/api/session", "/api/logout", "/api/export", "/api/export/meta"];

self.addEventListener("install", (event) => {
  // 🔴 这里刻意**不调用** skipWaiting()。
  // 官方对无条件 skipWaiting() 的警告原文见 offline-sync-contract §7.3：
  // 会让旧页面与新 SW 混用，对 SPA + 懒加载路由尤其危险（正是本项目的形态）。
  // 更新走「提示条 → 用户点击 → SKIP_WAITING 消息 → reload」。
  // 骨架阶段 install 不做任何事 —— 保持在此是为了让「precache 在此注入」有明确落脚点。
  // TODO(§7.2)：在此把构建期生成的 precache 清单写进 PRECACHE 缓存。
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 清掉不属于当前版本的缓存 —— 版本号写在缓存名里，靠前缀判定。
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => (k.startsWith("hl-precache-") || k.startsWith("hl-runtime-")) && k !== PRECACHE && k !== RUNTIME)
          .map((k) => caches.delete(k)),
      );
      // 骨架阶段**不** claims() 全部客户端：等真有缓存策略时再谈接管范围。
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;

  // 更新流程：由站内提示条在**用户点击后**发出（§7.3）。
  if (data === "SKIP_WAITING" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
    return;
  }

  // 登出 / 会话失效时必须清空 runtime 缓存（§7.2 🔴）。
  // 理由：SW 的 runtime 缓存**不区分会话** —— 不清的话，同一设备上
  // 未认证的人可能看到已缓存的鉴权响应。precache 保留。
  if (data && data.type === "CLEAR_RUNTIME_CACHE") {
    event.waitUntil(caches.delete(RUNTIME));
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 同源之外的请求一概不碰。
  if (url.origin !== self.location.origin) return;

  const isApi = url.pathname.startsWith("/api/");

  if (isApi) {
    // 🔴 非 GET 一律不进 SW —— 写请求绝不能被缓存层改写。
    if (req.method !== "GET") return;

    // 鉴权相关与导出：显式绕过（NEVER_CACHE_PATHS）。
    if (NEVER_CACHE_PATHS.some((p) => url.pathname === p)) return;

    // TODO(§7.2)：其余 /api/* GET 走 NetworkFirst + 记 cachedAt。
    // 当前**直接放行**（不拦不缓存）—— 放行是安全的默认。
    return;
  }

  // TODO(§7.2)：静态资源 precache 命中优先。
  // 当前同样直接放行：不缓存 = 不会给出陈旧内容。
});
