# -*- coding: utf-8 -*-
"""验证「标签聚合与查询语义」的核心口径能否用单条 SQL 表达、且走索引。

用途：为决策票 #4 提供可复跑的实测依据，而非纸面推断。
运行：python tag-aggregation-probe.py > tag-aggregation-probe.out.txt

注意：本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**。
     D1 侧须以 `SELECT sqlite_version()` 另行复核。
"""
import os
import sqlite3

out = []
def p(s=""):
    out.append(str(s))

con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()
p("SQLITE_VERSION = " + sqlite3.sqlite_version)

cur.executescript("""
CREATE TABLE tag (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category','object')),
  parent_id INTEGER REFERENCES tag(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE entry (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL,
  category_tag_id INTEGER NOT NULL REFERENCES tag(id),
  amount_cents INTEGER NOT NULL,
  occurred_on TEXT NOT NULL
);
CREATE TABLE entry_object (
  entry_id INTEGER NOT NULL REFERENCES entry(id),
  tag_id INTEGER NOT NULL REFERENCES tag(id),
  PRIMARY KEY (entry_id, tag_id)
);
""")

# 两级类别树 + 平铺对象标签
cur.executemany("INSERT INTO tag VALUES (?,?,?,?,?)", [
    (1, 'category', None, '/1/',   '餐饮'),
    (2, 'category', 1,    '/1/2/', '外卖'),
    (3, 'category', 1,    '/1/3/', '买菜'),
    (4, 'category', None, '/4/',   '住房'),
    (5, 'category', 4,    '/4/5/', '房租'),
    (6, 'category', None, '/6/',   '医疗'),
    (7, 'object',   None, '/7/',   '孩子'),
    (8, 'object',   None, '/8/',   '我'),
    (9, 'object',   None, '/9/',   '老人'),
])

# 模拟一个月：注意 id=1,5 是「直接打在父节点上」（组自身直挂）
cur.executemany("INSERT INTO entry VALUES (?,?,?,?,?)", [
    (1, 1, 1, 20000, '2026-09-02'),
    (2, 1, 2, 80000, '2026-09-03'),
    (3, 2, 3, 60000, '2026-09-05'),
    (4, 1, 5, 300000, '2026-09-01'),
    (5, 2, 1, 50000, '2026-09-10'),
    (6, 1, 6, 30000, '2026-09-12'),
])
# 一笔可打多个对象标签（id=5 打了「孩子」和「我」）→ 对象维度必然重复计数
cur.executemany("INSERT INTO entry_object VALUES (?,?)", [
    (2, 7), (3, 7), (5, 7), (5, 8), (6, 9)
])
con.commit()

D0, D1 = '2026-09-01', '2026-10-01'

# ---- [Q1] 父 = 自身直挂 + 全体后代（单条 SQL，无递归；两级下用 parent_id 自连接）----
p("\n=== [Q1] 按组聚合（父=自身+后代，单条 SQL，无递归）===")
Q1 = """
SELECT COALESCE(p.id, t.id)     AS group_id,
       COALESCE(p.name, t.name) AS group_name,
       SUM(e.amount_cents)      AS total_cents
FROM entry e
JOIN tag t      ON e.category_tag_id = t.id
LEFT JOIN tag p ON t.parent_id = p.id
WHERE t.kind = 'category' AND e.occurred_on >= ? AND e.occurred_on < ?
GROUP BY COALESCE(p.id, t.id)
ORDER BY total_cents DESC
"""
for r in cur.execute(Q1, (D0, D1)):
    p("  %-4s (id=%s) %10.2f 元" % (r['group_name'], r['group_id'], r['total_cents'] / 100.0))

