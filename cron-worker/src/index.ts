/**
 * Cron Worker 入口。
 *
 * 契约落点：
 *   - 部署 / 本地测试：docs/specs/deploy-topology.md §2.1 / §4.3 / §5.2 / §10.4
 *   - cron 表达式定稿：#6 决议「三、Cron 编排」（占用账户配额 4 / 5）
 *   - task 名建议集：docs/specs/d1-schema.md §7.2
 *   - 心跳表三态：migrations/0001_init.sql 的 cron_run（status 已用 CHECK 约束）
 *
 * ⚠️ 本单元**只有 scheduled() 入口，没有 fetch()** —— 它是纯定时任务 Worker，
 *    不对外暴露 HTTP 面。要本地触发请看 §5.2 的 `/cdn-cgi/local/scheduled` 路由
 *    （不是旧写法的 `/__scheduled`）。
 *
 * ⚠️ 骨架阶段四条任务都**尚未实现**（见文件末尾 runTask）。
 */

export interface Env {
  /** 与 Pages 共享的同一个 D1。database_id 两处必须一致 —— deploy-topology §3.1。 */
  DB: D1Database;
}

/**
 * `cron_run.task` 的取值。已按 docs/specs/d1-schema.md §7.2 的建议集固定为字面量联合；
 * 该列**本身没有 CHECK 约束**（表里注释写明「暂不约束」），所以这里的类型就是唯一防线。
 */
export type TaskName =
  | "quote_fetch"
  | "corporate_action"
  | "budget_alert"
  | "report_weekly"
  | "report_monthly";

/**
 * 表达式 → 本次要跑的任务（数组顺序即执行顺序）。
 *
 * 🔴 为什么是「逐字符匹配」而不是先归一化再比：
 *    #6 决议明确要求 `switch (controller.cron)` **逐字符匹配（含空格）**。
 *    表达式是**配置**，一旦被改名 / 改空白，我们要的是**立刻暴露**（落到下面的
 *    未知表达式分支），而不是被 `trim()` / 正则归一化悄悄接住。
 *
 * 🔴 为什么 `30 7 * * MON-FRI` 是两个任务：
 *    #13 R9 —— 行情抓取与除权检测**各占一行心跳**（同一 `scheduled_at` 下两行）。
 *    首页运行状态卡的「上次成功运行」必须**按 task 分别问**、不得取全局最大
 *    （frontend-ia §3.2 ② 的关键约束）。
 */
const DISPATCH: Readonly<Record<string, readonly TaskName[]>> = {
  "30 7 * * MON-FRI": ["quote_fetch", "corporate_action"], // CST 15:30 交易日
  "0 12 * * *": ["budget_alert"],                          // CST 20:00 每日
  "0 0 * * MON": ["report_weekly"],                        // CST 周一 08:00
  "10 0 1 * *": ["report_monthly"],                        // CST 每月 1 日 08:10
};

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const tasks = DISPATCH[controller.cron];

    if (tasks === undefined) {
      // 未知表达式 = 配置与代码脱节。**不静默吞掉**：
      // 不写心跳（因为不知道该写成哪个 task），只把实情打进日志。
      // 排查入口：`wrangler tail` / dashboard 的 Worker 日志。
      console.error(
        `[cron] 未登记的表达式：${JSON.stringify(controller.cron)}；` +
          `已知表达式有 ${JSON.stringify(Object.keys(DISPATCH))}`,
      );
      return;
    }

    for (const task of tasks) {
      await runTask(task, controller, env);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * 任务执行占位。
 *
 * 骨架阶段**四条任务都还没实现**。这里刻意保持「跑得通但不做事」，
 * 好让分派链本身可以被端到端冒烟（`wrangler dev --test-scheduled` 能跑到这里）。
 *
 * 实现时必须补齐（缺一不可）：
 *   1. 写 `cron_run` 心跳 —— `task` / `scheduled_at`（⚠️ 这里要的是 **UTC 毫秒**，
 *      直接取 `controller.scheduledTime`；而 `started_at` / `finished_at` 是 **UTC 秒**，
 *      两种单位不要一把梭）；
 *   2. `status` 三态 —— `ok` / `skipped` / `failed`；`skipped` 专指「源给出了明确的
 *      日期否定 ⇒ 非交易日」（#13 R9），**不是**「没数据」的同义词；
 *   3. 反复失败要能 `error_message` 落地，别只 `console.error`。
 *
 * 落地顺序见地图「建议实施顺序」第 5 步（行情链路）。
 */
async function runTask(
  task: TaskName,
  controller: ScheduledController,
  _env: Env,
): Promise<void> {
  // TODO(#13 行情链路 / #6 报告推送)：把各任务的真实实现接到这里。
  console.log(
    `[cron] 存根命中：task=${task} scheduled_at=${controller.scheduledTime}`,
  );
}
