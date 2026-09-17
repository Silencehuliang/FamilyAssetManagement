import { json, type Env } from "../_middleware";

/**
 * GET /api/export —— 导出一页数据（JSON 逐表逐页 / CSV 流水宽表）
 *
 * 契约落点：docs/specs/backup-export-contract.md §5 / §6
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - `?format=json&table=<t>&cursor=<k>&limit=<n>` 与 `?format=csv&cursor=<k>&limit=<n>` 两种形态。
 *   - 游标**锚 `rowid` 升序**：`rowid > cursor AND rowid <= max_rowid ORDER BY rowid ASC` —— offset-only 遇插队写入会**重叠**（探针 §D 实测重叠 100 行）。
 *   - 页大小 **2000**、硬上限 **4000**（由 CPU 10 ms 反推，非拍脑袋）。
 *   - ⚠️ 这是**非事务性快照** —— 导出期间的写入会体现在后续页里，须如实标注，不要假装一致。
 *   - 格式硬规则四条：列名原样 / 整数分不转元 / `null` 即 `null`（**不写空串**）/ 数字不加引号。
 */
export const onRequestGet: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/export" }, 501);
};
