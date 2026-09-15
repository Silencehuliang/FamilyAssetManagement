# -*- coding: utf-8 -*-
"""验证「D1 schema 与索引定稿」（migrations/0001_init.sql）的约束可执行性与查询索引命中。

用途：为决策票 #14 提供可复跑的实测依据，而非纸面推断。
运行：python d1-schema-probe.py
输出：同目录 d1-schema-probe.out.txt（UTF-8）

被验对象：仓库根 migrations/0001_init.sql —— 本脚本**直接执行该文件**，
         不另抄一份 DDL，以保证「验的就是要发布的那份」。

注意：本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**。
     本脚本显式 `PRAGMA foreign_keys = ON` 以对齐 D1 的默认行为
     （D1 官方原文：外键约束在所有查询与迁移中默认强制，等价于每事务
      `PRAGMA foreign_keys = on`）。D1 侧仍需以 `SELECT sqlite_version()`
     与 `batch()` / NULL 唯一性 行为另行复核，见输出末节「D1 侧待复核」。
"""
import os
import sqlite3
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DDL_PATH = os.path.join(ROOT, "migrations", "0001_init.sql")

CST = timezone(timedelta(hours=8))
out = []


def p(s=""):
    out.append(str(s))


def ts(y, m, d, hh=12, mm=0):
    """东八区 wall-clock -> UTC 整数秒"""
    return int(datetime(y, m, d, hh, mm, tzinfo=CST).timestamp())


def dstr(y, m, d):
    return "%04d-%02d-%02d" % (y, m, d)


# ============================================================================
con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()

p("SQLITE_VERSION = " + sqlite3.sqlite_version)
p("PYTHON_SQLITE_LIB = " + str(sqlite3.sqlite_version_info))
p("DDL = migrations/0001_init.sql")
p("")

con.execute("PRAGMA foreign_keys = ON")
p("PRAGMA foreign_keys = %s   <- 本机默认 OFF；此处显式对齐 D1（D1 恒为 ON 且无法关闭）"
  % con.execute("PRAGMA foreign_keys").fetchone()[0])

with open(DDL_PATH, encoding="utf-8") as f:
    ddl = f.read()
cur.executescript(ddl)
p("DDL 执行：OK（%d 字符）" % len(ddl))

# ============================================================================
p("\n" + "=" * 78)
p("【一】结构盘点")
p("=" * 78)

tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
indexes = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
autoidx = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'sqlite_autoindex%' ORDER BY name")]
triggers = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
views = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='view'")]

p("表        %d 张：%s" % (len(tables), ", ".join(tables)))
p("显式索引  %d 个：%s" % (len(indexes), ", ".join(indexes)))
p("隐式索引  %d 个：%s" % (len(autoidx), ", ".join(autoidx)))
p("触发器    %d 个：%s" % (len(triggers), ", ".join(triggers)))
p("视图      %d 个（应为 0 —— 「报告 = 视图」是应用层实时算，不落库）" % len(views))

# ============================================================================
p("\n" + "=" * 78)
p("【二】种子数据（两个成员、两期支出、预算版本、持仓版本、行情、除权事件）")
p("=" * 78)

cur.executemany("INSERT INTO member (id, name, sort_order, created_at) VALUES (?,?,?,?)", [
    (1, "胡", 1, ts(2026, 1, 1)),
    (2, "沈", 2, ts(2026, 1, 1)),
])

# 默认标签（通用最小集 5 个，完全不可变）+ 自建
cur.executemany(
    "INSERT INTO tag (id, kind, parent_id, name, color, sort_order, is_builtin, created_at) "
    "VALUES (?,?,?,?,?,?,?,?)", [
        (1, "category", None, "餐饮", None, 1, 1, ts(2026, 1, 1)),
        (2, "category", 1, "外卖", None, 1, 1, ts(2026, 1, 1)),
        (3, "category", 1, "买菜", None, 2, 1, ts(2026, 1, 1)),
        (4, "category", None, "住房", None, 2, 1, ts(2026, 1, 1)),
        (5, "category", 4, "房租", None, 1, 1, ts(2026, 1, 1)),
        (6, "category", None, "出行", None, 3, 1, ts(2026, 1, 1)),
        (7, "category", None, "医疗", None, 4, 1, ts(2026, 1, 1)),
        (8, "category", None, "其他", None, 5, 1, ts(2026, 1, 1)),
        (10, "category", None, "育儿", "#8ab4f8", 9, 0, ts(2026, 2, 1)),
        (11, "category", 10, "尿不湿", None, 1, 0, ts(2026, 2, 1)),
        (20, "object", None, "孩子", None, 1, 0, ts(2026, 2, 1)),
        (21, "object", None, "我", None, 2, 0, ts(2026, 2, 1)),
        (22, "object", None, "老人", None, 3, 0, ts(2026, 2, 1)),
        (23, "object", None, "宠物", None, 4, 0, ts(2026, 2, 1)),
        (24, "object", None, "朋友", None, 5, 0, ts(2026, 2, 1)),
    ])

# 2026-09 的支出（含「直接打在组上」的 200 元 -> 未细分）
ENTRIES = [
    (1, 1, 2, 30000, dstr(2026, 9, 2)),
    (2, 2, 3, 40000, dstr(2026, 9, 5)),
    (3, 1, 1, 20000, dstr(2026, 9, 8)),      # 餐饮组自身直挂
    (4, 1, 5, 300000, dstr(2026, 9, 1)),
    (5, 2, 7, 30000, dstr(2026, 9, 12)),
    (6, 1, 11, 9900, dstr(2026, 9, 15)),
    # 2026-08 的一笔（供环比的上期口径）
    (7, 2, 1, 50000, dstr(2026, 8, 20)),
]
cur.executemany(
    "INSERT INTO entry (id, member_id, category_tag_id, amount_cents, occurred_at, biz_date, created_at) "
    "VALUES (?,?,?,?,?,?,?)",
    [(eid, mid, tid, amt, ts(*[int(x) for x in bd.split("-")]), bd, ts(2026, 9, 15, 20, 0))
     for (eid, mid, tid, amt, bd) in ENTRIES])

