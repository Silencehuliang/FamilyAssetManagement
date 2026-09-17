import PageStub from "./PageStub";

/** 待同步（路由键 `queue`）—— 契约落点：frontend-ia.md §3.2 ⑪ */
export default function QueuePage() {
  return (
    <PageStub
      title="待同步"
      routeKey="queue"
      contract="frontend-ia.md §3.2 ⑪"
      watchOut={'不设过期丢弃；队列属于设备、不属于会话（登出与改密码都不清空）。'}
    />
  );
}
