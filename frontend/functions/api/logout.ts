import { json, type Env } from "./_middleware";

/**
 * POST /api/logout —— 撤销**当前**会话
 *
 * 契约落点：docs/specs/auth-contract.md §3
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - 置 `revoked_at`（不是 DELETE）；查询一律带 `revoked_at IS NULL`。
 *   - 同时清客户端 Cookie。
 *   - ⚠️ 登出**不清空**离线队列 —— 队列属于设备、不属于会话（offline-sync-contract §6.2）；但前端须**先提示**「N 条待同步，登出后将保留至下次登录」。
 */
export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/logout" }, 501);
};
