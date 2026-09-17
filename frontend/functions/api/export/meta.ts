import { json, type Env } from "../_middleware";

/**
 * GET /api/export/meta —— 导出清单（一次）
 *
 * 契约落点：docs/specs/backup-export-contract.md §5.1
 *
 * ⚠️ 骨架阶段**尚未实现**。鉴权已由 `api/_middleware.ts` 收口（本端点自己不重复校验）。
 *    实现时必须覆盖：
 *   - 返回 `format` / `format_version` / `export_started_at` / `page_size` / `schema_migrations` / `tables[]`。
 *   - `schema_migrations` **读自 D1 自带的 `d1_migrations` 表** —— 这就是本项目对 schema 版本的表达方式，**零 schema 变更**（不加列、不建 `schema_meta`）。
 *   - 每个表的 `max_rowid` 是 `export_started_at` 时刻的 `MAX(rowid)`，用作本次导出的**上界**。
 *   - 共 **13 张表**（15 张里排除 `session` 与 `login_attempt`）。
 */
export const onRequestGet: PagesFunction<Env> = async () => {
  return json({ error: "not_implemented", endpoint: "/api/export/meta" }, 501);
};
