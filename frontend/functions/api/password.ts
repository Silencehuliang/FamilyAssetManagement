import { json, type Env } from "./_middleware";

/**
 * POST /api/password —— 改密码 —— 成功即**全端失效**
 *
 * 契约落点：docs/specs/auth-contract.md §3.2 / §5.3
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - 需旧密码；`UPDATE member_credential SET phc = …, gen = gen + 1`。
 *   - 全端失效**由 DB 触发器** `trg_credential_gen_kill_sessions` 保证（`gen` 变化即删该成员全部会话），**不由前端保证**。
 *   - ⚠️ **透明重哈希不得改 `gen`** —— 改了会让用户在自己刚登录的那天被踢出（实测覆盖：探针 C1/C2/C3）。
 *   - 成功后前端须跳回登录页（发起改密的这一条会话也没了）。
 */
export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/password" }, 501);
};