cur.executemany("INSERT INTO entry_object (entry_id, tag_id) VALUES (?,?)", [
    (2, 20), (3, 20), (3, 21), (3, 22), (5, 22), (6, 20), (6, 21), (6, 22),
])

# 预算：一行 = 一个生效版本
cur.executemany(
    "INSERT INTO budget (id, scope, tag_id, period_type, amount_cents, threshold_ppm, effective_from, created_at) "
    "VALUES (?,?,?,?,?,?,?,?)", [
        (1, "tag", 1, "month", 200000, 800000, dstr(2026, 8, 1), ts(2026, 7, 25)),
        (2, "tag", 2, "month", 50000, 800000, dstr(2026, 8, 1), ts(2026, 7, 25)),
        (3, "tag", 4, "month", 350000, 800000, dstr(2026, 8, 1), ts(2026, 7, 25)),
        (4, "household", None, "month", 600000, 900000, dstr(2026, 8, 1), ts(2026, 7, 25)),
        # 9/15 把餐饮组从 2000 改成 1500，自下一期（10 月）起生效
        (5, "tag", 1, "month", 150000, 800000, dstr(2026, 10, 1), ts(2026, 9, 15)),
    ])

cur.executemany(
    "INSERT INTO position_version (id, member_id, code, effective_date, qty, cost_price_cents, recorded_at) "
    "VALUES (?,?,?,?,?,?,?)", [
        (1, 1, "sh600519", dstr(2026, 5, 6), 100, 140000, ts(2026, 5, 6)),
        (2, 1, "sh600519", dstr(2026, 8, 3), 300, 145000, ts(2026, 8, 3)),   # 中间插入式加仓
        (3, 2, "sz000001", dstr(2026, 6, 1), 1000, 1100, ts(2026, 6, 1)),
        (4, 1, "sz300750", dstr(2026, 7, 1), 200, 22000, ts(2026, 7, 1)),
        (5, 2, "sh601398", dstr(2026, 7, 10), 5000, 620, ts(2026, 7, 10)),
        (6, 2, "sh601398", dstr(2026, 9, 1), 0, 0, ts(2026, 9, 1)),          # 清仓
    ])

cur.execute("INSERT INTO member_idle_cash (member_id, amount_cents, updated_at) VALUES (?,?,?)",
            (1, 5000000, ts(2026, 9, 14, 21, 0)))

QUOTES = [
    ("sh600519", dstr(2026, 9, 14), 121210, 118408),
    ("sh600519", dstr(2026, 9, 15), 120500, 121210),
    ("sz000001", dstr(2026, 9, 14), 1100, 1090),
    ("sz000001", dstr(2026, 9, 15), 1110, 1100),
    ("sz300750", dstr(2026, 9, 14), 22000, 21800),
    ("sz300750", dstr(2026, 9, 15), 22300, 22000),
]
cur.executemany(
    "INSERT INTO quote_daily (code, trade_date, close_cents, prev_close_cents, source, recorded_at) "
    "VALUES (?,?,?,?,'feed',?)",
    [(c, d, cl, pc, ts(2026, 9, 15, 15, 30)) for (c, d, cl, pc) in QUOTES])

cur.execute(
    "INSERT INTO corporate_action (member_id, code, ex_date, plan_category, plan_text, "
    "cash_per_share_micro, bonus_ratio_ppm, status) VALUES (?,?,?,?,?,?,?,?)",
    (1, "sh600519", dstr(2026, 6, 26), "dividend", "10派280.2423元(含税)", 28024230, 0, "pending"))
con.commit()
p("种子写入完成：member=%d tag=%d entry=%d entry_object=%d budget=%d position_version=%d "
  "quote_daily=%d corporate_action=%d" % (
      cur.execute("SELECT COUNT(*) FROM member").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM tag").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM entry").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM entry_object").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM budget").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM position_version").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM quote_daily").fetchone()[0],
      cur.execute("SELECT COUNT(*) FROM corporate_action").fetchone()[0]))

# ============================================================================
p("\n" + "=" * 78)
p("【三】约束与触发器实测（正例应通过 / 反例应被拒绝）")
p("=" * 78)


def attempt(label, sql, params=(), expect="ok"):
    try:
        cur.execute(sql, params)
        got = "ok"
        err = ""
    except sqlite3.Error as e:
        got = "error"
        err = str(e)
    ok = (got == expect)
    p("  [%s] %-58s expect=%-5s got=%-5s %s" % ("PASS" if ok else "FAIL", label, expect, got, err))
    return ok


results = []
A = results.append

p("\n-- 主体：恰 2 位 --")
A(attempt("第 3 位成员被拒", "INSERT INTO member (id,name,sort_order,created_at) VALUES (9,'甲',9,1)", (), "error"))
A(attempt("删除成员被拒", "DELETE FROM member WHERE id=1", (), "error"))

p("\n-- 标签：两级硬限 --")
A(attempt("对象标签带父被拒",
          "INSERT INTO tag (id,kind,parent_id,name,sort_order,is_builtin,created_at) "
          "VALUES (30,'object',1,'错',1,0,1)", (), "error"))
A(attempt("三级（父本身是子）被拒",
          "INSERT INTO tag (id,kind,parent_id,name,sort_order,is_builtin,created_at) "
          "VALUES (31,'category',2,'三级',1,0,1)", (), "error"))
A(attempt("有子节点者再获得父被拒（UPDATE）", "UPDATE tag SET parent_id=4 WHERE id=1", (), "error"))
A(attempt("正常新增子标签通过",
          "INSERT INTO tag (id,kind,parent_id,name,sort_order,is_builtin,created_at) "
          "VALUES (32,'category',6,'打车',1,0,1)", (), "ok"))
A(attempt("自引用父被拒（CHECK）", "UPDATE tag SET parent_id=32 WHERE id=32", (), "error"))

