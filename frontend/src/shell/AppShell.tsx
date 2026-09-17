import { Suspense } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { RAISED_TAB, ROUTES, TABS, routeOf } from "../routes";
import { cstMonthKey } from "../lib/cst";
import GlobalBanners from "./GlobalBanners";
import { useBannerState } from "./useBannerState";

/**
 * 导航外壳 —— 全部带底栏的页面共用这一层。
 *
 * 契约落点：docs/specs/frontend-ia.md §2.1（定型图）、§9（全局元件）
 *
 * 结构（自上而下，与 §2.1 的定型图逐行对应）：
 *   [头像]  当前页 · YYYY-MM（CST 自然月）  [在线]
 *   ─────────────────────────────────────────
 *   全局横幅（条件渲染）
 *   ─────────────────────────────────────────
 *   页面内容（Outlet）
 *   ─────────────────────────────────────────
 *   首页  流水  (＋)  股票          ← 四 Tab，`entry` 凸起
 *
 * 🔴 两条不允许走样的约束：
 *   - Tab 集合**恰好四个**；`me` 不是 Tab，入口是右上角头像（深度 2 步）。
 *   - 全局横幅/指示器**注入在外壳**，不在各页重复实现（§9 原文）。
 */
export default function AppShell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const banners = useBannerState();
  const period = cstMonthKey(Date.now());

  // 顶栏标题取「当前页名 · 当期」。匹配不到就留空 —— 不编一个默认页面名。
  const current = ROUTES.find((r) => r.path === pathname);

  return (
    <div className="shell">
      <header className="shell__topbar">
        {/* 头像 = 「我的」的唯一入口（§2.1：me 不是 Tab，深度 2 步） */}
        <button
          type="button"
          className="shell__avatar"
          aria-label="设置 / 我的"
          onClick={() => navigate("/me")}
        >
          我
        </button>

        <span className="shell__title">
          {current !== undefined ? `${current.title} · ${period}` : period}
        </span>

        <span
          className={
            banners.online
              ? "shell__net shell__net--on"
              : "shell__net shell__net--off"
          }
        >
          {banners.online ? "在线" : "离线"}
        </span>
      </header>

      <GlobalBanners {...banners} />

      <main className="shell__content">
        <Suspense fallback={<p className="route-fallback">正在加载…</p>}>
          <Outlet />
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="主导航">
        {TABS.map((key) => {
          const route = routeOf(key);
          const raised = key === RAISED_TAB;
          return (
            <NavLink
              key={key}
              to={route.path}
              // `end` 只对根路径有意义：不加会把 `/` 匹配到所有路由上
              end={route.path === "/"}
              className={({ isActive }) =>
                [
                  "tabbar__tab",
                  raised ? "tabbar__tab--raised" : "",
                  isActive ? "tabbar__tab--on" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
            >
              <span className="tabbar__dot" aria-hidden="true" />
              <span>{raised ? "＋" : route.title}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
