/**
 * 时间口径工具 —— 中国标准时间（CST，UTC+8）。
 *
 * 契约落点：决策票 #6 的 R4；docs/specs/d1-schema.md §7.1
 *
 * 🔴 两条纪律，本文件是它们的唯一出口（别在别处直接 new Date() 格式化）：
 *   1. **时间一律存 UTC 整数秒**，只有**展示**与**周期边界**才换算 CST。
 *   2. 换算用**固定 +8 偏移**，不引 IANA 时区库 —— 中国 1992-04-05 起暂停夏时制、
 *      此后全年恒为 UTC+8，而本系统全新开始、不导入历史 ⇒ 固定偏移精确成立（#6 R4）。
 *
 * 实现要点：先对毫秒加偏移，再用 **getUTC** 系列读字段。
 * 这样结果**与运行环境的时区无关** —— 本机是东八区、workerd 是 UTC，
 * 两处必须得到同一个字符串。反过来若用 getFullYear() 之类，就会得到两种答案。
 */

/** UTC+8，固定偏移（毫秒） */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function shifted(epochMs: number): Date {
  return new Date(epochMs + CST_OFFSET_MS);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM` —— 导航壳顶栏的「当期（CST 自然月）」用它 */
export function cstMonthKey(epochMs: number): string {
  const d = shifted(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** `YYYY-MM-DD` —— 与 entry.biz_date 同口径 */
export function cstDateKey(epochMs: number): string {
  const d = shifted(epochMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * `YYYY-MM-DD HH:mm` —— 离线降级的「缓存于」时间戳用它（frontend-ia §3.2 ⑤）。
 *
 * ⚠️ 与「行情截至 YYYY-MM-DD」是**两个不同的时间**，缺一不可：
 *    只给数据日期会以为是刚拉的，只给缓存时刻会以为是实时价。
 */
export function cstDateTimeKey(epochMs: number): string {
  const d = shifted(epochMs);
  return `${cstDateKey(epochMs)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
