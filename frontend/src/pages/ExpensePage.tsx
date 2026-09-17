import PageStub from "./PageStub";

/** 支出分析（路由键 `expense`）—— 契约落点：frontend-ia.md §3.2 ⑥ */
export default function ExpensePage() {
  return (
    <PageStub
      title="支出分析"
      routeKey="expense"
      contract="frontend-ia.md §3.2 ⑥"
      watchOut={'不做多维矩阵，分组轴恒为三选一；表格必须含虚拟行「未细分」与「未指定对象」桶。'}
    />
  );
}
