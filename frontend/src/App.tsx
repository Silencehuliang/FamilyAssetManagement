import {
  lazy,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

import { SHELL_ROUTES, type RouteKey } from "./routes";
import AppShell from "./shell/AppShell";

/**
 * 页面装配 —— 12 页全部走**惰性导入**。
 *
 * 契约落点：docs/specs/frontend-ia.md §2.1 / §3.1
 *
 * 🔴 为什么坚持懒加载：offline-sync-contract §7.3 说明 SW 更新走
 *    「旧页面与新 SW 混用」的风险，而**SPA + 懒加载路由正是最危险的形态**。
 *    把页面拆成独立 chunk 是项目已选定的形态，别在实现期把它退回成单个 bundle。
 *
 * ⚠️ 骨架阶段 12 个页面都是存根（见 src/pages/*.tsx）。
 */
const PAGES: Readonly<Record<RouteKey, LazyExoticComponent<ComponentType>>> = {
  login: lazy(() => import("./pages/LoginPage")),
  home: lazy(() => import("./pages/HomePage")),
  ledger: lazy(() => import("./pages/LedgerPage")),
  entry: lazy(() => import("./pages/EntryPage")),
  stock: lazy(() => import("./pages/StockPage")),
  expense: lazy(() => import("./pages/ExpensePage")),
  budget: lazy(() => import("./pages/BudgetPage")),
  trend: lazy(() => import("./pages/TrendPage")),
  ca: lazy(() => import("./pages/CaPage")),
  tags: lazy(() => import("./pages/TagsPage")),
  queue: lazy(() => import("./pages/QueuePage")),
  me: lazy(() => import("./pages/MePage")),
};

/**
 * 未匹配路由 —— 客户端兜底。
 *
 * ⚠️ 这与「服务端对缺失资源返回 404」是两件事（deploy-topology §10.4 第 3 项要实测的是后者）。
 *    Pages 在无顶层 404.html 时把未匹配路径交给 index.html（§8.2），
 *    到这里再落成一个明确的「没有这个页面」。
 */
function NotFoundPage() {
  return (
    <section className="page-stub">
      <h1 className="page-stub__title">没有这个页面</h1>
      <p className="page-stub__todo">
        <Link to="/">回首页</Link>
      </p>
    </section>
  );
}

export default function App() {
  const Login = PAGES.login;

  return (
    <BrowserRouter>
      <Routes>
        {/* `login` 是唯一不带外壳的页面（未认证入口，没有底栏的意义） */}
        <Route
          path="/login"
          element={
            <Suspense fallback={<p className="route-fallback">正在加载…</p>}>
              <Login />
            </Suspense>
          }
        />

        {/* 其余 11 页共用导航外壳 */}
        <Route element={<AppShell />}>
          {SHELL_ROUTES.map((route) => {
            const Page = PAGES[route.key];
            return <Route key={route.key} path={route.path} element={<Page />} />;
          })}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
