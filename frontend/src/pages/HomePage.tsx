import PageStub from "./PageStub";

/** 首页（路由键 `home`）—— 契约落点：frontend-ia.md §3.2 ② */
export default function HomePage() {
  return (
    <PageStub
      title="首页"
      routeKey="home"
      contract="frontend-ia.md §3.2 ②"
      watchOut={'运行状态卡的「上次成功运行」取自 cron_run，必须按 task 分别问（行情与除权是同一 scheduled_at 下的两行心跳），不得取全局最大。'}
    />
  );
}
