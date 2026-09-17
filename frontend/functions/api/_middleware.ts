/**
 * `/api/*` 的鉴权中间件 —— 全站唯一的认证收口。
 *
 * 契约落点：docs/specs/auth-contract.md §3.1（响应形状）、§4（Cookie 规格）、§5.1~§5.5
 *
 * 本文件同时是 `/api/**` 各端点的**共享模块**（Env / json / cookie 名都在这里导出）。
 * 之所以把共享物放在 `_middleware.ts` 里而不是另开 `_lib/`：`_middleware` 是
 * Pages Functions 里**确定不会变成路由**的那个文件名，其余下划线前缀行为未逐条核实。
 *
 * 🔴 三条不能走样的约束：
 *   1. 未认证与「用户不存在」「密码错」都用**同一个形状**，不区分 —— 分开就是用户名枚举器。
 *   2. `/api/login` 是**唯一**白名单端点；`/api/register` 端点**不存在**（不是被禁用）。
 *   3. `/api/*` 的响应头**必须在这里的 Response 上加** —— `_headers` 对 Function 响应无效
 *      （deploy-topology §11.11）。
 *
 * ⚠️ 骨架阶段：**会话校验尚未实现**，因此对白名单之外的请求**一律 501 失败关闭**。
 *    这是刻意的 —— 一个「先放行、以后再补校验」的中间件是真实的安全漏洞，
 *    不能作为可运行的中间态存在。
 */

export interface Env {
  /** 与 Cron Worker 共享的同一个 D1 */
  DB: D1Database;
}

/** 会话 Cookie 名（auth-contract §4） */
export const SESSION_COOKIE = "fam_session";

/**
 * API 响应统一带 `Cache-Control: no-store`。
 * 理由：这些响应**因人而异**（会话身份），且 `_headers` 管不到 Function 响应。
 */
export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** 唯一白名单端点（auth-contract §3） */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/api/login"]);

/**
 * 取会话 Cookie 值。无 Cookie 返回 null。
 *
 * 只按名字精确匹配 —— 不做前缀匹配，避免 `fam_session_x` 这类名字被误认。
 */
function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);

  // ── ① Origin 校验（非 GET） ──────────────────────────────────────────────
  //
  // auth-contract §3.1 只写了「非 GET 且 Origin 不符 ⇒ 403 bad_origin」，**未说明
  // Origin 缺失时怎么办**。此处按**更严**的方向实现：缺失也拒。
  // 理由：本项目所有非 GET 请求都来自站内 fetch（浏览器必带 Origin），
  // 缺失 Origin 的非 GET 只可能是站外工具 ⇒ 失败关闭比放行更符合本项目的姿态。
  // ⚠️ 这条严于契约字面，属实现期判断，须与契约复核。
  if (context.request.method !== "GET") {
    const origin = context.request.headers.get("Origin");
    if (origin === null || origin !== url.origin) {
      return json({ error: "bad_origin" }, 403);
    }
  }

  // ── ② 白名单 ────────────────────────────────────────────────────────────
  if (PUBLIC_PATHS.has(url.pathname)) {
    return context.next();
  }

  // ── ③ 会话存在性 ────────────────────────────────────────────────────────
  const token = readSessionCookie(context.request);
  if (token === null) {
    return json({ error: "unauthenticated" }, 401);
  }

  // ── ④ 会话校验 —— 尚未实现，**失败关闭** ─────────────────────────────────
  //
  // 实现时必须补齐（顺序不可颠倒）：
  //   a. 按 token 的 SHA-256 查 `session`（带 `revoked_at IS NULL`）；
  //   b. 校验 `expires_at > now` 且 `absolute_expires_at > now`；
  //   c. 滑动续期 `expires_at = min(now + 30d, absolute_expires_at)`；
  //      且 `last_seen_at` **仅在 `now - last_seen_at > 86400` 时写**
  //      （D1 按写行计费、索引列写入额外 +1 —— 每请求写一次等于请求数 ×2 的写行消耗）；
  //   d. 把 `member_id` 挂进 `context.data` —— **下游不得信客户端传来的 member_id**
  //      （offline-sync-contract §5.1：「客户端带 member_id 也一律不信」）。
  void token;
  return json({ error: "not_implemented", detail: "会话校验尚未实现" }, 501);
};