p("\n=== [Q1b] 树视图：子树合计 vs 仅自身直挂 ===")
Q1B = """
SELECT t.id, t.name,
       SUM(e.amount_cents) AS subtree_total,
       SUM(CASE WHEN e.category_tag_id = t.id THEN e.amount_cents ELSE 0 END) AS self_only
FROM entry e
JOIN tag t ON e.category_tag_id = t.id
           OR e.category_tag_id IN (SELECT c.id FROM tag c WHERE c.parent_id = t.id)
WHERE t.kind = 'category' AND e.occurred_on >= ? AND e.occurred_on < ?
GROUP BY t.id ORDER BY t.id
"""
for r in cur.execute(Q1B, (D0, D1)):
    p("  #%s %-4s subtree=%9.2f  self_only=%9.2f" % (
        r['id'], r['name'], r['subtree_total'] / 100.0, r['self_only'] / 100.0))
p("  → 「餐饮」subtree 2100 = 外卖 800 + 买菜 600 + 未细分 700")
p("    展开后若不补「未细分」行，子项之和对不上父项")

# ---- [Q1c] 守恒律 ----
p("\n=== [Q1c] 守恒律校验 ===")
tot = cur.execute("SELECT SUM(amount_cents) FROM entry WHERE occurred_on >= ? AND occurred_on < ?", (D0, D1)).fetchone()[0]
roots = sum(r['total_cents'] for r in cur.execute(Q1, (D0, D1)))
p("  总支出 = %.2f | 各根组之和 = %.2f | 相等: %s" % (tot / 100.0, roots / 100.0, tot == roots))

# ---- [Q2] 对象维度：重复计数与「未指定」缺口 ----
p("\n=== [Q2] 对象维度：Σ(各对象) vs 总支出 ===")
Q2 = """
SELECT tg.name, SUM(e.amount_cents) AS obj_total
FROM entry e
JOIN entry_object eo ON eo.entry_id = e.id
JOIN tag tg ON tg.id = eo.tag_id
WHERE e.occurred_on >= ? AND e.occurred_on < ?
GROUP BY tg.id ORDER BY obj_total DESC
"""
s = 0
for r in cur.execute(Q2, (D0, D1)):
    s += r['obj_total']
    p("  %-4s %10.2f 元" % (r['name'], r['obj_total'] / 100.0))
marked = cur.execute("""SELECT SUM(e.amount_cents) FROM entry e
  WHERE e.occurred_on >= ? AND e.occurred_on < ?
    AND EXISTS (SELECT 1 FROM entry_object eo WHERE eo.entry_id = e.id)""", (D0, D1)).fetchone()[0]
p("  各对象之和        = %.2f 元" % (s / 100.0))
p("  被标对象的记录额  = %.2f 元  ← Σ(各对象) 大于它，因同一笔可计入多个对象" % (marked / 100.0))
p("  未指定对象（缺口）= %.2f 元" % ((tot - marked) / 100.0))

# ---- [Q3] 类别 × 成员 交叉表 ----
p("\n=== [Q3] 类别 × 成员 交叉表（单条 SQL）===")
Q3 = """
SELECT COALESCE(p.name, t.name) AS grp,
       SUM(CASE WHEN e.member_id = 1 THEN e.amount_cents ELSE 0 END) AS m1,
       SUM(CASE WHEN e.member_id = 2 THEN e.amount_cents ELSE 0 END) AS m2,
       SUM(e.amount_cents) AS total
FROM entry e
JOIN tag t      ON e.category_tag_id = t.id
LEFT JOIN tag p ON t.parent_id = p.id
WHERE t.kind = 'category' AND e.occurred_on >= ? AND e.occurred_on < ?
GROUP BY COALESCE(p.id, t.id)
ORDER BY total DESC
"""
for r in cur.execute(Q3, (D0, D1)):
    p("  %-4s  成员1=%9.2f  成员2=%9.2f  合计=%9.2f" % (
        r['grp'], r['m1'] / 100.0, r['m2'] / 100.0, r['total'] / 100.0))

# ---- [Q5] 索引命中实测 ----
p("\n=== [Q5] 路径枚举前缀 LIKE 的索引命中 ===")
def plan(sql, params, label):
    p("  --- " + label)
    p("      " + " ".join(sql.split())[:110])
    for r in cur.execute("EXPLAIN QUERY PLAN " + sql, params):
        p("      " + str(r[3]))

