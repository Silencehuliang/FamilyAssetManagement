import PageStub from "./PageStub";

/** 股票持仓（路由键 `stock`）—— 契约落点：frontend-ia.md §3.2 ⑤ */
export default function StockPage() {
  return (
    <PageStub
      title="股票持仓"
      routeKey="stock"
      contract="frontend-ia.md §3.2 ⑤"
      watchOut={'本页无任何图表；离线降级的双时间戳缺一不可（「行情截至」+「缓存于」）。'}
    />
  );
}
