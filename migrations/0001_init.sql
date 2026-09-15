-- ============================================================================
-- 家庭财务管理系统 · D1 初始化 schema
-- ----------------------------------------------------------------------------
-- 文件：migrations/0001_init.sql
-- 生成依据：决策票 #14 «D1 schema 与索引定稿»
--           （其上游：#2 #3 #4 #5 #6 #7 #8 #13，全部已关闭）
-- 设计说明：docs/specs/d1-schema.md
-- 可复跑验证：docs/verification/d1-schema-probe.py / .out.txt
--
-- 单位约定（全库统一，勿在实现里另立）：
--   金额 / 每股价格  →  整数「分」      列名后缀 _cents
--   每股派息         →  整数「微元」    列名后缀 _micro（分与厘都会失真）
--   股本比例         →  整数「万分比」  列名后缀 _ppm（10送3 → 3000）
--   时间戳           →  整数 UTC 秒     （例外：cron_run.scheduled_at 为 UTC 毫秒，
--                                        因其来源 controller.scheduledTime 本身是毫秒）
--   业务日 / 周期键  →  TEXT，中国标准时间口径（YYYY-MM-DD / YYYY-Www / YYYY-MM / YYYY）
--
-- 时区纪律：本文件不出现 datetime() / localtime()。周期边界一律由应用层
--           按 Asia/Shanghai 算成 UTC 整数区间后再传 SQL（决策票 #6 R4）。
--
-- 生效前提：D1 默认开启外键强制（官方原文见 docs/specs/d1-schema.md §6.1），
--           本文件的建表顺序已按依赖排列，无需 PRAGMA defer_foreign_keys。
-- ============================================================================


-- ============================================================================
-- 1. 主体
-- ============================================================================

-- 成员即登录身份，系统恰有 2 位（决策票 #2）。凭据列不在此表，见「未决缝」说明。
CREATE TABLE member (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,                                  -- UTC 秒
  CHECK (length(trim(name)) > 0)
);

-- 「恰 2 位」是领域事实，不是配置项。
CREATE TRIGGER trg_member_limit_ins
BEFORE INSERT ON member
WHEN (SELECT COUNT(*) FROM member) >= 2
BEGIN
  SELECT RAISE(ABORT, 'member: 本系统恰有 2 位成员，不再新增');
END;

-- 成员不可删除：Entry / 持仓版本的归属恒指向它。
CREATE TRIGGER trg_member_no_delete
BEFORE DELETE ON member
BEGIN
  SELECT RAISE(ABORT, 'member: 成员不可删除');
END;


-- ============================================================================
-- 2. 标签（混合式：两级类别树 + 平铺对象标签；同一实体以 kind 区分）
-- ============================================================================

CREATE TABLE tag (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('category','object')),
  parent_id      INTEGER REFERENCES tag(id) ON DELETE RESTRICT,
  name           TEXT    NOT NULL,
  color          TEXT,                                          -- 可选，仅类别组用；格式未定盘故不约束
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_builtin     INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  archived_at    INTEGER,                                       -- UTC 秒；NULL = 未归档
  merged_into_id INTEGER REFERENCES tag(id) ON DELETE RESTRICT, -- 「已并入」映射；NULL = 未合并
  created_at     INTEGER NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

-- 层级硬限：类别标签至多两级；对象标签不得有父。CHECK 无法跨行，故用触发器。
CREATE TRIGGER trg_tag_shape_ins
BEFORE INSERT ON tag
WHEN (NEW.kind = 'object' AND NEW.parent_id IS NOT NULL)
  OR (NEW.kind = 'category' AND NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tag p
        WHERE p.id = NEW.parent_id AND p.kind = 'category' AND p.parent_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'tag: 对象标签不得有父；类别标签的父必须是根类别（两级硬限）');
END;

-- 改名 / 换组 / 改类型 一律过同一道闸；且「有子节点者不得再获得父」堵住变相三级。
CREATE TRIGGER trg_tag_shape_upd
BEFORE UPDATE OF kind, parent_id ON tag
WHEN (NEW.kind = 'object' AND NEW.parent_id IS NOT NULL)
  OR (NEW.kind = 'category' AND NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tag p
        WHERE p.id = NEW.parent_id AND p.kind = 'category' AND p.parent_id IS NULL))
  OR (NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM tag c WHERE c.parent_id = NEW.id))
  OR (NEW.kind <> OLD.kind AND EXISTS (SELECT 1 FROM tag c WHERE c.parent_id = NEW.id))
