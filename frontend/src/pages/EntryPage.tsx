import PageStub from "./PageStub";

/** 记一笔（路由键 `entry`）—— 契约落点：frontend-ia.md §3.2 ④ */
export default function EntryPage() {
  return (
    <PageStub
      title="记一笔"
      routeKey="entry"
      contract="frontend-ia.md §3.2 ④"
      watchOut={'金额输入框用 type=text + inputmode=decimal，不用 type=number；解析用字符串算整数分，禁用 parseFloat(x) * 100。'}
    />
  );
}
