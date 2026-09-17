import PageStub from "./PageStub";

/** 标签管理（路由键 `tags`）—— 契约落点：frontend-ia.md §3.2 ⑩ */
export default function TagsPage() {
  return (
    <PageStub
      title="标签管理"
      routeKey="tags"
      contract="frontend-ia.md §3.2 ⑩"
      watchOut={'默认集 5 个完全不可变；被历史引用的标签删除会被 RESTRICT 拒绝，只能归档；标签归档即预算停用。'}
    />
  );
}
