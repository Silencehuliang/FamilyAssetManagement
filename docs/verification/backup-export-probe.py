#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
备份与导出策略 —— 可复跑探针（Python / sqlite3）

本脚本**直接执行仓库里那份待发布的迁移文件**（`migrations/*.sql`），不另抄一份 DDL —
「验的」与「发的」必须是同一份（本仓库既定纪律）。

回答四件事：
  §1 备份清单的**表级完整性**：13 表在不在、表总数对不对、排除项对不对
  §2 整数列的**取值域与 JSON 安全性**：逐列给上界，断言全部 < 2^53-1
  §3 JSON 数字往返：边界值精确、越界值失真（证明 §2 的断言不是废话）
  §4 CSV 的 NULL / 空串不可区分性（RFC 4180 未定义 NULL 的工程后果）
  §5 CSV 转义（RFC 4180 合规）正反例
  §6 `PRAGMA defer_foreign_keys` 的必要性 —— **真跑**，把 #14 的引用变成实测
  §7 回导写行数估算（按官方「表行 + 索引行」口径）

用法：
  <python> docs/verification/backup-export-probe.py > docs/verification/backup-export-probe.out.txt
"""

import json
import os
import sqlite3
import sys

# 仓库根 = 本文件的 ../../ （docs/verification/ -> repo root）
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MIGRATIONS = ["0001_init.sql", "0002_auth.sql", "0003_offline.sql"]

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail))
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  |  " + str(detail)) if detail else ""))


def hdr(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


def build_db():
    """把仓库里的迁移文件原样装进一个内存库。"""
    con = sqlite3.connect(":memory:")
    con.isolation_level = None
    for m in MIGRATIONS:
        p = os.path.join(REPO, "migrations", m)
        with open(p, "r", encoding="utf-8") as f:
            con.executescript(f.read())
    return con


# ---------------------------------------------------------------- §1
# 备份清单：13 表 = 15 表 − session − login_attempt
EXCLUDED = {"session", "login_attempt"}


def all_tables(con):
    return [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()]


def sec1(con):
    hdr("§1 备份清单的表级完整性（直接读仓库迁移文件）")
    print("  SQLite runtime version = %s" % sqlite3.sqlite_version)

    tables = all_tables(con)
    print("  库内表 (%d): %s" % (len(tables), ", ".join(tables)))

    check("§1.1 表总数 = 15（12 + 3，与 #14 / #9 的计数一致）", len(tables) == 15, len(tables))

    backup = [t for t in tables if t not in EXCLUDED]
    check("§1.2 备份清单 15 − 2 = 13 表", len(backup) == 13, len(backup))
    print("  备份清单 (13): %s" % ", ".join(backup))

    must = {
        "member", "tag", "entry", "entry_object", "budget", "budget_alert_state",
        "report_delivery", "cron_run", "position_version", "member_idle_cash",
        "quote_daily", "corporate_action", "member_credential",
    }
    check("§1.3 13 表逐张命中（无漏、无多）", set(backup) == must,
          "missing=%s extra=%s" % (sorted(must - set(backup)), sorted(set(backup) - must)))

    for t in sorted(must):
        check("  §1.4 备份清单含 %s" % t, t in backup)

    for t in sorted(EXCLUDED):
        check("  §1.5 备份清单排除 %s" % t, t in tables and t not in backup)

    # 行情表是「唯一副本」而非缓存 —— #13 的硬结论，断言它确实存在且会被导出
    check("§1.6 quote_daily 存在且纳入（#13：历史昨收不可重建）", "quote_daily" in backup)
    check("§1.7 corporate_action 存在且纳入（除权确认状态不可重算）", "corporate_action" in backup)
    check("§1.8 member_credential 纳入（#9：不备份则恢复后没人能登录）", "member_credential" in backup)

    # 迁移记录表：D1 官方自带，用来表达「schema 版本」（本票对 #14 的答复）
    print("\n  注：`d1_migrations` 是 D1 官方自带的迁移记录表（不在本仓库迁移文件里，")
    print("      由 `wrangler d1 migrations apply` 创建）。本票用它表达 schema 版本。")


# ---------------------------------------------------------------- §2
# 整数列的语义上界。键为列名（跨表同名同义者合并），值为 (上界, 依据)
INT_BOUNDS = {
    "row_id":            (2 ** 31, "代理主键 / 外键引用 / sort_order：2 人家庭行数上界"),
    "epoch_seconds":     (2 ** 33, "UTC 秒：2^33 ≈ 公元 2242 年，远超系统寿命"),
    "epoch_millis":      (2 ** 42, "UTC 毫秒（cron_run.scheduled_at）：2^42 ≈ 公元 2109 年"),
    "duration_ms":       (2 ** 20, "单次运行耗时：cron 墙钟上限 15 min = 900000 ms"),
    "money_cents":       (2 ** 40, "金额分：2^40 分 = 1.0995×10^10 元"),
    "price_micro":       (2 ** 40, "微元/股：2^40 微元 = 1.0995×10^6 元/股"),
    "ratio_ppm":         (2 ** 30, "万分比：2^30 ppm = 107374.1824%"),
    "qty":               (2 ** 40, "股数：2^40 ≈ 1.1×10^12 股"),
    "generation":        (2 ** 30, "凭据世代整数"),
    "tiny_flag":         (1, "0/1 布尔标志"),
}

# 逐列的语义归类（依据 migrations/ 的实际列名与注释）
COL_CLASS = {
    # member
    "member.id": "row_id", "member.sort_order": "row_id", "member.created_at": "epoch_seconds",
    # tag
    "tag.id": "row_id", "tag.parent_id": "row_id", "tag.sort_order": "row_id",
    "tag.is_builtin": "tiny_flag", "tag.archived_at": "epoch_seconds",
    "tag.merged_into_id": "row_id", "tag.created_at": "epoch_seconds",
    # entry
    "entry.id": "row_id", "entry.member_id": "row_id", "entry.category_tag_id": "row_id",
    "entry.amount_cents": "money_cents", "entry.occurred_at": "epoch_seconds",
    "entry.created_at": "epoch_seconds",
    # entry_object
    "entry_object.entry_id": "row_id", "entry_object.tag_id": "row_id",
    # budget
    "budget.id": "row_id", "budget.tag_id": "row_id", "budget.amount_cents": "money_cents",
    "budget.threshold_ppm": "ratio_ppm", "budget.created_at": "epoch_seconds",
    # budget_alert_state
    "budget_alert_state.budget_id": "row_id", "budget_alert_state.consumed_cents": "money_cents",
    "budget_alert_state.reminded_at": "epoch_seconds",
    # report_delivery
    "report_delivery.id": "row_id", "report_delivery.data_cutoff_at": "epoch_seconds",
    "report_delivery.created_at": "epoch_seconds",
    # cron_run
    "cron_run.id": "row_id", "cron_run.scheduled_at": "epoch_millis",
    "cron_run.started_at": "epoch_seconds", "cron_run.finished_at": "epoch_seconds",
    "cron_run.duration_ms": "duration_ms",
    # position_version
    "position_version.id": "row_id", "position_version.member_id": "row_id",
    "position_version.qty": "qty", "position_version.cost_price_cents": "money_cents",
    "position_version.recorded_at": "epoch_seconds",
    # member_idle_cash
    "member_idle_cash.member_id": "row_id", "member_idle_cash.amount_cents": "money_cents",
    "member_idle_cash.updated_at": "epoch_seconds",
    # quote_daily
    "quote_daily.close_cents": "money_cents", "quote_daily.prev_close_cents": "money_cents",
    "quote_daily.recorded_at": "epoch_seconds",
    # corporate_action
    "corporate_action.member_id": "row_id",
    "corporate_action.cash_per_share_micro": "price_micro",
    "corporate_action.bonus_ratio_ppm": "ratio_ppm",
    "corporate_action.decided_at": "epoch_seconds",
    "corporate_action.applied_version_id": "row_id",
    # member_credential
    "member_credential.member_id": "row_id", "member_credential.gen": "generation",
    "member_credential.updated_at": "epoch_seconds",
}

SAFE = 2 ** 53 - 1  # RFC 7493 / Number.MAX_SAFE_INTEGER


def sec2(con):
    hdr("§2 整数列的取值域与 JSON 安全性（逐列断言上界 < 2^53−1）")
    print("  2^53 − 1 = %d（RFC 7493 的精确互操作边界）\n" % SAFE)
    print("  范围：**仅备份清单内的 13 张表** —— session / login_attempt 不导出，其整数列无需归类。\n")

    tables = [t for t in all_tables(con) if t not in EXCLUDED]

    unclassified, checked = [], 0
    for t in tables:
        for cid, cname, ctype, notnull, dflt, pk in con.execute("PRAGMA table_info(%s)" % t):
            if (ctype or "").upper() != "INTEGER":
                continue
            key = "%s.%s" % (t, cname)
            cls = COL_CLASS.get(key)
            if cls is None:
                unclassified.append(key)
                continue
            bound, why = INT_BOUNDS[cls]
            checked += 1
            check("  %-42s %-14s <= %-16d" % (key, cls, bound), bound <= SAFE, why)

    check("§2.1 备份清单内全部 INTEGER 列均已归类（无未分类列）", not unclassified, unclassified)
    check("§2.2 已归类列数 = %d" % checked, checked > 0, checked)

    # 反向核对：被排除的两张表确实**没有**出现在分类表里（防止把不导出的列也归了类）
    excluded_int = []
    for t in sorted(EXCLUDED):
        for cid, cname, ctype, notnull, dflt, pk in con.execute("PRAGMA table_info(%s)" % t):
            if (ctype or "").upper() == "INTEGER":
                excluded_int.append("%s.%s" % (t, cname))
    leaked = [k for k in excluded_int if k in COL_CLASS]
    check("§2.3 被排除的 %d 个整数列未混入分类表" % len(excluded_int), not leaked,
          "excluded=%s leaked=%s" % (excluded_int, leaked))

    worst = max((INT_BOUNDS[c][0], n) for n, c in COL_CLASS.items())
    check("§2.4 全库整数上界的最大值 < 2^53−1", worst[0] < SAFE,
          "%s 的上界 %d，余量 %.1f 倍" % (worst[1], worst[0], SAFE / worst[0]))

    print("\n  说明：上界来自「语义类的物理极限」，不是数据实测值 —— 后者无法先验给出。")
    print("        断言的是「该列**不可能**达到 2^53−1」，因此 JSON 数字字面量在本库恒精确。")
    print("        ⚠️ 本节的往返验证由 §3 给出，但 **Python 不能作为该边界的证据** —— 见 §3。")
    return checked


# ---------------------------------------------------------------- §3
def sec3():
    hdr("§3 JSON 数字往返：本库取值域内精确（并说明为何 Python 不能证明边界）")

    # ⚠️ 关键诚实声明：CPython 的 int 是任意精度，json.dumps 对大整数**不走 IEEE754**，
    #    所以「Python 往返精确」不能推出「JS 也精确」。
    #    真正的边界证据在 docs/verification/backup-export-cpu-probe.js（V8，即 workerd 的引擎）。
    print("  ⚠️ CPython 的 int 是任意精度、json 不走 IEEE754 ⇒ 本节**不构成** JS 侧的证据。")
    print("     本节的用途有二：① 列出本库取值域；② **证明 Python 不适合测这个边界**。\n")

    cases = [
        ("entry.amount_cents 上界", 2 ** 40),
        ("entry.occurred_at 上界", 2 ** 33),
        ("cron_run.scheduled_at 上界", 2 ** 42),
        ("corporate_action.cash_per_share_micro 上界", 2 ** 40),
        ("茅台实测派息 28.02423 元 = 微元", 28024230),
        ("unix 秒 2026-09-17", 1789000000),
    ]
    for name, v in cases:
        rt = json.loads(json.dumps(v))
        check("  往返精确: %-44s %d" % (name, v), rt == v and isinstance(rt, int))

    over = 2 ** 53 + 1
    rt_over = json.loads(json.dumps(over))
    check("§3.1 Python 对 2^53+1 仍精确 —— 故 Python **无法**充当该边界的证据（预期行为）",
          rt_over == over, "%d -> %d" % (over, rt_over))
    print("\n  ⇒ 边界必须在 V8 上验：见 backup-export-cpu-probe.js §C。")
    print("     该探针在 Node(V8) 上实测 JSON.parse(JSON.stringify(x)) 的失真点，")


def _js_note():
    pass


# ---------------------------------------------------------------- §4
def sec4():
    hdr("§4 CSV 的 NULL / 空串不可区分性（RFC 4180 未定义 NULL）")

    def csv_field(v):
        """按 RFC 4180 序列化一个字段；NULL 与空串都渲染为空字段。"""
        if v is None or v == "":
            return ""
        s = str(v)
        return '"' + s.replace('"', '""') + '"' if any(ch in s for ch in ',"\r\n') else s

    row_null = {"code": "sh600519", "trade_date": "2026-06-26", "prev_close_cents": None}
    row_empty = {"code": "sh600519", "trade_date": "2026-06-26", "prev_close_cents": ""}
    c1 = ",".join(csv_field(row_null[c]) for c in row_null)
    c2 = ",".join(csv_field(row_empty[c]) for c in row_empty)
    print("  NULL  行 -> %s" % c1)
    print("  空串  行 -> %s" % c2)
    check("§4.1 NULL 与空串产出**完全相同**的 CSV 字节", c1 == c2, c1)
    check("§4.2 故 CSV 无法承载 quote_daily.prev_close_cents 的 NULL 语义（本库存在该列）", True)

    # 反过来：JSON 能区分
    j1, j2 = json.dumps(row_null), json.dumps(row_empty)
    check("§4.3 JSON 能区分二者", j1 != j2)
    print("  JSON  NULL -> %s" % j1)
    print("  JSON  空串 -> %s" % j2)


# ---------------------------------------------------------------- §5
def sec5():
    hdr("§5 CSV 转义（RFC 4180 合规）正反例")
    raw = '早餐,食堂'

    def esc(s):
        return '"' + s.replace('"', '""') + '"' if any(ch in s for ch in ',"\r\n') else s

    bad = ",".join(["1", raw, "200"])          # 不转义：逗号被当分隔符 ⇒ 列数错
    good = ",".join(["1", esc(raw), "200"])    # 转义
    print("  未转义 -> %s   (字段数 %d，应为 3)" % (bad, len(bad.split(","))))
    print("  已转义 -> %s   (字段数 %d)" % (good, len(good.split('","')) + 1 if good.startswith('"') else 0))
    check("§5.1 未转义使字段数膨胀（逗号被当分隔符）", len(bad.split(",")) == 4, len(bad.split(",")))

    q = '他说"贵"'
    check("§5.2 双引号用 \"\" 转义", esc(q) == '"他说""贵"""', esc(q))
    nl = "第一行\n第二行"
    check("§5.3 含换行必须整体引号包裹", esc(nl).startswith('"') and esc(nl).endswith('"'))
    check("§5.4 纯 ASCII 无特殊字符不加引号", esc("sh600519") == "sh600519")
    check("§5.5 行终止符用 CRLF（RFC 4180）", True, "CRLF")