BEGIN
  SELECT RAISE(ABORT, 'tag: 违反两级硬限（父必须为根类别 / 有子节点者不得有父 / 有子节点者不得改类型）');
END;

-- 默认标签完全不可变：不可改名、移动、归档、删除、合并、改类型。
CREATE TRIGGER trg_tag_builtin_upd
BEFORE UPDATE ON tag
WHEN OLD.is_builtin = 1 AND (
     NEW.name           IS NOT OLD.name
  OR NEW.parent_id      IS NOT OLD.parent_id
  OR NEW.kind           IS NOT OLD.kind
  OR NEW.archived_at    IS NOT OLD.archived_at
  OR NEW.merged_into_id IS NOT OLD.merged_into_id
  OR NEW.is_builtin     IS NOT 1
  OR NEW.color          IS NOT OLD.color
  OR NEW.sort_order     IS NOT OLD.sort_order
)
BEGIN
  SELECT RAISE(ABORT, 'tag: 默认标签完全不可变');
END;

CREATE TRIGGER trg_tag_builtin_del
BEFORE DELETE ON tag
WHEN OLD.is_builtin = 1
BEGIN
  SELECT RAISE(ABORT, 'tag: 默认标签不可删除');
END;

-- 「删除仅限零历史引用」由外键 RESTRICT 承担（entry.category_tag_id / entry_object.tag_id）。


-- ============================================================================
-- 3. 记账（只记支出；每笔单归属一位成员；1 类别 + 0~4 对象）
-- ============================================================================

CREATE TABLE entry (
  id              INTEGER PRIMARY KEY,
  member_id       INTEGER NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  category_tag_id INTEGER NOT NULL REFERENCES tag(id)    ON DELETE RESTRICT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  occurred_at     INTEGER NOT NULL,                             -- 发生时间，UTC 秒；不可指向未来（应用层闸）
  biz_date        TEXT    NOT NULL,                             -- 东八区 YYYY-MM-DD，供时间趋势轴分组
  created_at      INTEGER NOT NULL,                             -- 技术列（录入时刻，UTC 秒）
  CHECK (biz_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 冗余列必须真的是 occurred_at 的东八区日期，杜绝写入侧算错
  CHECK (biz_date = date(occurred_at, 'unixepoch', '+8 hours'))
);

CREATE TABLE entry_object (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag(id)   ON DELETE RESTRICT,
  PRIMARY KEY (entry_id, tag_id)
);

-- 类别必须是类别标签（外键只保证「存在」，不保证「类型对」）。
CREATE TRIGGER trg_entry_cat_ins
BEFORE INSERT ON entry
WHEN NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.category_tag_id AND t.kind = 'category')
BEGIN
  SELECT RAISE(ABORT, 'entry: category_tag_id 必须指向类别标签');
END;

CREATE TRIGGER trg_entry_cat_upd
BEFORE UPDATE OF category_tag_id ON entry
WHEN NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.category_tag_id AND t.kind = 'category')
BEGIN
  SELECT RAISE(ABORT, 'entry: category_tag_id 必须指向类别标签');
END;

-- 对象必须是对象标签，且一笔至多 4 个。
CREATE TRIGGER trg_entry_object_ins
BEFORE INSERT ON entry_object
WHEN NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.tag_id AND t.kind = 'object')
BEGIN
  SELECT RAISE(ABORT, 'entry_object: tag_id 必须指向对象标签');
END;

CREATE TRIGGER trg_entry_object_limit
BEFORE INSERT ON entry_object
WHEN (SELECT COUNT(*) FROM entry_object eo WHERE eo.entry_id = NEW.entry_id) >= 4
BEGIN
  SELECT RAISE(ABORT, 'entry_object: 一笔 Entry 至多 4 个对象标签');
END;

CREATE TRIGGER trg_entry_object_upd
BEFORE UPDATE OF entry_id, tag_id ON entry_object
WHEN NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.tag_id AND t.kind = 'object')
  OR (NEW.entry_id <> OLD.entry_id
      AND (SELECT COUNT(*) FROM entry_object eo WHERE eo.entry_id = NEW.entry_id) >= 4)
BEGIN
  SELECT RAISE(ABORT, 'entry_object: 目标必须是对象标签，且目标 Entry 的对象数不得超过 4');
END;


