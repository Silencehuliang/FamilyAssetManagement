/**
 * 路由表 —— 12 页的单一真相。
 *
 * 契约落点：docs/specs/frontend-ia.md §3.1（清单）、§2.1（导航壳）
 *
 * ⚠️ 契约把「12 页的确切路由字符串与 URL 形态」留给实现期（§11 / §12.2）——
 *    本文件就是那个实现期决定：**路径段 = 路由键**，首页是 `/`。这样
 *    页面上显示的路由键、代码里的 key、URL 三段完全同名，不存在第二套命名。
 *
 * ⚠️ 契约 §3.1 的页数口径：**12 页**。原型里的 `assets` 是变体 B 的独有产物，
 *    变体 A 选定后它失去存在理由，**不进本表**（§3.1 的口径修正说明）。
 */

export type RouteKey =
  | "login"
  | "home"
  | "ledger"
  | "entry"
  | "stock"
  | "expense"
  | "budget"
  | "trend"
  | "ca"
  | "tags"
  | "queue"
  | "me";

/** 底栏 Tab 键 —— 恰好四个（frontend-ia §2.1） */
export type TabKey = "home" | "ledger" | "entry" | "stock";

/** 离线能力分档（offline-sync-contract §8.1 + frontend-ia §3.1 的「离线可用性」列） */
export type OfflineTier =
  | "online-only"
  | "read-only"
  | "full"
  | "is-offline-state";

export interface RouteDef {
  key: RouteKey;
  /** URL 路径（首页为 `/`） */
  path: string;
  /** 页面名 */
  title: string;
  /** 底栏归属；null = 不在底栏 */
  tab: TabKey | null;
  /** 离线能力 */
  offline: OfflineTier;
  /** 契约落点 */
  contract: string;
}

export const ROUTES: readonly RouteDef[] = [
  {
    key: "login",
    path: "/login",
    title: "登录",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ①",
  },
  {
    key: "home",
    path: "/",
    title: "首页",
    tab: "home",
    offline: "read-only",
    contract: "frontend-ia.md §3.2 ②",
  },
  {
    key: "ledger",
    path: "/ledger",
    title: "流水",
    tab: "ledger",
    offline: "read-only",
    contract: "frontend-ia.md §3.2 ③",
  },
  {
    key: "entry",
    path: "/entry",
    title: "记一笔",
    tab: "entry",
    offline: "full",
    contract: "frontend-ia.md §3.2 ④",
  },
  {
    key: "stock",
    path: "/stock",
    title: "股票持仓",
    tab: "stock",
    offline: "read-only",
    contract: "frontend-ia.md §3.2 ⑤",
  },
  {
    key: "expense",
    path: "/expense",
    title: "支出分析",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑥",
  },
  {
    key: "budget",
    path: "/budget",
    title: "预算",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑦",
  },
  {
    key: "trend",
    path: "/trend",
    title: "收益趋势",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑧",
  },
  {
    key: "ca",
    path: "/ca",
    title: "除权确认",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑨",
  },
  {
    key: "tags",
    path: "/tags",
    title: "标签管理",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑩",
  },
  {
    key: "queue",
    path: "/queue",
    title: "待同步",
    tab: null,
    offline: "is-offline-state",
    contract: "frontend-ia.md §3.2 ⑪",
  },
  {
    key: "me",
    path: "/me",
    title: "设置 / 我的",
    tab: null,
    offline: "online-only",
    contract: "frontend-ia.md §3.2 ⑫",
  },
];

/**
 * 底栏四 Tab，**顺序即视觉顺序**。
 *
 * 依据：线框的 `TABS.A` 是 `home / ledger / entry / stock / me`，
 * §2.1 的决议 = 「原型 A 减掉『我的』这一格」⇒ 就是下面这四个，顺序不动。
 */
export const TABS: readonly TabKey[] = ["home", "ledger", "entry", "stock"];

/**
 * 中央凸起的那一格。
 *
 * §2.1：「＋」视觉上高于其余三个 Tab，且**在两个子系统之间居中**——
 * 支出侧占 `home` / `ledger`，股票侧占 `stock`，`entry` 落在两者之间。
 */
export const RAISED_TAB: TabKey = "entry";

/** 按 key 取路由定义。表里没有的 key 直接抛错 —— 不返回 undefined 让调用方去猜。 */
export function routeOf(key: RouteKey): RouteDef {
  const found = ROUTES.find((r) => r.key === key);
  if (found === undefined) {
    throw new Error(`路由表缺少 key：${key}`);
  }
  return found;
}

/** 带底栏的路由（除 `login` 外全部） */
export const SHELL_ROUTES: readonly RouteDef[] = ROUTES.filter(
  (r) => r.key !== "login",
);
