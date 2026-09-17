import { json, type Env } from "../_middleware";

/**
 * POST /api/sessions/revoke-all —— 登出所有设备（含当前）
 *
 * 契约落点：docs/specs/auth-contract.md §3
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - 撤销该成员**全部**未撤销会话（含发起请求的这一条）。
 *   - 前端须在队列非空时提示「N 条待同步，登出后将保留至下次登录」——与单设备登出同一条规则。
 */
export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/sessions/revoke-all" }, 501);
};