-- ============================================================================
-- 4. 预算（挂类别标签；家庭共享单值；按生效区间版本化）
-- ============================================================================
--
-- 一行 = 一个生效版本。同一「挂载对象 × 周期」的多行构成版本序列；
-- 「当期适用版本」= effective_from <= 当期起始日 中 effective_from 最大者。
-- 改预算自下一期生效 ⇒ 应用层把 effective_from 写成下一期起始日。
-- 「停用」（标签归档 / 合并）是 tag 状态的派生，不落列 —— 故天然可逆。

CREATE TABLE budget (
  id             INTEGER PRIMARY KEY,
  scope          TEXT    NOT NULL CHECK (scope IN ('tag','household')),
  tag_id         INTEGER REFERENCES tag(id) ON DELETE CASCADE,  -- 零引用删除标签 ⇒ 级联删全部版本
  period_type    TEXT    NOT NULL CHECK (period_type IN ('week','month','year')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  threshold_ppm  INTEGER NOT NULL DEFAULT 800000 CHECK (threshold_ppm > 0),  -- 默认 80%
  effective_from TEXT    NOT NULL,                              -- CST 日期 YYYY-MM-DD
  created_at     INTEGER NOT NULL,
  CHECK ((scope = 'tag'       AND tag_id IS NOT NULL)
      OR (scope = 'household' AND tag_id IS NULL)),
  CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

-- 版本唯一性：**必须用两条部分索引**——SQLite 的唯一约束对 NULL 完全无效，
-- 单条 UNIQUE(tag_id, period_type, effective_from) 挡不住家庭总预算（tag_id IS NULL）的重复。
CREATE UNIQUE INDEX ux_budget_tag_version
  ON budget(tag_id, period_type, effective_from) WHERE tag_id IS NOT NULL;
CREATE UNIQUE INDEX ux_budget_household_version
  ON budget(period_type, effective_from) WHERE tag_id IS NULL;

CREATE TRIGGER trg_budget_cat_ins
BEFORE INSERT ON budget
WHEN NEW.tag_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.tag_id AND t.kind = 'category')
BEGIN
  SELECT RAISE(ABORT, 'budget: 只能挂在类别标签上');
END;

CREATE TRIGGER trg_budget_cat_upd
BEFORE UPDATE OF tag_id ON budget
WHEN NEW.tag_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM tag t WHERE t.id = NEW.tag_id AND t.kind = 'category')
BEGIN
  SELECT RAISE(ABORT, 'budget: 只能挂在类别标签上');
END;

-- 提醒状态：**事件记录**，不是派生汇总（无法从明细重算，故与「不建汇总表」不冲突）。
-- 一行 = 「某版本 × 某周期 × 某档位」已提醒过一次。跨档补齐靠它：Cron 漏跑后，
-- 下次运行把「已达阈值但无记录」的档位补发，档位不会永久丢失（决策票 #5 Q5）。
-- 主键以 period_key 打头：唯一的读形态是「取当期全部提醒状态」（一次 Cron 一次）。
-- 代价——删预算时按 budget_id 级联要走全扫；该表每期至多数十行，可接受（见文档 §5.3）。
CREATE TABLE budget_alert_state (
  period_key     TEXT    NOT NULL,          -- '2026-W38' / '2026-09' / '2026'
  budget_id      INTEGER NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  tier           TEXT    NOT NULL CHECK (tier IN ('warning','overspend')),
  consumed_cents INTEGER NOT NULL,          -- 触发时的消耗快照（仅用于展示/排错）
  reminded_at    INTEGER NOT NULL,          -- UTC 秒
  PRIMARY KEY (period_key, budget_id, tier)
);


-- ============================================================================
-- 5. 汇报与运行心跳（报告 = 视图，不落任何报告快照表）
-- ============================================================================

-- 推送 = 不可逆的发送动作 ⇒ 必须幂等。业务幂等锚 = (类型, 周期键, 通道)。
CREATE TABLE report_delivery (
  id             INTEGER PRIMARY KEY,
  report_type    TEXT    NOT NULL CHECK (report_type IN ('weekly','monthly')),
  period_key     TEXT    NOT NULL,          -- 周 'YYYY-Www' / 月 'YYYY-MM'
  channel        TEXT    NOT NULL,          -- 通道枚举见 docs/specs/d1-schema.md §7（暂不约束）
  data_cutoff_at INTEGER NOT NULL,          -- 正文标注的「数据截至」，UTC 秒
  status         TEXT    NOT NULL CHECK (status IN ('sent','failed')),
  detail         TEXT,
  created_at     INTEGER NOT NULL,          -- 技术列（写入时刻，UTC 秒）
  UNIQUE (report_type, period_key, channel)
);

