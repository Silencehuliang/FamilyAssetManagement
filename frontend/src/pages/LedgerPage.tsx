import PageStub from "./PageStub";

/** 流水（路由键 `ledger`）—— 契约落点：frontend-ia.md §3.2 ③ */
export default function LedgerPage() {
  return (
    <PageStub
      title="流水"
      routeKey="ledger"
      contract="frontend-ia.md §3.2 ③"
      watchOut={'三种同步徽标必须可区分：待同步 / 同步失败（附原因）/ 长期未同步（>7 天）。'}
    />
  );
}
