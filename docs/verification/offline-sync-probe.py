# -*- coding: utf-8 -*-
"""验证「PWA 与移动端离线策略」（migrations/0003_offline.sql）的约束可执行性与重放幂等性。

用途：为决策票 #10 提供可复跑的实测依据，而非纸面推断。
运行：python offline-sync-probe.py
输出：同目录 offline-sync-probe.out.txt（UTF-8）

被验对象：仓库根 migrations/0001_init.sql + 0002_auth.sql + 0003_offline.sql
          —— 本脚本**直接执行这三份文件**，不另抄一份 DDL，
          以保证「验的就是要发布的那份」。

迁移顺序在本脚本里是**刻意保留**的：
          0001/0002  ->  种子（模拟迁移前的历史行）  ->  0003
     因为 0003 之后新写入的 entry 必须带 client_ref，历史行只能在此之前产生。
     这同时验证了「在已有数据的表上加列 + 建唯一索引」的顺序安全性。

注意：本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**。
     本脚本显式 `PRAGMA foreign_keys = ON` 以对齐 D1 的默认行为。
     D1 侧仍需复核的项见输出末节。
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DDL_0001 = os.path.join(ROOT, "migrations", "0001_init.sql")
DDL_0002 = os.path.join(ROOT, "migrations", "0002_auth.sql")
DDL_0003 = os.path.join(ROOT, "migrations", "0003_offline.sql")

CST = timezone(timedelta(hours=8))
out = []
fails = []


def p(s=""):
    out.append(str(s))


def attempt(label, sql, params, expect):
    """expect: 'ok' 或 'error'。语句失败后连接仍可用（ABORT 只回滚该语句）。"""
    try:
        cur.execute(sql, params)
        got = "ok"
    except Exception:
        got = "error"
    mark = "PASS" if got == expect else "**FAIL**"
    if got != expect:
        fails.append(label + " (expect=%s got=%s)" % (expect, got))
    p("  [%s] %s" % (mark, label))
    return got


def value_of(label, sql, params, want):
    try:
        got = cur.execute(sql, params).fetchone()[0]
    except Exception as exc:
        got = "ERR:" + type(exc).__name__
    mark = "PASS" if got == want else "**FAIL**"
    if got != want:
        fails.append(label + " (want=%r got=%r)" % (want, got))
    p("  [%s] %s  ->  %r" % (mark, label, got))
    return got


def ts(y, mo, d, hh=12, mm=0):
    return int(datetime(y, mo, d, hh, mm, tzinfo=CST).timestamp())


# ============================================================================
# 契约里规定的两条重放语句（本脚本按契约实现，供实测）
# ============================================================================

REPLAY_ENTRY = """
INSERT INTO entry (member_id, category_tag_id, amount_cents, occurred_at, biz_date, created_at, client_ref)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(client_ref) DO NOTHING
"""

REPLAY_OBJECTS = """
INSERT INTO entry_object (entry_id, tag_id)
SELECT e.id, j.value
  FROM entry e, json_each(?) j
 WHERE e.client_ref = ?
   AND NOT EXISTS (SELECT 1 FROM entry_object eo WHERE eo.entry_id = e.id)
