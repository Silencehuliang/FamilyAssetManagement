import PageStub from "./PageStub";

/** 收益趋势（路由键 `trend`）—— 契约落点：frontend-ia.md §3.2 ⑧ */
export default function TrendPage() {
  return (
    <PageStub
      title="收益趋势"
      routeKey="trend"
      contract="frontend-ia.md §3.2 ⑧"
      watchOut={'横轴刻度取交易日（quote_daily 的日期集合），非交易日不补零不插值；持仓变动日的当日盈亏误差须如实标注而非剔除。'}
    />
  );
}
