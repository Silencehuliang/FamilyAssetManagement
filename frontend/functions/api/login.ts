import { json, type Env } from "./_middleware";

/**
 * POST /api/login —— 登录 —— 唯一白名单端点（不经鉴权中间件的会话校验）
 *
 * 契约落点：docs/specs/auth-contract.md §3.1 / §5.4
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - `username` 存**小写归一化**后的值；IP 取 `CF-Connecting-IP`（不读 `X-Forwarded-For`）。
 *   - **计时侧信道必须堵**：用户名不存在时也要对一条固定的假 `phc` 跑一次 PBKDF2，再返回与「密码错」**完全相同**的 401。
 *   - 限速三层封顶：① `(username, ip, 小时桶)` 主键② `ON CONFLICT … DO UPDATE … WHERE n < 20`③ 全局失败写行 ≤ 2,000/天。
 *   - 失败响应固定延迟 500 ms（`setTimeout` 是 wall time，不烧 CPU 配额）。
 *   - 成功签发会话并 Set-Cookie：`Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`，⚠️ **绝不设 Domain**（`pages.dev` 在 PSL PRIVATE 段）。
 *   - 响应形状见 §3.1：200 `{member_id, member_name}` / 401 `{error:"invalid_credentials"}` / 429 `{error:"too_many_attempts", retry_after}`。
 */
export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/login" }, 501);
};