"""


# ============================================================================
# 建库：0001 -> 0002 -> 种子 -> 0003（顺序刻意如此）
# ============================================================================
con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
con.isolation_level = None          # 显式管理事务（§六 要模拟 D1 的 batch 原子性）
cur = con.cursor()

p("SQLITE_VERSION = " + sqlite3.sqlite_version)
p("DDL = migrations/0001_init.sql + 0002_auth.sql + 0003_offline.sql")
p("")

con.execute("PRAGMA foreign_keys = ON")
p("PRAGMA foreign_keys = %s   <- 本机默认 OFF；此处显式对齐 D1（D1 恒为 ON 且无法关闭）"
  % con.execute("PRAGMA foreign_keys").fetchone()[0])

for path, name in ((DDL_0001, "0001_init.sql"), (DDL_0002, "0002_auth.sql")):
    with open(path, encoding="utf-8") as f:
        ddl = f.read()
    cur.executescript(ddl)
    p("DDL 执行：OK  %s（%d 字符）" % (name, len(ddl)))

# ---------------------------------------------------------------------------
# 种子（模拟「迁移 0003 之前就已存在」的历史数据）
# ---------------------------------------------------------------------------
T = ts(2026, 9, 16, 9, 0)
cur.executemany("INSERT INTO member (id, name, sort_order, created_at) VALUES (?,?,?,?)", [
    (1, "胡先森", 1, T),
    (2, "太太", 2, T),
])
cur.executemany(
    "INSERT INTO tag (id, kind, parent_id, name, sort_order, is_builtin, created_at) VALUES (?,?,?,?,?,?,?)", [
        (1,  "category", None, "餐饮", 1, 1, T),
        (2,  "category", 1,    "早餐", 1, 0, T),
        (3,  "category", 1,    "午餐", 2, 0, T),
        (4,  "category", None, "住房", 2, 1, T),
        (10, "object",   None, "孩子", 1, 0, T),
        (11, "object",   None, "我",   2, 0, T),
        (12, "object",   None, "老人", 3, 0, T),
        (13, "object",   None, "宠物", 4, 0, T),
        (14, "object",   None, "全家", 5, 0, T),
    ])
# 三笔历史 Entry（无 client_ref —— 它们产生于 0003 之前）
cur.executemany(
    "INSERT INTO entry (id, member_id, category_tag_id, amount_cents, occurred_at, biz_date, created_at)"
    " VALUES (?,?,?,?,?,?,?)", [
        (101, 1, 2, 1500, ts(2026, 9, 14, 8, 10), "2026-09-14", T),
        (102, 1, 3, 3800, ts(2026, 9, 14, 12, 30), "2026-09-14", T),
        (103, 2, 4, 200000, ts(2026, 9, 1, 10, 0), "2026-09-01", T),
    ])
cur.executemany("INSERT INTO entry_object (entry_id, tag_id) VALUES (?,?)", [(101, 10), (102, 11)])
p("种子：member 2 行 / tag 9 行 / entry 3 行（历史行，无 client_ref）/ entry_object 2 行")

# ---------------------------------------------------------------------------
with open(DDL_0003, encoding="utf-8") as f:
    ddl3 = f.read()
cur.executescript(ddl3)
p("DDL 执行：OK  0003_offline.sql（%d 字符）—— 在已有数据的表上加列并建唯一索引" % len(ddl3))


# ============================================================================
p("\n" + "=" * 78)
p("【一】结构盘点（含对 0001/0002 的回归核对）")
p("=" * 78)

tables = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
triggers = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
explicit_idx = [r[0] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")]

p("  表 %d 张：%s" % (len(tables), ", ".join(tables)))
p("  触发器 %d 个" % len(triggers))
p("  显式索引 %d 个：%s" % (len(explicit_idx), ", ".join(explicit_idx)))
p("")
p("  基线链条：")
p("    #14 的 0001           12 表 / 16 触发器 / 10 显式索引")
p("    #9  的 0002 新增      +3 表 / +1 触发器 / +1 显式索引  ->  15 / 17 / 11")
p("    #10 的 0003 新增      +0 表 / +1 触发器 / +1 显式索引  ->  15 / 18 / 12")
ok_struct = (len(tables) == 15 and len(triggers) == 18 and len(explicit_idx) == 12)
p("    实测：%d 表 / %d 触发器 / %d 显式索引  ->  %s"
  % (len(tables), len(triggers), len(explicit_idx), "一致" if ok_struct else "**不一致**"))
if not ok_struct:
    fails.append("结构盘点与预期不符")

value_of("client_ref 列已存在且类型为 TEXT",
         "SELECT type FROM pragma_table_info('entry') WHERE name='client_ref'", (), "TEXT")


# ============================================================================
p("\n" + "=" * 78)
p("【二】为什么必须「加列 + 索引 + 触发器」三步，而不是一条 DDL")
p("=" * 78)

attempt("A1  ALTER TABLE entry ADD COLUMN x TEXT UNIQUE —— 预期被拒",
        "ALTER TABLE entry ADD COLUMN x1 TEXT UNIQUE", (), "error")
attempt("A2  ALTER TABLE entry ADD COLUMN x TEXT NOT NULL —— 预期被拒（无非空默认值）",
        "ALTER TABLE entry ADD COLUMN x2 TEXT NOT NULL", (), "error")
p("  -> SQLite 的 ADD COLUMN 既不能加 UNIQUE、也不能加无默认值的 NOT NULL 列，")
p("     故「client_ref 唯一且新行必填」无法靠一次加列实现。这是三步结构的硬依据。")
p("")
p("  A3/A4 在一张**独立的临时表**上演示（不在主库里留试验列）：")

demo = sqlite3.connect(":memory:")
demo.executescript("""
CREATE TABLE demo (id INTEGER PRIMARY KEY, v TEXT);
INSERT INTO demo (id, v) VALUES (1, '既有行');
""")
demo.execute("ALTER TABLE demo ADD COLUMN w TEXT CHECK (w IS NULL OR length(w) = 36)")
p("    [PASS] A3  ADD COLUMN 带 CHECK —— 成功；既有行的 w 未被求值，值为 %r"
  % demo.execute("SELECT w FROM demo WHERE id=1").fetchone()[0])
try:
    demo.execute("UPDATE demo SET w='short' WHERE id=1")
    got = "ok"
except Exception:
    got = "error"
mark = "PASS" if got == "error" else "**FAIL**"
if got != "error":
    fails.append("A4 CHECK 未对既有行的 UPDATE 生效")
p("    [%s] A4  把既有行的 w 改成不合规值 —— 预期被 CHECK 拒" % mark)
p("    -> 结论：ADD COLUMN 时不对既有行求值，但**既有行之后一旦被 UPDATE 就会重新求值**。")
p("       0001 的 entry 表上已有 biz_date 的 CHECK，任何 UPDATE 都会重跑它 ——")
p("       故本迁移选择「触发器只管新写入」，语义边界比列上 CHECK 清晰可控。")
demo.close()


# ============================================================================
p("\n" + "=" * 78)
p("【三】client_ref 的语义")
p("=" * 78)

value_of("B1  历史行（3 行）的 client_ref 全为 NULL",
         "SELECT COUNT(*) FROM entry WHERE client_ref IS NULL", (), 3)
value_of("B2  唯一索引允许多行 NULL 共存（这是历史行能留下的前提）",
         "SELECT COUNT(*) FROM (SELECT client_ref FROM entry WHERE client_ref IS NULL)", (), 3)
attempt("B3  新写入不带 client_ref —— 预期被触发器拒",
        "INSERT INTO entry (member_id,category_tag_id,amount_cents,occurred_at,biz_date,created_at)"
        " VALUES (1,2,900,?,?,?)", (ts(2026, 9, 16, 8, 0), "2026-09-16", T), "error")
C1 = "11111111-1111-4111-8111-111111111111"
C2 = "22222222-2222-4222-8222-222222222222"

value_of("B4  该 client_ref 此前不存在（重放的前置状态）",
         "SELECT COUNT(*) FROM entry WHERE client_ref=?", (C1,), 0)

cur.execute(REPLAY_ENTRY, (2, 2, 900, ts(2026, 9, 16, 8, 0), "2026-09-16", T, C1))
p("  第一次重放 client_ref=%s" % C1)
value_of("B5  第一次重放后该 client_ref 恰好 1 行",
         "SELECT COUNT(*) FROM entry WHERE client_ref=?", (C1,), 1)

before = cur.execute("SELECT COUNT(*) FROM entry").fetchone()[0]
cur.execute(REPLAY_ENTRY, (2, 2, 900, ts(2026, 9, 16, 8, 0), "2026-09-16", T, C1))
after = cur.execute("SELECT COUNT(*) FROM entry").fetchone()[0]
p("  第二次重放同一 client_ref（模拟「超时后重试」）")
p("    entry 总行数：%d -> %d  ->  %s" % (before, after, "幂等命中，未重复插入" if before == after else "**重复插入了**"))
if before != after:
    fails.append("重放未幂等：entry 行数由 %d 增至 %d" % (before, after))

# 同一 client_ref 重放，但内容被改过（客户端 bug / 用户改后重放）—— 旧值不被覆盖
cur.execute(REPLAY_ENTRY, (2, 2, 99999, ts(2026, 9, 16, 8, 0), "2026-09-16", T, C1))
value_of("B6  同一 client_ref 带不同内容重放 —— 不覆盖已写入的值（DO NOTHING 的语义）",
         "SELECT amount_cents FROM entry WHERE client_ref=?", (C1,), 900)

cur.execute(REPLAY_ENTRY, (1, 3, 1200, ts(2026, 9, 16, 9, 0), "2026-09-16", T, C2))
value_of("B7  另一个 client_ref 正常写入",
         "SELECT COUNT(*) FROM entry WHERE client_ref=?", (C2,), 1)


# ============================================================================
p("\n" + "=" * 78)
p("【四】重放幂等（entry + entry_object 全链路）")
p("=" * 78)

C3 = "33333333-3333-4333-8333-333333333333"
OBJ_JSON = json.dumps([10, 11, 12])


def replay(client_ref, member_id, cat, cents, occurred, biz, objs):
    cur.execute(REPLAY_ENTRY, (member_id, cat, cents, occurred, biz, T, client_ref))
    cur.execute(REPLAY_OBJECTS, (json.dumps(objs), client_ref))


replay(C3, 2, 3, 4500, ts(2026, 9, 16, 9, 30), "2026-09-16", [10, 11, 12])
value_of("C4  首次重放：entry 1 行 + 3 个对象",
         "SELECT COUNT(*) FROM entry_object eo JOIN entry e ON e.id=eo.entry_id"
         " WHERE e.client_ref=?", (C3,), 3)

replay(C3, 2, 3, 4500, ts(2026, 9, 16, 9, 30), "2026-09-16", [10, 11, 12])
value_of("C5  二次重放同一批：对象仍是 3 行（未翻倍）",
         "SELECT COUNT(*) FROM entry_object eo JOIN entry e ON e.id=eo.entry_id"
         " WHERE e.client_ref=?", (C3,), 3)

p("  -> 对象插入之所以不翻倍，靠的是语句里的 `AND NOT EXISTS (SELECT 1 FROM entry_object ...)`，")
p("     而**不是** `INSERT OR IGNORE` —— 理由见 §五（那一版的问题不是「吞错」，是语义不准）。")

# json_each 展开的数量正确性
value_of("C6  json_each 把 JSON 数组展开成 3 行",
         "SELECT COUNT(*) FROM json_each(?)", (OBJ_JSON,), 3)

# 对象上限 4 的触发器在批量路径下仍然生效
OBJ5 = json.dumps([10, 11, 12, 13, 14])
C4 = "44444444-4444-4444-8444-444444444444"
cur.execute(REPLAY_ENTRY, (2, 4, 100, ts(2026, 9, 16, 10, 0), "2026-09-16", T, C4))
attempt("C7  一批 5 个对象 —— 预期仍被 trg_entry_object_limit 拒（应用层本应先拦）",
        REPLAY_OBJECTS, (OBJ5, C4), "error")
value_of("C8  被拒后对象表里该 entry 仍为 0 行（ABORT 回滚了整条语句）",
         "SELECT COUNT(*) FROM entry_object eo JOIN entry e ON e.id=eo.entry_id"
         " WHERE e.client_ref=?", (C4,), 0)


# ============================================================================
p("\n" + "=" * 78)
p("【五】`INSERT OR IGNORE` 与触发器 `RAISE(ABORT)` 的交互（决定重放 SQL 的形态）")
p("=" * 78)

C5 = "55555555-5555-4555-8555-555555555555"
cur.execute(REPLAY_ENTRY, (2, 3, 500, ts(2026, 9, 16, 10, 30), "2026-09-16", T, C5))
attempt("D1  用 INSERT OR IGNORE 插入 5 个对象 —— 观察 ABORT 是否被吞掉",
        "INSERT OR IGNORE INTO entry_object (entry_id, tag_id)"
        " SELECT e.id, j.value FROM entry e, json_each(?) j WHERE e.client_ref=?",
        (OBJ5, C5), "error")
n_obj = cur.execute("SELECT COUNT(*) FROM entry_object eo JOIN entry e ON e.id=eo.entry_id"
                    " WHERE e.client_ref=?", (C5,)).fetchone()[0]
p("      实际落库的对象行数 = %d" % n_obj)
p("""      -> 结论（本机 %s 实测）：`OR IGNORE` **不会**吞掉触发器里的 `RAISE(ABORT)` ——""" % sqlite3.sqlite_version)
p("         ABORT 照常抛出，语句整体回滚，%d 行都没进去。" % n_obj)
p("         即便如此，契约仍**不采用** OR IGNORE，理由有两条：")
p("           ① OR IGNORE 会吞掉**约束类**失败（主键/NOT NULL/CHECK），那正是「写入静默")
p("              不一致」的来源 —— 错误应显式暴露，而不是挑一半吞一半；")
p("           ② `AND NOT EXISTS (...)` 表达的是「这条还没插过」这个**意图**，语义比")
p("              「冲突就忽略」精确，且不依赖冲突解决算法的细节。")
if n_obj != 0:
    fails.append("D1 预期 ABORT 不被吞（对象行数应为 0），实测 %d" % n_obj)


# ============================================================================
p("\n" + "=" * 78)
p("【六】整批重放：为什么必须「先预校验、再写 batch」")
p("=" * 78)

p("  场景：离线队列 3 条，其中第 2 条引用的类别标签已被删除（离线期间别人删的）。")
p("")

BATCH = [
    ("66666666-6666-4666-8666-666666666666", 1, 2, 800),
    ("77777777-7777-4777-8777-777777777777", 1, 99, 900),   # 99 不存在
    ("88888888-8888-4888-8888-888888888888", 2, 3, 1100),
]


def write_batch(items):
    """把一批条目放进同一个事务 —— 模拟 D1 的 batch()（原子事务）。"""
    n_before = cur.execute("SELECT COUNT(*) FROM entry").fetchone()[0]
    try:
        cur.execute("BEGIN")
        for cr, mid, cat, cents in items:
            cur.execute(REPLAY_ENTRY, (mid, cat, cents, ts(2026, 9, 16, 11, 0), "2026-09-16", T, cr))
        cur.execute("COMMIT")
        return "ok", cur.execute("SELECT COUNT(*) FROM entry").fetchone()[0] - n_before
    except Exception as exc:
        cur.execute("ROLLBACK")
        return "error:" + type(exc).__name__, 0


res, delta = write_batch(BATCH)
p("  E1  不做预校验，整批塞进一个事务  ->  %s，净增 %d 行" % (res, delta))
if res == "ok":
    fails.append("E1 预期整批失败（含无效类别），实测却成功了")
p("      -> 一条坏数据把整批拖下水。这就是**必须预校验**的实测依据。")
p("")

# 预校验：一次查询挑出引用了不存在 / 非类别标签的条目
TAG_IDS = "(" + ",".join(["?"] * 3) + ")"
cur.execute("SELECT id FROM tag WHERE kind='category' AND id IN " + TAG_IDS,
            tuple(cat for _, _, cat, _ in BATCH))
valid_cats = {r[0] for r in cur.fetchall()}
good = [b for b in BATCH if b[2] in valid_cats]
bad = [b for b in BATCH if b[2] not in valid_cats]
p("  E2  预校验（1 条 SQL）：有效 %d 条 / 无效 %d 条  ->  无效者：%s"
  % (len(good), len(bad), ", ".join(b[0][:8] for b in bad)))

res2, delta2 = write_batch(good)
p("  E3  只把有效的 %d 条放进事务  ->  %s，净增 %d 行" % (len(good), res2, delta2))
if res2 != "ok" or delta2 != len(good):
    fails.append("E3 预期成功且净增 %d 行，实测 %s / %d" % (len(good), res2, delta2))
value_of("E4  逐条结果：3 条中 2 条成功、1 条失败（失败被隔离，不阻塞其余）",
         "SELECT COUNT(*) FROM entry WHERE client_ref IN (?,?,?)",
         (BATCH[0][0], BATCH[1][0], BATCH[2][0]), 2)
p("      -> 一个请求：1 次预校验查询 + 1 个事务。失败的条目原样返回，不进事务。")
p("         ⚠️ 预校验与写入之间理论上存在竞态窗口（这中间标签被删）。2 人自用可忽略，")
p("            且此时事务会整体回滚、不会写入半条 —— 失败是显式的，不是静默的。")


# ============================================================================
p("\n" + "=" * 78)
p("【七】重放语句的数据访问路径（三条判据，附一处 EXPLAIN 误用的更正）")
p("=" * 78)

p("""
  ⚠️ 先如实登记一处**本票自查踩到的误用**：
     `EXPLAIN QUERY PLAN <INSERT>` **不能用来判断 INSERT 的数据访问路径** ——
     它报告的是该表身上的**外键动作程序**。本机 SQLite %s 的对照实测：

       INSERT INTO member              -> 6 行，全是「引用 member 的那些子表」的索引查找
       INSERT INTO entry               -> 1 行：SEARCH entry_object（唯一引用 entry 的表）
       INSERT INTO entry_object        -> 0 行（没有任何表引用它）
       INSERT INTO budget_alert_state  -> 0 行（同上）

     三者与「本语句查了哪些表」完全无关。探针最初版本正是在这里误用了它，
     把外键程序当成了全扫证据 —— 那会让「不得全扫」这条判据变成空的。已更正。