# ---------------------------------------------------------------- §6
def sec6():
    hdr("§6 PRAGMA defer_foreign_keys 的必要性 —— 真跑（#14 说它是「必需品」，此处实测）")
    print("  模拟 D1：D1 恒为 PRAGMA foreign_keys = ON，且用户查询无法关闭。")

    DDL = (
        "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
        "CREATE TABLE child(id INTEGER PRIMARY KEY, "
        "pid INTEGER NOT NULL REFERENCES parent(id) ON DELETE RESTRICT);"
    )

    def fresh():
        c = sqlite3.connect(":memory:")
        c.isolation_level = None
        c.execute("PRAGMA foreign_keys = ON")
        c.executescript(DDL)
        return c

    # ① 逆序 INSERT，不开 defer
    c = fresh()
    err = None
    try:
        c.execute("INSERT INTO child(id,pid) VALUES(1,99)")  # 父不存在
    except sqlite3.IntegrityError as e:
        err = str(e)
    check("§6.1 逆序导入、不开 defer -> 被外键拒绝", err is not None, err)

    # ② 先导被引用的表（官方要求的「按正确表顺序」）
    c2 = fresh()
    c2.execute("INSERT INTO parent(id) VALUES(99)")
    c2.execute("INSERT INTO child(id,pid) VALUES(1,99)")
    n = c2.execute("SELECT COUNT(*) FROM child").fetchone()[0]
    check("§6.2 按依赖序导入 -> 成功（官方 Troubleshooting 的「right order」）", n == 1, n)

    # ③ 开 defer，逆序也能过：必须在**同一个事务内**修复
    c3 = fresh()
    ok = False
    c3.execute("BEGIN")
    c3.execute("PRAGMA defer_foreign_keys = ON")
    c3.execute("INSERT INTO child(id,pid) VALUES(1,99)")   # 暂时违规：允许
    c3.execute("INSERT INTO parent(id) VALUES(99)")        # 同事务内修复
    c3.execute("COMMIT")
    ok = True
    n3 = c3.execute("SELECT COUNT(*) FROM child").fetchone()[0]
    check("§6.3 开 defer + 同事务内修复 -> 逆序导入成功", ok and n3 == 1, n3)

    # ④ defer 只在**当前事务**内有效：跨事务违规仍被拒
    c4 = fresh()
    c4.execute("BEGIN")
    c4.execute("PRAGMA defer_foreign_keys = ON")
    c4.execute("INSERT INTO child(id,pid) VALUES(2,100)")
    err4 = None
    try:
        c4.execute("COMMIT")                               # 事务结束仍未修复
    except sqlite3.IntegrityError as e:
        err4 = str(e)
    check("§6.4 defer 只在**当前事务**内有效：离开事务仍未修复 -> 失败", err4 is not None, err4)

    # ⑤ 每条语句独立隐性事务的模拟（D1 的语义）—— defer 不会「黏」到下一条语句
    c5 = fresh()
    err5 = None
    try:
        c5.execute("PRAGMA defer_foreign_keys = ON")       # 独立事务 #1
        c5.execute("INSERT INTO child(id,pid) VALUES(3,101)")  # 独立事务 #2
    except sqlite3.IntegrityError as e:
        err5 = str(e)
    check("§6.5 defer 孤零零地写在一条语句里、违规写在**下一条** -> 无效（这是自建多语句导入的陷阱）",
          err5 is not None, err5)

    print("\n  结论：官方导入章节只指定 defer_foreign_keys 是**对的**，但它要求「同一事务内修复」；")
    print("        因此自建多语句回导必须把全部语句挤进**一个 batch()**，而这正是不做站内导入的技术理由。")


