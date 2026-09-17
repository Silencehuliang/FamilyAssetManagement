import { json, type Env } from "./_middleware";

/**
 * GET /api/session —— 返回 `{member_id, member_name}` —— 前端启动时探测「我是谁」
 *
 * 契约落点：docs/specs/auth-contract.md §3
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - 只返回这两项，不附带任何权限字段（无权限差异，见 frontend-ia §3.2 ⑫）。
 *   - 前端启动先探本端点，401 ⇒ **清 runtime 缓存 + 跳登录页**（offline-sync-contract §7.2）。
 *   - 「记一笔」页的「谁花的」默认值取这里的 `member_id`（不支持代记）。
 */
export const onRequestGet: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/session" }, 501);
};
