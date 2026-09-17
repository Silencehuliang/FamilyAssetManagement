import { json, type Env } from "../_middleware";

/**
 * POST /api/entries/replay —— 离线队列整批重放
 *
 * 契约落点：docs/specs/offline-sync-contract.md §5.1 / §5.2 / §5.3
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - `member_id` **不在请求里** —— 由会话决定（`context.data.member_id`）；**客户端带了也一律不信**。
 *   - 写入语句是**契约级、不得改写**（§5.3）：靠 `entry.client_ref` 唯一索引做幂等，`ON CONFLICT` 命中即 `duplicate`。
 *   - 整批**一个请求**，服务端**逐条独立判定** —— 一条坏数据不阻塞其余（**预校验后才进事务**）。
 *   - 响应 `status` 三值：`created` / `duplicate` / `rejected`（`rejected` 须给 `reason`）。
 *   - `biz_date` 由 CST 换算；`occurred_at` **不可指向未来**（超 5 分钟容差即拒并标红，**不静默改写**）。
 */
export const onRequestPost: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/entries/replay" }, 501);
};
