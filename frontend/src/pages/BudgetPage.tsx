import PageStub from "./PageStub";

/** 预算（路由键 `budget`）—— 契约落点：frontend-ia.md §3.2 ⑦ */
export default function BudgetPage() {
  return (
    <PageStub
      title="预算"
      routeKey="budget"
      contract="frontend-ia.md §3.2 ⑦"
      watchOut={'「子超支、父未超支」是合法状态（父子各自独立计算、互不扣减）；超支不阻断录入。'}
    />
  );
}