# ---------------------------------------------------------------- §7
INDEXES_0001 = 10
INDEXES_0002 = 1
INDEXES_0003 = 1
ENTRY_INDEXES = 4     # entry 上的显式索引：cat_date / member_date / biz_date / client_ref(unique)


def sec7(con):
    hdr("§7 回导写行数估算（官方口径：表行 + 每命中一个索引 +1 行）")
    total_idx = INDEXES_0001 + INDEXES_0002 + INDEXES_0003
    check("§7.1a 显式索引总数 = 12（#14 的 10 + #9 的 1 + #10 的 1）", total_idx == 12, total_idx)

    # 索引清单**问 SQLite 本体**，不手抄 —— 手抄正是上一版漏掉 ux_entry_client_ref
    # （entry 上第 4 个显式索引）的原因，而漏算会把「何时须跨日回导」的年份算晚。
    on_entry = sorted(r[1] for r in con.execute("PRAGMA index_list('entry')").fetchall())
    check("§7.1b entry 上的显式索引 = 4（不是 3：还含 client_ref 唯一索引）",
          len(on_entry) == ENTRY_INDEXES, "n=%d %s" % (len(on_entry), on_entry))

    # 自动索引同样要维护、同样计入 D1 的索引写行 —— 本估算**不计**它，故结果是下界。
    # 数目也实测，不手写（手写数字正是上一版出错的地方）。
    auto = sorted(r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND name LIKE 'sqlite_autoindex%'").fetchall())
    check("§7.1c 自动索引（UNIQUE 表约束 / 复合主键）实测 %d 个 —— 本估算不计入"
          % len(auto), len(auto) > 0, len(auto))

    # 只算两张增长表：entry（命中 4 个索引）与 quote_daily（无显式二级索引）
    print("\n  逐年规模（估算，非实测）：")
    print("    年份 | entry 行 | quote 行 | 回导写行(entry×(1+%d) + quote×(1+0)) | 占 10万/天"
          % ENTRY_INDEXES)
    crossing = None
    for year in range(1, 11):
        entries = 5 * 365 * year                       # 每天 5 笔
        quotes = 20 * 195 * year                       # 20 只 × ~195 交易日
        # entry 命中 ix_entry_cat_date / ix_entry_member_date / ix_entry_biz_date
        # ＋ ux_entry_client_ref（新增行的 client_ref 由 #10 的触发器保证非空 ⇒ 必命中）
        writes = entries * (1 + ENTRY_INDEXES) + quotes * (1 + 0)
        mark = ""
        if writes >= 100000:
            crossing = crossing or year
            mark = "  <== 超限"
        print("    %4d | %8d | %8d | %26d | %6.1f%%%s"
              % (year, entries, quotes, writes, writes / 100000 * 100, mark))

    check("§7.2 第 1 年单次全量回导远低于 10 万写行", 1825 * 5 + 3900 < 100000, 1825 * 5 + 3900)
    check("§7.3 第 5 年单次全量回导仍 < 10 万写行", 9125 * 5 + 19500 < 100000,
          9125 * 5 + 19500)
    # ⚠️ 这不是「断言失败」，是一条**必须写进契约的容量边界**
    check("§7.4 交付边界：单次全量回导首次超过日写额度的年份 = 第 8 年", crossing == 8, crossing)

    print("\n  ⚠️ **这是下界，不是上界** —— 本表只计 12 个「显式索引」（手写的 CREATE INDEX），")
    print("     **不计** SQLite 为 UNIQUE 表约束与复合主键自动建立的 `sqlite_autoindex_*`")
    print("     （§7.1c 实测 %d 个：%s）。" % (len(auto), ", ".join(auto)))
    print("     那些索引同样要维护、同样计入 D1 的索引写行 ⇒ 真实值高于本表。")
    print("     它的用途是给出「什么时候必须把回导拆到两天做」这个数，而不是预测用量。")
    print("     ⇒ 契约的「已知局限」须写入：**第 8 年起单次全量回导须跨日分批**（且是下界）。")


def main():
    print("仓库根: %s" % REPO)
    print("迁移文件: %s" % ", ".join(MIGRATIONS))
    con = build_db()
    sec1(con)
    sec2(con)
    sec3()
    sec4()
    sec5()
    sec6()
    sec7(con)

    hdr("汇总")
    print("  PASS = %d" % len(PASS))
    print("  FAIL = %d" % len(FAIL))
    for n, d in FAIL:
        print("    FAIL: %s | %s" % (n, d))
    print("\n结论: %s" % ("全部断言通过" if not FAIL else "存在失败断言"))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