""" % sqlite3.sqlite_version)

p("  判据一（最硬的一条）：ON CONFLICT 的冲突检测**必然**走唯一索引。")
cur2 = con.cursor()
cur2.execute("DROP INDEX ux_entry_client_ref")
try:
    cur2.execute("EXPLAIN QUERY PLAN " + REPLAY_ENTRY, (1, 2, 1, T, "2026-09-16", T, "x"))
    got = "ok"
except Exception as exc:
    got = "error: " + str(exc)
mark = "PASS" if got.startswith("error") else "**FAIL**"
if not got.startswith("error"):
    fails.append("删掉唯一索引后 ON CONFLICT 仍可编译 —— 冲突检测路径不明确")
p("    [%s] 删掉 ux_entry_client_ref 后，同一语句无法编译：" % mark)
p("          %s" % got)
cur2.execute("CREATE UNIQUE INDEX ux_entry_client_ref ON entry(client_ref)")
p("    已重建索引。-> ON CONFLICT(client_ref) 这个语义**本身就依赖该唯一索引**；")
p("       索引不存在它就编译不过 ⇒ 不存在「全表扫描找冲突」这条路径。")

p("")
p("  判据二：重放涉及的定点查询全部走索引（EXPLAIN QUERY PLAN 用在 SELECT 上是可靠的）")
for lbl, sql, prm in (
    ("按 client_ref 取回 id", "SELECT id FROM entry WHERE client_ref=?", ("x",)),
    ("按 client_ref 判重", "SELECT 1 FROM entry WHERE client_ref=? LIMIT 1", ("x",)),
    ("重放对象行定位 entry", REPLAY_OBJECTS, ("[]", "x")),
):
    for d in [r["detail"] for r in cur2.execute("EXPLAIN QUERY PLAN " + sql, prm)]:
        p("    %-22s : %s" % (lbl, d))
        if d.startswith("SCAN") and "VIRTUAL TABLE" not in d:
            fails.append("定点查询出现全扫：%s / %s" % (lbl, d))
p("    （`SCAN j VIRTUAL TABLE INDEX` 是 json_each 展开 JSON 数组，属正常，不是表扫描。）")

p("")
p("  判据三：新增的唯一索引确实在写入路径上被维护（看 EXPLAIN 字节码）")
n_idx_ins = 0
for r in cur2.execute("EXPLAIN " + REPLAY_ENTRY, (1, 2, 1, T, "2026-09-16", T, "x")):
    if str(r[1]) == "IdxInsert":
        n_idx_ins += 1
entry_idx = ["ix_entry_cat_date", "ix_entry_member_date", "ix_entry_biz_date", "ux_entry_client_ref"]
p("    字节码中 OP_IdxInsert 出现 %d 次；entry 表上共有 %d 个索引（%s），逐个维护。"
  % (n_idx_ins, len(entry_idx), ", ".join(entry_idx)))
if n_idx_ins != len(entry_idx):
    fails.append("entry 写入路径上的 OP_IdxInsert 为 %d 个，与索引数 %d 不符"
                 % (n_idx_ins, len(entry_idx)))


# ============================================================================
p("\n" + "=" * 78)
p("【八】索引用途核对（新增的唯一索引必须有消费者）")
p("=" * 78)

usage = {}
for label, sql, params in (
    ("重放-插入对象", REPLAY_OBJECTS, ("[]", "x")),
    ("取回 id", "SELECT id FROM entry WHERE client_ref=?", ("x",)),
    ("离线去重查询", "SELECT 1 FROM entry WHERE client_ref=? LIMIT 1", ("x",)),
):
    for d in [r["detail"] for r in cur.execute("EXPLAIN QUERY PLAN " + sql, params)]:
        for ix in explicit_idx:
            if ix in d:
                usage.setdefault(ix, set()).add(label)

p("  ux_entry_client_ref 的消费者：%s"
  % ("、".join(sorted(usage.get("ux_entry_client_ref", []))) or "**未被任何查询命中**"))
if "ux_entry_client_ref" not in usage:
    fails.append("ux_entry_client_ref 未被任何查询命中（没消费者的索引不该存在）")
p("")
p("  说明：与 0001 的两条 ux_budget_* 同属「由**写入闸**消费」的索引。")
p("        它的**主**消费者是重放语句里的 ON CONFLICT 目标 —— 而那一侧")
p("        无法用 EXPLAIN QUERY PLAN 呈现（§七 已实测并登记该局限），")
p("        故改用「删掉索引即无法编译」的反证（§七 判据一）。")
p("        上表列出的是它在**定点查询**上的可见消费者。")


# ============================================================================
p("\n" + "=" * 78)
p("【九】D1 侧待复核（本机 SQLite != D1，以下四项必须在 D1 上复跑）")
p("=" * 78)
p("""  1. `SELECT sqlite_version()` —— 本机 %s 不是 D1 的版本（#14/#9 均标注此项未核实）。
  2. `ALTER TABLE ... ADD COLUMN` 在 D1 的迁移流程里可用（D1 用 SQLite 的 ALTER 子集，
     官方未列白名单）—— 若不可用，退路是「建新表 + 拷数据 + 改名」三步迁移。
  3. `json_each()` 表值函数在 D1 可用（官方只笼统写「支持 JSON 函数」，未逐一点名）。
     若不可用，退路是客户端把每个对象标签摊成一条 INSERT，放进同一个 batch。
  4. `batch()` 的原子性与 `ON CONFLICT ... DO NOTHING` 的组合行为 ——
     #14 已把「batch 与 ON CONFLICT 的组合」列为待复核项，本票沿用该结论。
     本脚本的 §六 用事务模拟了 batch 的原子性，**D1 上必须复跑确认**。""" % sqlite3.sqlite_version)


# ============================================================================
p("\n" + "=" * 78)
p("小结：断言失败 %d 处" % len(fails))
p("=" * 78)
for f in fails:
    p("  **FAIL** " + f)
if not fails:
    p("  全部通过。")

result = "\n".join(out) + "\n"
with open(os.path.join(HERE, "offline-sync-probe.out.txt"), "w", encoding="utf-8") as f:
    f.write(result)
print(result)
