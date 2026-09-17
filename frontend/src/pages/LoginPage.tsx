import PageStub from "./PageStub";

/** 登录（路由键 `login`）—— 契约落点：frontend-ia.md §3.2 ① */
export default function LoginPage() {
  return (
    <PageStub
      title="登录"
      routeKey="login"
      contract="frontend-ia.md §3.2 ①"
      watchOut={'没有注册入口 —— /api/register 端点不存在，不是被禁用；登录失败不区分「用户不存在」与「密码错」。'}
    />
  );
}