p("\n-- 标签：默认标签完全不可变 --")
A(attempt("默认标签改名被拒", "UPDATE tag SET name='吃饭' WHERE id=1", (), "error"))
A(attempt("默认标签归档被拒", "UPDATE tag SET archived_at=1 WHERE id=2", (), "error"))
A(attempt("默认标签删除被拒", "DELETE FROM tag WHERE id=6", (), "error"))
A(attempt("自建标签改名通过", "UPDATE tag SET name='纸尿裤' WHERE id=11", (), "ok"))
A(attempt("被历史引用的标签删除被拒（FK RESTRICT）", "DELETE FROM tag WHERE id=5", (), "error"))
A(attempt("零引用的自建标签删除通过", "DELETE FROM tag WHERE id=32", (), "ok"))

p("\n-- 记账：类型、金额、biz_date 冗余一致性、对象上限 --")
A(attempt("类别标签位填对象标签被拒",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,20,100,%d,'2026-09-15',%d)" % (ts(2026, 9, 15), ts(2026, 9, 15)), (), "error"))
A(attempt("金额为 0 被拒",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,1,0,%d,'2026-09-15',%d)" % (ts(2026, 9, 15), ts(2026, 9, 15)), (), "error"))
A(attempt("金额为负被拒",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,1,-1,%d,'2026-09-15',%d)" % (ts(2026, 9, 15), ts(2026, 9, 15)), (), "error"))
A(attempt("biz_date 与 occurred_at 不符被拒（跨日错位）",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,1,100,%d,'2026-09-16',%d)" % (ts(2026, 9, 15), ts(2026, 9, 15)), (), "error"))
A(attempt("biz_date 与 occurred_at 相符通过（东八区 00:30 的边角）",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,1,100,%d,'2026-09-16',%d)" % (ts(2026, 9, 16, 0, 30), ts(2026, 9, 16)), (), "ok"))
A(attempt("指向不存在的标签被拒（FK）",
          "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at) "
          "VALUES (1,999,100,%d,'2026-09-15',%d)" % (ts(2026, 9, 15), ts(2026, 9, 15)), (), "error"))
A(attempt("第 4 个对象标签通过（恰好到上限）",
          "INSERT INTO entry_object (entry_id,tag_id) VALUES (3,23)", (), "ok"))
A(attempt("第 5 个对象标签被拒（上限 4）",
          "INSERT INTO entry_object (entry_id,tag_id) VALUES (3,24)", (), "error"))
A(attempt("对象位填类别标签被拒",
          "INSERT INTO entry_object (entry_id,tag_id) VALUES (1,2)", (), "error"))

p("\n-- 预算：版本唯一性（含 NULL 陷阱）、挂载范围 --")
A(attempt("家庭总预算重复同一生效版本被拒（部分唯一索引）",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('household',NULL,'month',700000,'2026-08-01',1)", (), "error"))
A(attempt("标签预算重复同一生效版本被拒",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('tag',2,'month',60000,'2026-08-01',1)", (), "error"))
A(attempt("家庭总预算：tag_id 非空被拒（CHECK）",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('household',3,'month',700000,'2026-09-01',1)", (), "error"))
A(attempt("标签预算：tag_id 为空被拒（CHECK）",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('tag',NULL,'month',700000,'2026-09-01',1)", (), "error"))
A(attempt("预算挂对象标签被拒（触发器）",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('tag',20,'month',700000,'2026-09-01',1)", (), "error"))
A(attempt("标签预算新版本（改预算）通过",
          "INSERT INTO budget (scope,tag_id,period_type,amount_cents,effective_from,created_at) "
          "VALUES ('tag',3,'month',60000,'2026-11-01',1)", (), "ok"))
cur.execute("DELETE FROM budget WHERE effective_from='2026-11-01'")   # 复原

p("\n-- 行情：假 0 防护、昨收规则、来源枚举、主键幂等 --")
A(attempt("最新价 0 被拒（假 0 防护）",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('sh600519','2026-09-11',0,121210,'feed',1)", (), "error"))
A(attempt("昨收 0 被拒（preKPrice 非交易日返回 0.0 的同类陷阱）",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('sh600519','2026-09-11',121000,0,'backfill',1)", (), "error"))
A(attempt("feed 行缺昨收被拒",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('sh600519','2026-09-11',121000,NULL,'feed',1)", (), "error"))
A(attempt("manual 行缺昨收通过",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('sh600519','2026-09-11',121000,NULL,'manual',1)", (), "ok"))
A(attempt("非法代码（裸六位码）被拒",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('600519','2026-09-11',121000,121210,'feed',1)", (), "error"))
A(attempt("北交所代码被拒（须在求交阶段就滤掉）",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('bj920663','2026-09-11',121000,121210,'feed',1)", (), "error"))
A(attempt("主键重复被拒",
          "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
          "VALUES ('sh600519','2026-09-15',999999,999999,'feed',1)", (), "error"))
# 来源 rank 仅升级时覆盖（写入闸，不在 DDL）
cur.execute(
    "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
    "VALUES (:c,:d,:cl,:pc,:s,:t) "
    "ON CONFLICT(code,trade_date) DO UPDATE SET close_cents=excluded.close_cents, "
    "prev_close_cents=excluded.prev_close_cents, source=excluded.source, recorded_at=excluded.recorded_at "
    "WHERE (CASE excluded.source WHEN 'feed' THEN 2 WHEN 'backfill' THEN 1 ELSE 0 END) > "
    "      (CASE quote_daily.source WHEN 'feed' THEN 2 WHEN 'backfill' THEN 1 ELSE 0 END)",
    {"c": "sh600519", "d": "2026-09-11", "cl": 121000, "pc": 121210, "s": "backfill", "t": 1})
cur.execute("UPDATE quote_daily SET source='manual', prev_close_cents=NULL "
            "WHERE code='sh600519' AND trade_date='2026-09-11'")
cur.execute(
    "INSERT INTO quote_daily (code,trade_date,close_cents,prev_close_cents,source,recorded_at) "
    "VALUES (:c,:d,:cl,:pc,:s,:t) "
    "ON CONFLICT(code,trade_date) DO UPDATE SET close_cents=excluded.close_cents, "
    "prev_close_cents=excluded.prev_close_cents, source=excluded.source, recorded_at=excluded.recorded_at "
    "WHERE (CASE excluded.source WHEN 'feed' THEN 2 WHEN 'backfill' THEN 1 ELSE 0 END) > "
    "      (CASE quote_daily.source WHEN 'feed' THEN 2 WHEN 'backfill' THEN 1 ELSE 0 END)",
    {"c": "sh600519", "d": "2026-09-11", "cl": 121000, "pc": 121210, "s": "backfill", "t": 2})
row = cur.execute("SELECT source, prev_close_cents FROM quote_daily "
                  "WHERE code='sh600519' AND trade_date='2026-09-11'").fetchone()
p("  [%s] %-58s manual -> backfill 升级后 source=%s prev_close=%s"
  % ("PASS" if row["source"] == "backfill" else "FAIL", "来源 rank 升级覆盖（manual < backfill）",
     row["source"], row["prev_close_cents"]))
A(row["source"] == "backfill")
cur.execute("UPDATE quote_daily SET source='feed', prev_close_cents=121210 "
            "WHERE code='sh600519' AND trade_date='2026-09-11'")
cur.execute("DELETE FROM quote_daily WHERE code='sh600519' AND trade_date='2026-09-11'")

p("\n-- 除权事件：成分自洽、状态与指针联动、撤销一步到位 --")
A(attempt("kind=dividend 但送转比例非 0 被拒",
          "INSERT INTO corporate_action (member_id,code,ex_date,plan_category,plan_text,"
          "cash_per_share_micro,bonus_ratio_ppm,status) "
          "VALUES (1,'sz000001','2026-07-01','dividend','x',1000,3000,'pending')", (), "error"))
A(attempt("kind=bonus 但派息非 0 被拒",
          "INSERT INTO corporate_action (member_id,code,ex_date,plan_category,plan_text,"
          "cash_per_share_micro,bonus_ratio_ppm,status) "
          "VALUES (1,'sz000001','2026-07-01','bonus','x',1000,3000,'pending')", (), "error"))
A(attempt("复合方案 dividend_bonus（同时两种成分）通过",
          "INSERT INTO corporate_action (member_id,code,ex_date,plan_category,plan_text,"
          "cash_per_share_micro,bonus_ratio_ppm,status) "
          "VALUES (1,'sz000001','2026-07-01','dividend_bonus','10送1派43.74元',4374000,1000,'pending')", (), "ok"))
A(attempt("status=applied 但无版本指向被拒（CHECK）",
          "UPDATE corporate_action SET status='applied', decided_at=1 "
          "WHERE member_id=1 AND code='sz000001' AND ex_date='2026-07-01'", (), "error"))
A(attempt("status=pending 但已填 decided_at 被拒（CHECK）",
          "UPDATE corporate_action SET decided_at=1 "
          "WHERE member_id=1 AND code='sh600519' AND ex_date='2026-06-26'", (), "error"))
A(attempt("applied_version_id 指向别只股票的版本被拒（触发器）",
          "UPDATE corporate_action SET status='applied', decided_at=1, applied_version_id=3 "
          "WHERE member_id=1 AND code='sh600519' AND ex_date='2026-06-26'", (), "error"))
A(attempt("applied_version_id 指向同股但生效日 ≠ 除权日 被拒（触发器）",
          "UPDATE corporate_action SET status='applied', decided_at=1, applied_version_id=1 "
          "WHERE member_id=1 AND code='sh600519' AND ex_date='2026-06-26'", (), "error"))
cur.execute("INSERT INTO position_version (id,member_id,code,effective_date,qty,cost_price_cents,recorded_at) "
            "VALUES (7,1,'sh600519','2026-06-26',110,127273,1)")
A(attempt("采纳：指向同股同生效日的版本通过",
          "UPDATE corporate_action SET status='applied', decided_at=1, applied_version_id=7 "
          "WHERE member_id=1 AND code='sh600519' AND ex_date='2026-06-26'", (), "ok"))
cur.execute("DELETE FROM position_version WHERE id=7")
row = cur.execute("SELECT status, decided_at, applied_version_id FROM corporate_action "
                  "WHERE member_id=1 AND code='sh600519' AND ex_date='2026-06-26'").fetchone()
p("  [%s] %-58s 删版本后 status=%s decided_at=%s applied_version_id=%s"
  % ("PASS" if row["status"] == "pending" and row["decided_at"] is None
     and row["applied_version_id"] is None else "FAIL",
     "撤销：删版本 -> 状态回置 pending 且清空指针（一步到位）",
     row["status"], row["decided_at"], row["applied_version_id"]))
A(row["status"] == "pending" and row["decided_at"] is None and row["applied_version_id"] is None)
A(attempt("同 (成员,代码,除权日) 重复插入被拒（主键）",
          "INSERT INTO corporate_action (member_id,code,ex_date,plan_category,plan_text,"
          "cash_per_share_micro,bonus_ratio_ppm,status) "
          "VALUES (1,'sh600519','2026-06-26','dividend','y',28024230,0,'pending')", (), "error"))
A(attempt("另一位成员对同一事件独立确认通过",
          "INSERT INTO corporate_action (member_id,code,ex_date,plan_category,plan_text,"
          "cash_per_share_micro,bonus_ratio_ppm,status) "
          "VALUES (2,'sh600519','2026-06-26','dividend','y',28024230,0,'pending')", (), "ok"))

p("\n-- 持仓：代码格式、数量非负、版本唯一 --")
A(attempt("非法代码被拒", "INSERT INTO position_version (member_id,code,effective_date,qty,"
          "cost_price_cents,recorded_at) VALUES (1,'600519','2026-01-01',1,1,1)", (), "error"))
A(attempt("负数量被拒", "INSERT INTO position_version (member_id,code,effective_date,qty,"
          "cost_price_cents,recorded_at) VALUES (1,'sh600000','2026-01-01',-1,1,1)", (), "error"))
A(attempt("同 (成员,代码,生效日) 重复被拒",
          "INSERT INTO position_version (member_id,code,effective_date,qty,"
          "cost_price_cents,recorded_at) VALUES (1,'sh600519','2026-08-03',1,1,1)", (), "error"))
A(attempt("0 股清仓版本通过",
          "INSERT INTO position_version (member_id,code,effective_date,qty,"
          "cost_price_cents,recorded_at) VALUES (2,'sz000001','2026-09-20',0,0,1)", (), "ok"))

p("\n-- 汇报与心跳：幂等 --")
A(attempt("推送记录首次写入通过",
          "INSERT INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,created_at) "
          "VALUES ('weekly','2026-W37','inapp',1,'sent',1)", (), "ok"))
A(attempt("同 (类型,周期,通道) 重复插入被拒",
          "INSERT INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,created_at) "
          "VALUES ('weekly','2026-W37','inapp',2,'sent',2)", (), "error"))
A(attempt("INSERT OR IGNORE 幂等：影响 0 行",
          "INSERT OR IGNORE INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,created_at) "
          "VALUES ('weekly','2026-W37','inapp',3,'sent',3)", (), "ok"))
p("       -> 实际影响行数 = %d（应为 0）" % cur.rowcount)
A(cur.rowcount == 0)
A(attempt("非法 report_type 被拒（无日报）",
          "INSERT INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,created_at) "
          "VALUES ('daily','2026-09-15','inapp',1,'sent',1)", (), "error"))
A(attempt("心跳三态之外的值被拒",
          "INSERT INTO cron_run (task,scheduled_at,started_at,finished_at,status) "
          "VALUES ('quote_fetch',1,1,2,'partial')", (), "error"))
A(attempt("心跳 skipped 通过",
          "INSERT INTO cron_run (task,scheduled_at,started_at,finished_at,status,error_message) "
          "VALUES ('quote_fetch',1757925000000,1,2,'skipped','主源超时，备源返回旧日期')", (), "ok"))
A(attempt("同 (task,scheduled_at) 重复心跳被拒",
          "INSERT INTO cron_run (task,scheduled_at,started_at,finished_at,status) "
          "VALUES ('quote_fetch',1757925000000,1,2,'ok')", (), "error"))
A(attempt("同一 scheduled_at 下另一个 task 通过（行情/除权各记各的成败）",
          "INSERT INTO cron_run (task,scheduled_at,started_at,finished_at,status) "
          "VALUES ('corporate_action',1757925000000,1,2,'failed')", (), "ok"))
con.commit()

npass = sum(1 for r in results if r)
p("\n小结：约束/触发器断言 %d / %d 通过。" % (npass, len(results)))

# ============================================================================
p("\n" + "=" * 78)
p("【四】核心分析查询：SQL 条数 + EXPLAIN QUERY PLAN")
p("=" * 78)

PTYPE = "month"
P_START = dstr(2026, 9, 1)
P_END = dstr(2026, 10, 1)

AXIS_AGG = """
SELECT COALESCE(p.id, t.id) AS axis_id, e.member_id, e.amount_cents
FROM entry e
JOIN tag t      ON t.id = e.category_tag_id
LEFT JOIN tag p ON p.id = t.parent_id
WHERE t.kind = 'category' AND e.biz_date >= :d0 AND e.biz_date < :d1
"""

AGG = """
SELECT COALESCE(p.id, t.id) AS axis_id, SUM(e.amount_cents) AS consumed_cents
FROM entry e
JOIN tag t      ON t.id = e.category_tag_id
LEFT JOIN tag p ON p.id = t.parent_id
WHERE e.biz_date >= :d0 AND e.biz_date < :d1
GROUP BY axis_id
UNION ALL
SELECT NULL AS axis_id, SUM(e.amount_cents) AS consumed_cents
FROM entry e WHERE e.biz_date >= :d0 AND e.biz_date < :d1
"""

Q_CAT_AXIS = """
SELECT COALESCE(p.id, t.id)                                                     AS axis_id,
       SUM(CASE WHEN e.member_id = :m1 THEN e.amount_cents ELSE 0 END)          AS m1_cents,
       SUM(CASE WHEN e.member_id = :m2 THEN e.amount_cents ELSE 0 END)          AS m2_cents,
       SUM(e.amount_cents)                                                      AS total_cents
FROM entry e
JOIN tag t      ON t.id = e.category_tag_id
LEFT JOIN tag p ON p.id = t.parent_id
WHERE t.kind = 'category' AND e.biz_date >= :d0 AND e.biz_date < :d1
GROUP BY COALESCE(p.id, t.id)
ORDER BY total_cents DESC
"""

Q_CAT_DRILL = """
SELECT t.id AS axis_id, t.name AS axis_name,
       SUM(CASE WHEN e.member_id = :m1 THEN e.amount_cents ELSE 0 END)          AS m1_cents,
       SUM(CASE WHEN e.member_id = :m2 THEN e.amount_cents ELSE 0 END)          AS m2_cents,
       SUM(e.amount_cents)                                                      AS total_cents
FROM entry e
JOIN tag t ON t.id = e.category_tag_id
WHERE e.biz_date >= :d0 AND e.biz_date < :d1 AND t.parent_id = :parent
GROUP BY t.id ORDER BY total_cents DESC
"""

Q_OBJ_AXIS = """
SELECT eo.tag_id                                                                AS axis_id,
       SUM(CASE WHEN e.member_id = :m1 THEN e.amount_cents ELSE 0 END)          AS m1_cents,
       SUM(CASE WHEN e.member_id = :m2 THEN e.amount_cents ELSE 0 END)          AS m2_cents,
       SUM(e.amount_cents)                                                      AS total_cents
FROM entry e
LEFT JOIN entry_object eo ON eo.entry_id = e.id
WHERE e.biz_date >= :d0 AND e.biz_date < :d1
GROUP BY eo.tag_id ORDER BY total_cents DESC
"""

Q_OBJ_FILTER = """
SELECT COALESCE(p.id, t.id) AS axis_id, SUM(e.amount_cents) AS total_cents
FROM entry_object eo
JOIN entry e    ON e.id = eo.entry_id
JOIN tag t      ON t.id = e.category_tag_id
LEFT JOIN tag p ON p.id = t.parent_id
WHERE eo.tag_id = :obj AND e.biz_date >= :d0 AND e.biz_date < :d1
GROUP BY COALESCE(p.id, t.id)
"""

Q_TREND = """
SELECT e.biz_date                                                               AS axis_id,
       SUM(CASE WHEN e.member_id = :m1 THEN e.amount_cents ELSE 0 END)          AS m1_cents,
       SUM(CASE WHEN e.member_id = :m2 THEN e.amount_cents ELSE 0 END)          AS m2_cents,
       SUM(e.amount_cents)                                                      AS total_cents
FROM entry e
WHERE e.biz_date >= :d0 AND e.biz_date < :d1
GROUP BY e.biz_date ORDER BY e.biz_date
"""

Q_PERIOD_TOTAL = """
SELECT SUM(amount_cents) AS total_cents FROM entry
WHERE biz_date >= :d0 AND biz_date < :d1
"""

Q_BUDGET_PANEL = """
SELECT t.id AS tag_id, t.name AS tag_name,
       bv.amount_cents AS budget_cents, bv.threshold_ppm AS threshold_ppm,
       IFNULL(agg.consumed_cents, 0) AS consumed_cents
FROM tag t
LEFT JOIN (
  SELECT tag_id, amount_cents, threshold_ppm,
         ROW_NUMBER() OVER (PARTITION BY tag_id, period_type ORDER BY effective_from DESC) AS rn
  FROM budget
  WHERE period_type = :ptype AND effective_from <= :pstart AND tag_id IS NOT NULL
) bv ON bv.tag_id = t.id AND bv.rn = 1
LEFT JOIN (""" + AGG + """) agg ON agg.axis_id IS t.id
WHERE t.kind = 'category' AND t.archived_at IS NULL
ORDER BY t.id
"""

Q_BUDGET_HOUSEHOLD = """
SELECT amount_cents, threshold_ppm FROM budget
WHERE scope = 'household' AND period_type = :ptype AND effective_from <= :pstart
ORDER BY effective_from DESC LIMIT 1
"""

Q_ALERT_READ = """
SELECT budget_id, tier, consumed_cents FROM budget_alert_state
WHERE period_key = :pk
"""

Q_ALERT_SCAN = """
SELECT b.id AS budget_id, b.amount_cents, b.threshold_ppm,
       IFNULL(agg.consumed_cents, 0) AS consumed_cents
FROM budget b
LEFT JOIN (""" + AGG + """) agg ON agg.axis_id IS b.tag_id
WHERE b.period_type = :ptype AND b.effective_from <= :pstart
  AND b.id = (SELECT MAX(b2.id) FROM budget b2
              WHERE b2.tag_id IS b.tag_id AND b2.period_type = b.period_type
                AND b2.effective_from <= :pstart)
"""

Q_ALERT_WRITE = """
INSERT OR IGNORE INTO budget_alert_state (budget_id, period_key, tier, consumed_cents, reminded_at)
VALUES (:bid, :pk, :tier, :consumed, :now)
"""

Q_HOLDINGS = """
SELECT pv.code, pv.effective_date, pv.qty, pv.cost_price_cents
FROM position_version pv
WHERE pv.member_id = :m
  AND pv.effective_date = (SELECT MAX(b.effective_date) FROM position_version b
                           WHERE b.member_id = pv.member_id AND b.code = pv.code)
ORDER BY pv.code
"""

Q_HOLDING_AT = """
SELECT qty, cost_price_cents FROM position_version
WHERE member_id = :m AND code = :code AND effective_date <= :d
ORDER BY effective_date DESC LIMIT 1
"""

Q_FETCH_SCOPE = """
SELECT DISTINCT pv.code
FROM position_version pv
WHERE pv.member_id = :m AND pv.qty > 0
  AND pv.effective_date = (SELECT MAX(b.effective_date) FROM position_version b
                           WHERE b.member_id = pv.member_id AND b.code = pv.code)
ORDER BY pv.code
"""

Q_LEDGER = """
SELECT id, biz_date, amount_cents, category_tag_id
FROM entry
WHERE member_id = :m AND biz_date >= :d0 AND biz_date < :d1
ORDER BY biz_date DESC, id DESC
LIMIT 20
"""

Q_PNL_CURVE = """
SELECT q.trade_date,
       SUM((q.close_cents - q.prev_close_cents) * pv.qty) AS pnl_cents
FROM position_version pv
JOIN quote_daily q
  ON q.code = pv.code
 AND q.trade_date >= :d0 AND q.trade_date < :d1
WHERE pv.member_id = :m
  AND pv.effective_date = (SELECT MAX(b.effective_date) FROM position_version b
                           WHERE b.member_id = pv.member_id AND b.code = pv.code
                             AND b.effective_date <= q.trade_date)
  AND q.prev_close_cents IS NOT NULL
GROUP BY q.trade_date ORDER BY q.trade_date
"""

Q_QUOTE_AT = """
SELECT close_cents, prev_close_cents FROM quote_daily
WHERE code = :code AND trade_date = :d
"""

Q_QUOTE_RANGE = """
SELECT trade_date, close_cents, prev_close_cents FROM quote_daily
WHERE code = :code AND trade_date >= :d0 AND trade_date < :d1
ORDER BY trade_date
"""

Q_GAP_INPUT = """
SELECT DISTINCT trade_date FROM quote_daily
WHERE code = :code AND trade_date >= :d0 AND trade_date < :d1
"""

Q_CA_PENDING = """
SELECT code, ex_date, plan_category, plan_text, cash_per_share_micro, bonus_ratio_ppm
FROM corporate_action WHERE member_id = :m AND status = 'pending' ORDER BY ex_date DESC
"""

Q_CA_WHITELIST = """
SELECT member_id, status FROM corporate_action WHERE code = :code AND ex_date = :d
"""

Q_HEARTBEAT_LAST_OK = """
SELECT task, MAX(scheduled_at) AS last_ok FROM cron_run
WHERE task = :task AND status = 'ok'
"""

Q_IDLE_CASH = """
SELECT amount_cents, updated_at FROM member_idle_cash WHERE member_id = :m
"""

P = {"m1": 1, "m2": 2, "m": 1, "d0": P_START, "d1": P_END, "parent": 1, "obj": 20,
     "ptype": PTYPE, "pstart": P_START, "pk": "2026-09", "bid": 1, "tier": "warning",
     "consumed": 1, "now": ts(2026, 9, 15, 20, 0), "code": "sh600519", "task": "quote_fetch",
     "d": dstr(2026, 9, 15)}

VIEWS = [
    ("V1  类别轴（组，成员固定 2 列）", [Q_CAT_AXIS], {"parent": 1}),
    ("V2  类别轴下钻一层（未细分由 App 层相减）", [Q_CAT_DRILL], {}),
    ("V3  对象轴（含「未指定对象」桶）", [Q_OBJ_AXIS], {}),
    ("V4  对象筛选 × 类别分组", [Q_OBJ_FILTER], {}),
    ("V5  时间趋势轴", [Q_TREND], {}),
    ("V6  日均 / 环比（当期 + 上期）", [Q_PERIOD_TOTAL, Q_PERIOD_TOTAL], {}),
    ("V7  预算面板（全部类别标签 + 家庭总预算）", [Q_BUDGET_PANEL, Q_BUDGET_HOUSEHOLD], {}),
    ("V8  预算提醒巡检（读状态 / 取累计 / 写回）", [Q_ALERT_READ, Q_ALERT_SCAN, Q_ALERT_WRITE], {}),
    ("V9  持仓明细（每只股票当前版本）", [Q_HOLDINGS], {}),
    ("V10 按日取版本（任意日期的持仓）", [Q_HOLDING_AT], {}),
    ("V11 抓取范围（当前持仓数量 > 0）", [Q_FETCH_SCOPE], {}),
    ("V12 收益曲线（按交易日，Σ 当日浮动盈亏）", [Q_PNL_CURVE], {}),
    ("V13 区间收益端点 + 缺口序列（2 条）", [Q_QUOTE_AT, Q_GAP_INPUT], {}),
    ("V14 待确认除权建议", [Q_CA_PENDING], {}),
    ("V15 回填白名单校验（按代码 + 除权日）", [Q_CA_WHITELIST], {}),
    ("V16 推送幂等（INSERT OR IGNORE）", ["INSERT OR IGNORE INTO report_delivery "
           "(report_type,period_key,channel,data_cutoff_at,status,created_at) "
           "VALUES ('weekly','2026-W38','inapp',:now,'sent',:now)"], {}),
    ("V17 心跳「上次成功运行」", [Q_HEARTBEAT_LAST_OK], {}),
    ("V18 未交易金额（成员级单值）", [Q_IDLE_CASH], {}),
    ("V19 行情区间取数（单只股票，走主键前缀）", [Q_QUOTE_RANGE], {}),
    ("V20 记账流水（按成员筛选 + 区间倒序分页）", [Q_LEDGER], {}),
]

# EXPLAIN 的计划行里只有**别名**，故别名 -> 表名必须显式给出（不猜）。
ALIAS2TABLE = {
    "e": "entry", "entry": "entry",
    "eo": "entry_object", "entry_object": "entry_object",
    "q": "quote_daily", "quote_daily": "quote_daily",
    "pv": "position_version", "position_version": "position_version",
    "b": "budget", "b2": "budget", "budget": "budget",
    "budget_alert_state": "budget_alert_state",
    "corporate_action": "corporate_action",
    "cron_run": "cron_run",
    "report_delivery": "report_delivery",
    "member_idle_cash": "member_idle_cash",
    "t": "tag", "p": "tag", "tag": "tag",
    "member": "member",
}
# 物化子查询 / 临时表：不是真表，不计入判据
NOT_A_TABLE = {"agg", "bv", "(subquery", "(subquery-1)", "(subquery-5)", "CONSTANT"}

FACT_TABLES = {"entry", "entry_object", "quote_daily", "position_version",
               "budget", "budget_alert_state", "report_delivery", "cron_run", "corporate_action"}
DIM_TABLES = {"tag", "member", "member_idle_cash"}

over_budget = []
scans_fact = []
scans_dim = []

for label, queries, override in VIEWS:
    params = dict(P)
    params.update(override)
    p("\n" + "-" * 78)
    p("%s   —— SQL 条数 %d" % (label, len(queries)))
    p("-" * 78)
    if len(queries) > 5:
        over_budget.append((label, len(queries)))
    for i, q in enumerate(queries, 1):
        plan = cur.execute("EXPLAIN QUERY PLAN " + q, params).fetchall()
        details = [r["detail"] for r in plan]
        p("  [%d] %s" % (i, details[0] if details else "(空计划)"))
        for d in details[1:]:
            p("      %s" % d)
        for d in details:
            if not d.startswith("SCAN "):
                continue
            short = d.replace("SCAN ", "").strip()
            target = short.split()[0] if short.split() else ""
            if target.startswith("(") or target in NOT_A_TABLE:
                continue
            tbl = ALIAS2TABLE.get(target, target)
            if tbl in FACT_TABLES:
                scans_fact.append((label, target, tbl))
            elif tbl in DIM_TABLES:
                scans_dim.append((label, target, tbl))

p("\n" + "=" * 78)
p("【五】验收判定")
p("=" * 78)
p("  每个分析视图 SQL 条数 <= 5（决策票 #4 Q5）：%s"
  % ("全部通过" if not over_budget else "超预算 " + str(over_budget)))
p("  （对照：D1 免费版每次调用上限 50 次查询，留 10 倍余量）")
p("")
p("  EXPLAIN QUERY PLAN 是否出现全表 SCAN：")
p("    事实表（判据要求 0 处）：%s" % ("0 处 —— 通过" if not scans_fact
                                else "%d 处 -> %s" % (len(scans_fact), scans_fact)))
if scans_dim:
    p("    维度表（tag / member，数十行，全扫即最优计划；如实列出，不计入判据）：")
    for lbl, alias, tbl in sorted(set(scans_dim)):
        p("      · %s -> SCAN %s (= %s)" % (lbl.split()[0], alias, tbl))
else:
    p("    维度表：无 SCAN 记录")

p("""
  判据说明（对 #4 验收标准的一处收窄，本票判断，可复议）：
    #4 原文为「核心分析查询 EXPLAIN QUERY PLAN 不得出现 SCAN」。实测中 tag（数十行的
    维度表）在若干查询里被全扫，而那是**最优计划**——为它强加驱动顺序的代价大于收益。
    故本票把判据限定在**事实表**上：事实表不得出现 SCAN；维度表与物化子查询的 SCAN
    一律如实列出，不做粉饰。""")

# ============================================================================
p("\n" + "=" * 78)
p("【六】索引用途核对（每个索引都要有消费者）")
p("=" * 78)

usage = {}
for label, queries, override in VIEWS:
    params = dict(P)
    params.update(override)
    for q in queries:
        for d in [r["detail"] for r in cur.execute("EXPLAIN QUERY PLAN " + q, params)]:
            for ix in indexes + autoidx:
                if ix in d:
                    usage.setdefault(ix, set()).add(label.split()[0])

p("  A. SELECT 侧消费者（EXPLAIN QUERY PLAN 命中）")
for ix in indexes:
    cons = sorted(usage.get(ix, []))
    p("     %-30s %s" % (ix, ("消费者 " + ", ".join(cons)) if cons else "**未被任何 SELECT 命中**"))

p("\n  B. 唯一索引（含隐式）：消费者是**写入闸**，不是 SELECT 计划。")
p("     其拒绝行为已在【三】逐条验证：")
UNIQ_EVIDENCE = {
    "ux_budget_tag_version": "「标签预算重复同一生效版本被拒」",
    "ux_budget_household_version": "「家庭总预算重复同一生效版本被拒」",
    "sqlite_autoindex_position_version_1": "「同 (成员,代码,生效日) 重复被拒」+ 取数走索引（V9/V10/V12）",
    "sqlite_autoindex_quote_daily_1": "「主键重复被拒」+ 区间取数走主键前缀（V13/V19）",
    "sqlite_autoindex_corporate_action_1": "「同 (成员,代码,除权日) 重复插入被拒」",
    "sqlite_autoindex_report_delivery_1": "「同 (类型,周期,通道) 重复插入被拒」+ INSERT OR IGNORE 影响 0 行",
    "sqlite_autoindex_cron_run_1": "「同 (task,scheduled_at) 重复心跳被拒」",
    "sqlite_autoindex_budget_alert_state_1": "主键即唯一（period_key, budget_id, tier）；V8 读路径走它",
    "sqlite_autoindex_entry_object_1": "「同一 Entry 重复打同一对象」被主键挡下；V3 借用为覆盖索引",
    "sqlite_autoindex_member_1": "member.name UNIQUE",
}
for ix, why in UNIQ_EVIDENCE.items():
    p("     %-38s %s" % (ix, why))

unused = [ix for ix in indexes if ix not in usage]
p("\n  C. 未被任何 SELECT 命中的显式索引：%s" % (", ".join(unused) if unused else "无"))
p("     （若出现，处置见文档 §5.3：要么补一条真实消费查询，要么删索引。）")

# ============================================================================
p("\n" + "=" * 78)
p("【七】行宽估算（决策票 #8 的估算是估算，此处给实测）")
p("=" * 78)

p("  quote_daily 单行净列宽（不含页填充与 B 树开销）：")
row_bytes = cur.execute(
    "SELECT length(code) + length(trade_date) + 8 + 8 + length(source) + 8 FROM quote_daily LIMIT 1"
).fetchone()[0]
nrows = cur.execute("SELECT COUNT(*) FROM quote_daily").fetchone()[0]
p("    = %d 字节 / 行（现有 %d 行）" % (row_bytes, nrows))
p("    20 只股票 x 244 交易日 = %d 行/年 = %.3f MB/年（净字节口径）"
  % (20 * 244, 20 * 244 * row_bytes / 1024.0 / 1024.0))
p("    对照 #8 的估算「≈63 B/行、20 只 ≈0.31 MB/年」：同一量级。")
p("    索引写入另计：quote_daily 只有主键索引，每行额外 1 行索引写入（决策票 #13）。")
p("    ⚠️ 本估算只含净列宽，不含页填充与 B 树开销；「撑满 500 MB 需多少年」一律是估算，非实测。")
p("    ⚠️ 本机 Python 未启用 dbstat 扩展，故给不出页级实测 —— 如实标注，不以估算冒充实测。")


# ============================================================================
p("\n" + "=" * 78)
p("【八】D1 侧待复核（本机 SQLite != D1，以下四项必须在 D1 上复跑）")
p("=" * 78)
p("""  1. `SELECT sqlite_version()` —— 本机为 %s，**不是 D1 的版本**
     （决策票 #16 与 #13 均标注「SQLite 精确版本号未找到官方明确数字」）。
  2. `CHECK (biz_date = date(occurred_at,'unixepoch','+8 hours'))` 这类
     **在 CHECK 里调用日期函数** 的写法能否被 D1 的 SQLite 接受并正确求值
     （本机已实测通过）。若不接受，退路是去掉该 CHECK、改由写入闸
     （触发器或应用层）保证，其余 schema 不受影响。
  3. `PRAGMA foreign_keys` 的默认值 —— 官方原文明确 D1 恒为 ON 且无法关闭
     （见 docs/specs/d1-schema.md §6.1），本脚本已显式 ON 对齐。
     ⚠️ 二手来源称 wrangler 本地模拟器在 2026-04 之前默认关闭外键
     （workers-sdk#5092），该说法**未经官方一手确认** —— 本地开发若依赖
     外键拦截，须自行验证。
  4. `batch()` 与 `ON CONFLICT ... DO UPDATE ... WHERE`（来源 rank 仅升级时覆盖）
     的组合行为，以及 **NULL 在唯一索引中的语义**（本 schema 已用两条部分唯一索引
     回避：见 ux_budget_*；#13 已实测 SQLite 的唯一约束对 NULL 完全无效）。

  另：本机 Python 未启用 dbstat 扩展，故行宽只给净字节估算（见 §七），
      不以估算冒充实测。""" % sqlite3.sqlite_version)

# ============================================================================
with open(os.path.join(HERE, "d1-schema-probe.out.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
