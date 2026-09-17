import PageStub from "./PageStub";

/** 设置 / 我的（路由键 `me`）—— 契约落点：frontend-ia.md §3.2 ⑫ */
export default function MePage() {
  return (
    <PageStub
      title="设置 / 我的"
      routeKey="me"
      contract="frontend-ia.md §3.2 ⑫"
      watchOut={'关于分区须写明：无注册页 · 无访客链接 · 无权限差异（所有登录成员可见全部数据）。'}
    />
  );
}