cur.execute("CREATE INDEX idx_path_bin ON tag(path)")
cur.execute("PRAGMA case_sensitive_like=OFF")
p("\n  [A] 表上仅普通(BINARY)索引，case_sensitive_like=OFF（SQLite 默认）")
plan("SELECT id,name FROM tag WHERE path LIKE '/1/%'", (), "A1 字面量 pattern")
plan("SELECT id,name FROM tag WHERE path LIKE ?", ('/1/%',), "A2 绑定参数 pattern")

cur.execute("PRAGMA case_sensitive_like=ON")
p("\n  [A'] 表上仅普通索引，case_sensitive_like=ON")
plan("SELECT id,name FROM tag WHERE path LIKE '/1/%'", (), "A1' 字面量 pattern")
plan("SELECT id,name FROM tag WHERE path LIKE ?", ('/1/%',), "A2' 绑定参数 pattern")
cur.execute("PRAGMA case_sensitive_like=OFF")

cur.execute("DROP INDEX idx_path_bin")
cur.execute("CREATE INDEX idx_path_nocase ON tag(path COLLATE NOCASE)")
p("\n  [B] 表上仅 NOCASE 索引，case_sensitive_like=OFF（默认）")
plan("SELECT id,name FROM tag WHERE path LIKE '/1/%'", (), "B1 字面量 pattern")
plan("SELECT id,name FROM tag WHERE path LIKE ?", ('/1/%',), "B2 绑定参数 pattern")

p("\n  结论：默认配置 + 普通索引 → SCAN（全表）；须 NOCASE 索引或开 pragma 才命中。")
p("        两级约束下改用 parent_id 自连接，完全绕开此陷阱。")

# ---- [Q4] 派生指标口径 ----
p("\n=== [Q4] 日均口径对比（9 月，以 9/15 为「今天」）===")
days_total, days_elapsed = 30, 15
days_active = cur.execute("SELECT COUNT(DISTINCT occurred_on) FROM entry WHERE occurred_on >= ? AND occurred_on < ?", (D0, D1)).fetchone()[0]
p("  分母 = 期间总天数   %2d → %8.2f 元/天" % (days_total, tot / 100.0 / days_total))
p("  分母 = 当期已过天数 %2d → %8.2f 元/天   ← 推荐" % (days_elapsed, tot / 100.0 / days_elapsed))
p("  分母 = 有消费的天数 %2d → %8.2f 元/天" % (days_active, tot / 100.0 / days_active))

p("\n=== [Q4b] 环比边界：上期无数据 ===")
prev = cur.execute("SELECT SUM(amount_cents) FROM entry WHERE occurred_on >= '2026-08-01' AND occurred_on < '2026-09-01'").fetchone()[0]
p("  上期(8月)合计 = %s" % prev)
p("  → 上期为 NULL/0 时变化率不可计算，须显示「无上期数据」，不得用 0 / ∞ / 100% 填充")

# ---- [D] 能力实测 ----
p("\n=== [D] 依赖能力实测（本机版本，D1 侧须复核）===")
for label, sql in [
    ("窗口函数 ROW_NUMBER()", "SELECT ROW_NUMBER() OVER (ORDER BY amount_cents DESC) FROM entry"),
    ("WITH RECURSIVE", "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT n FROM c"),
    ("json_extract()", "SELECT json_extract('{\"a\":1}','$.a')"),
    ("CTE", "WITH x AS (SELECT 1 AS n) SELECT n FROM x"),
]:
    try:
        list(cur.execute(sql))
        p("  %-22s 可用" % label)
    except Exception as e:
        p("  %-22s 不可用：%s" % (label, e))

text = "\n".join(out)
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "tag-aggregation-probe.out.txt")
with open(dest, "w", encoding="utf-8", newline="\n") as f:
    f.write(text + "\n")
print(text)