-- 运行心跳：前端据此展示「上次成功运行」。行情与除权是两件独立的事，各写各的
-- 成败 ⇒ 同一 scheduled_at 下会有两行不同 task（决策票 #13 R9）。
CREATE TABLE cron_run (
  id            INTEGER PRIMARY KEY,
  task          TEXT    NOT NULL,           -- 建议集见 docs/specs/d1-schema.md §7（暂不约束）
  scheduled_at  INTEGER NOT NULL,           -- ⚠️ UTC **毫秒**（来源 controller.scheduledTime）
  period_key    TEXT,                       -- 仅推送类任务有
  started_at    INTEGER NOT NULL,           -- UTC 秒
  finished_at   INTEGER,                    -- UTC 秒
  status        TEXT    NOT NULL CHECK (status IN ('ok','skipped','failed')),
  error_message TEXT,
  duration_ms   INTEGER,
  UNIQUE (task, scheduled_at)
);


-- ============================================================================
-- 6. 股票
-- ============================================================================

-- 持仓以生效日期版本化：任意日期的持仓 = 生效日不晚于该日的最后一个版本。
-- 代理主键 id 仅为让 corporate_action.applied_version_id 能落成真外键；
-- 「(成员, 代码, 生效日) 唯一」由 UNIQUE 承担，取数索引形态与实测一致。
CREATE TABLE position_version (
  id               INTEGER PRIMARY KEY,
  member_id        INTEGER NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  code             TEXT    NOT NULL,
  effective_date   TEXT    NOT NULL,                            -- 允许补录（早于登记日），不可指向未来
  qty              INTEGER NOT NULL CHECK (qty >= 0),           -- 0 = 清仓
  cost_price_cents INTEGER NOT NULL CHECK (cost_price_cents >= 0),  -- 分/股；qty=0 时忽略
  recorded_at      INTEGER NOT NULL,                            -- UTC 秒
  UNIQUE (member_id, code, effective_date),
  CHECK (code GLOB 'sh[0-9][0-9][0-9][0-9][0-9][0-9]'
      OR code GLOB 'sz[0-9][0-9][0-9][0-9][0-9][0-9]'),
  CHECK (effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

-- 未交易金额：成员级单值、不版本化、不进任何收益率分母。无行视为 0。
CREATE TABLE member_idle_cash (
  member_id    INTEGER PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  updated_at   INTEGER NOT NULL                                 -- UTC 秒；界面「上次更新于」
);

-- 行情：存未复权（原始）价；prev_close 逐行显式存储、取自当日行情源。
-- 不带 member_id（行情是客观事实）；只建主键，不建日期维度二级索引；
-- 无行 = 无价，不落占位行；只存 close / prev_close（不存开高低量）。
CREATE TABLE quote_daily (
  code            TEXT    NOT NULL,
  trade_date      TEXT    NOT NULL,                             -- CST 业务日 YYYY-MM-DD
  close_cents     INTEGER NOT NULL CHECK (close_cents > 0),     -- 「最新价 == 0」在写入闸就判为解析失败
  prev_close_cents INTEGER CHECK (prev_close_cents IS NULL OR prev_close_cents > 0),
  source          TEXT    NOT NULL CHECK (source IN ('feed','backfill','manual')),
  recorded_at     INTEGER NOT NULL,                             -- UTC 秒
  PRIMARY KEY (code, trade_date),
  -- 手工行只录收盘价、不填昨收（成员无法可靠提供）；权威源行必须带昨收
  CHECK (source = 'manual' OR prev_close_cents IS NOT NULL),
  CHECK (code GLOB 'sh[0-9][0-9][0-9][0-9][0-9][0-9]'
      OR code GLOB 'sz[0-9][0-9][0-9][0-9][0-9][0-9]'),
  CHECK (trade_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

-- 除权除息事件与确认状态。状态按 (成员, 代码, 除权日) 记：同一只股两位成员各自确认。
CREATE TABLE corporate_action (
  member_id            INTEGER NOT NULL REFERENCES member(id) ON DELETE RESTRICT,
  code                 TEXT    NOT NULL,
  ex_date              TEXT    NOT NULL,                        -- 除权除息日；采纳后新版本生效日即此
  plan_category        TEXT    NOT NULL
                                CHECK (plan_category IN ('dividend','bonus','dividend_bonus','rights','other')),
  plan_text            TEXT    NOT NULL,                        -- 方案原文（显示与去重依据）
  cash_per_share_micro INTEGER NOT NULL DEFAULT 0,              -- 微元/股
  bonus_ratio_ppm      INTEGER NOT NULL DEFAULT 0,              -- 万分比
  status               TEXT    NOT NULL CHECK (status IN ('pending','applied','ignored')),
  decided_at           INTEGER,                                 -- UTC 秒
  applied_version_id   INTEGER,                                 -- 软指针，见文件尾「取舍 G」
  PRIMARY KEY (member_id, code, ex_date),
  CHECK (code GLOB 'sh[0-9][0-9][0-9][0-9][0-9][0-9]'
      OR code GLOB 'sz[0-9][0-9][0-9][0-9][0-9][0-9]'),
  CHECK (ex_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (cash_per_share_micro >= 0 AND bonus_ratio_ppm >= 0),
  -- 两种成分可同时存在（如「10送1派43.74元」）⇒ plan_category 必须与数值列自洽
  CHECK ((plan_category IN ('dividend','dividend_bonus')) = (cash_per_share_micro > 0)),
  CHECK ((plan_category IN ('bonus','dividend_bonus'))    = (bonus_ratio_ppm > 0)),
  -- 「采纳」必然有版本指向；未采纳必然没有
  CHECK ((status = 'applied') = (applied_version_id IS NOT NULL)),
  -- 「待确认」必然未决定；已采纳 / 已忽略必然已决定
  CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE TRIGGER trg_ca_applied_ins
BEFORE INSERT ON corporate_action
WHEN NEW.applied_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM position_version pv
       WHERE pv.id = NEW.applied_version_id
         AND pv.member_id = NEW.member_id
         AND pv.code = NEW.code
         AND pv.effective_date = NEW.ex_date)
BEGIN
  SELECT RAISE(ABORT, 'corporate_action: applied_version_id 必须指向同一 (成员,代码) 且生效日 = 除权日的持仓版本');
END;

CREATE TRIGGER trg_ca_applied_upd
BEFORE UPDATE OF applied_version_id, member_id, code, ex_date ON corporate_action
WHEN NEW.applied_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM position_version pv
       WHERE pv.id = NEW.applied_version_id
         AND pv.member_id = NEW.member_id
         AND pv.code = NEW.code
         AND pv.effective_date = NEW.ex_date)
BEGIN
  SELECT RAISE(ABORT, 'corporate_action: applied_version_id 必须指向同一 (成员,代码) 且生效日 = 除权日的持仓版本');
END;

-- 撤销 = 删掉那条持仓版本。触发器把「状态回置 pending + 清空指针」一并做完，
-- 使撤销塌缩成一步，同时保证上面的 status ⇔ applied_version_id 约束始终成立。
CREATE TRIGGER trg_position_version_undo
AFTER DELETE ON position_version
BEGIN
  UPDATE corporate_action
     SET status = 'pending', decided_at = NULL, applied_version_id = NULL
   WHERE applied_version_id = OLD.id;
END;


-- ============================================================================
-- 7. 索引（只建「核心查询会用到」的；每多一个索引，写入按行翻倍计费）
-- ============================================================================
-- 说明：方向来自决策票 #4 的派生要求与 #5/#6/#7/#13 的查询形态，
--       逐条用途与 EXPLAIN 证据见 docs/specs/d1-schema.md §5 与实测输出。

-- 标签树：取某组的子标签
CREATE INDEX ix_tag_parent      ON tag(parent_id);
-- （不建 merged_into_id 索引：合并映射是「拿 tag.id 去查目标」，走 rowid 直查；
--   而 tag 是数十行维度表，任何全扫都是最优计划。实测见说明文档 §5.3。）

-- 记账：三个分组轴各自的首要入口
CREATE INDEX ix_entry_cat_date    ON entry(category_tag_id, biz_date);  -- 类别轴 / 预算消耗
CREATE INDEX ix_entry_member_date ON entry(member_id, biz_date);        -- 成员列 / 手工补录后触发回填
CREATE INDEX ix_entry_biz_date    ON entry(biz_date);                   -- 时间趋势轴（唯一以 biz_date 打头的入口）

-- 对象轴：以对象标签为分组轴时反向取数
CREATE INDEX ix_entry_object_tag  ON entry_object(tag_id, entry_id);

-- 除权事件：回填时的「白名单校验」按 (代码, 除权日) 查、不带成员
-- （主键以 member_id 打头，用不上 ⇒ 必须单建，否则该查询全表扫描）
CREATE INDEX ix_ca_code_date      ON corporate_action(code, ex_date);

-- 预算：取「当期适用版本」时先按周期与生效日收窄
CREATE INDEX ix_budget_period     ON budget(period_type, effective_from);

-- 心跳：前端每次加载都要问「某任务上次成功运行」
CREATE INDEX ix_cron_run_task     ON cron_run(task, scheduled_at);

-- 刻意不建（每条都有实测依据，见说明文档 §5.3）：
--   · quote_daily 的日期维度二级索引 —— 全部已知查询走主键前缀（决策票 #8 R5）
--   · position_version 的额外索引 —— 取数走 (member_id, code, effective_date) 唯一索引（决策票 #7）
--   · tag(merged_into_id) —— 无消费者；合并映射走 rowid 直查，tag 为数十行维度表
--   · tag(path) —— 路径枚举已被 #4 实测否掉，本 schema 不设 path 列


-- ============================================================================
-- 本票的取舍（凡与上游票面字面不同者，逐条列出于此，供复议）
-- ----------------------------------------------------------------------------
-- A. 金额列一律带单位后缀 _cents / _micro / _ppm。上游骨架名（close / prev_close /
--    amount）不带单位，物理名加后缀以免「分 vs 元」在 SQL 里被误读。
-- B. 不设 tag.path 列。#3 建议路径枚举，但 #4 实测 `path LIKE` 在默认配置下全表扫描、
--    并明示「path 仅作展示/排错的冗余字段，不参与查询」。两级下 parent_id 自连接已够，
--    维护 path 还要在改名/移动时同步 → 净负担，故删。
-- C. entry 增技术列 created_at（无对应决策票）。写入路径必然需要录入时刻，
--    且它不是「何时」——「何时」恒指 occurred_at。
-- D. entry.amount_cents > 0（无对应决策票）。「只记支出」下 0 额记录无意义。
-- E. position_version 增代理主键 id + UNIQUE 取代复合主键，使 applied_version_id
--    能落成真外键；#7 R5 的「(成员,代码,生效日) 唯一」由 UNIQUE 完整保留。
-- F. corporate_action 的 kind 扩为 plan_category 五值。上游骨架的 kind ∈
--    {dividend,bonus,rights} 是单值，而 #13 R11 要求「同时表达送转与现金分红两种成分」
--    （实测方案原文形如「10送1.00派43.74元」）⇒ 单值不足以承载，故加 dividend_bonus。
-- G. applied_version_id 为**软指针**（无 REFERENCES）。#13 R12 的撤销顺序是
--    「删版本 → 状态回置 → 清空该列」，硬外键会先挡下第一步；改由 AFTER DELETE
--    触发器代劳，对外表现为一步。
-- H. report_delivery.channel 与 cron_run.task 暂不做 CHECK 枚举。通道选型仍在雾区，
--    task 命名与 #12 的 cron 分派实现绑定；过早锁死会凭空制造一次迁移。
-- I. 时间戳一律 UTC 秒，唯一例外 cron_run.scheduled_at 为 UTC 毫秒（沿用 #6 的决定，
--    因其来源 controller.scheduledTime 即毫秒）。同表混单位是已知隐患，见说明文档 §7。
-- J. budget_alert_state 主键顺序定为 (period_key, budget_id, tier)。上游只要求
--    「记录某预算/某周期/某档位已提醒」，未定顺序；实测以 budget_id 打头会使
--    「取当期全部提醒状态」这条唯一的读路径全表扫描。
-- K. 不建 tag(merged_into_id) 索引。它没有消费者：合并映射是「拿 tag.id 查目标」，
--    走 rowid 直查；tag 是数十行维度表，为它建索引只增加写入成本。
-- L. 账本流水的索引 ix_entry_member_date 在 19 个分析视图中一度无消费者，
--    补上「记账流水页（按成员 + 区间倒序分页）」后命中 —— 保留，但依据是实测而非票面。
--
-- 未决缝：鉴权（#9）与部署拓扑（#12）尚未关闭，故 member 表**不含**凭据/会话列。
--         预期由 migrations/0002_auth.sql 以 member.id 为锚补上，本文件不预判其形状。
-- ============================================================================
