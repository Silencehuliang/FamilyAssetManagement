/**
 * 存根页面的统一外观。
 *
 * 骨架阶段 12 页都还未实现。**刻意不用「施工中」这类模糊说法** ——
 * 每页要写在屏幕上的东西是：它是哪一页、它的契约落点在哪、
 * 以及它最容易被实现错的那条约束。
 *
 * 这样做的目的：让「未实现」这件事本身不含糊，
 * 同时把契约里最容易读漏的一条摆到实现者眼前（而不是埋在 md 里）。
 */
export interface PageStubProps {
  /** 页面名（与 frontend-ia §3.1 的清单一致） */
  title: string;
  /** 路由键（§3.1 的「路由键」列） */
  routeKey: string;
  /** 契约落点，形如 "frontend-ia.md §3.2 ②" */
  contract: string;
  /** 本页最容易被实现错的约束（来自契约原文，不是我的总结） */
  watchOut?: string;
}

export default function PageStub({
  title,
  routeKey,
  contract,
  watchOut,
}: PageStubProps) {
  return (
    <section className="page-stub">
      <h1 className="page-stub__title">{title}</h1>
      <p className="page-stub__meta">
        路由键 <code>{routeKey}</code> · 契约落点 <code>{contract}</code>
      </p>

      {watchOut !== undefined && (
        <p className="page-stub__watchout">
          <strong>易错点：</strong>
          {watchOut}
        </p>
      )}

      <p className="page-stub__todo">
        骨架阶段 —— 本页尚未实现。页面内容清单见
        <code>docs/specs/frontend-ia.md</code> 的对应小节。
      </p>
    </section>
  );
}
