import PageStub from "./PageStub";

/** 除权确认（路由键 `ca`）—— 契约落点：frontend-ia.md §3.2 ⑨ */
export default function CaPage() {
  return (
    <PageStub
      title="除权确认"
      routeKey="ca"
      contract="frontend-ia.md §3.2 ⑨"
      watchOut={'「已忽略」也是必须记住的决定；分红只提示不写库（红利税），文案须含「采纳只解决送转那一半」。'}
    />
  );
}
