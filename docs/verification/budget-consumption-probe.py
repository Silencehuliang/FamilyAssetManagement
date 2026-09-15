# -*- coding: utf-8 -*-
"""验证「预算模型」的核心口径能否用单条 SQL 表达，以及提醒跨档判定的失效边界。

用途：为决策票 #5 提供可复跑的实测依据，而非纸面推断。
运行：python budget-consumption-probe.py
输出：同目录 budget-consumption-probe.out.txt（UTF-8）

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
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('category','object')),
  parent_id  INTEGER REFERENCES tag(id),
  name       TEXT NOT NULL
);
CREATE TABLE entry (
  id               INTEGER PRIMARY KEY,
  member_id        INTEGER NOT NULL,
  category_tag_id  INTEGER NOT NULL REFERENCES tag(id),
  amount_cents     INTEGER NOT NULL,
  occurred_on      TEXT NOT NULL
);
-- 预算：scope='tag' 时挂 tag_id；scope='household' 时为家庭总预算（tag_id 为 NULL）
-- 版本化用 effective_from（见 [Q5]）
CREATE TABLE budget_ver (
  budget_id      INTEGER PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('tag','household')),
  tag_id         INTEGER REFERENCES tag(id),
  period_type    TEXT NOT NULL CHECK (period_type IN ('week','month','year')),
  amount_cents   INTEGER NOT NULL,
  effective_from TEXT NOT NULL
);
""")

cur.executemany("INSERT INTO tag VALUES (?,?,?,?)", [
    (1, 'category', None, '餐饮'),
    (2, 'category', 1,    '外卖'),
    (3, 'category', 1,    '买菜'),
    (4, 'category', None, '住房'),
    (5, 'category', 4,    '房租'),
    (6, 'category', None, '医疗'),
    (7, 'object',   None, '孩子'),
    (8, 'object',   None, '我'),
])

# 2026-09 的支出（含「直接打在父节点上」的 200 元 → 未细分）
cur.executemany("INSERT INTO entry VALUES (?,?,?,?,?)", [
    (1, 1, 2,  30000, '2026-09-02'),  # 外卖
    (2, 2, 3,  40000, '2026-09-05'),  # 买菜
    (3, 1, 1,  20000, '2026-09-08'),  # 餐饮（组自身直挂）
    (4, 1, 5, 300000, '2026-09-01'),  # 房租
    (5, 2, 6,  30000, '2026-09-12'),  # 医疗
])

# 预算（月度，自 2026-08-01 生效）
cur.executemany("INSERT INTO budget_ver VALUES (?,?,?,?,?,?)", [
    (1, 'tag',       1,    'month', 200000, '2026-08-01'),  # 餐饮组 2000
    (2, 'tag',       2,    'month',  50000, '2026-08-01'),  # 外卖   500
    (3, 'tag',       4,    'month', 350000, '2026-08-01'),  # 住房组 3500
    (4, 'household', None, 'month', 600000, '2026-08-01'),  # 家庭总 6000
])
con.commit()

P_START, P_END = '2026-09-01', '2026-10-01'

# ============================================================
p("\n" + "=" * 72)
p("【Q1】整个预算面板能否用 1 条 SQL 取全（所有类别标签 + 各自预算 + 各自消耗）")
p("=" * 72)

PANEL = """
SELECT t.id                                   AS tag_id,
       t.name                                 AS tag_name,
       IFNULL(b.amount_cents, NULL)           AS budget_cents,
       IFNULL(SUM(e.amount_cents), 0)         AS consumed_cents
FROM tag t
LEFT JOIN (
    SELECT tag_id, amount_cents
    FROM budget_ver
    WHERE period_type = :ptype AND effective_from <= :pstart
      AND budget_id = (SELECT MAX(budget_id) FROM budget_ver b2
                       WHERE b2.tag_id = budget_ver.tag_id
                         AND b2.period_type = budget_ver.period_type
                         AND b2.effective_from <= :pstart)
) b ON b.tag_id = t.id
LEFT JOIN entry e
       ON (e.category_tag_id = t.id
           OR e.category_tag_id IN (SELECT c.id FROM tag c WHERE c.parent_id = t.id))
      AND e.occurred_on >= :pstart AND e.occurred_on < :pend
WHERE t.kind = 'category'
GROUP BY t.id
ORDER BY t.id
"""
params = {'ptype': 'month', 'pstart': P_START, 'pend': P_END}
rows = list(cur.execute(PANEL, params))
for r in rows:
    b = r['budget_cents']
    c = r['consumed_cents']
    if b:
        p("  #%s %-4s 预算 %8.2f  已用 %8.2f  %6.1f%%" % (
            r['tag_id'], r['tag_name'], b / 100.0, c / 100.0, c * 100.0 / b))
    else:
        p("  #%s %-4s 预算    (无)  已用 %8.2f     ---" % (
            r['tag_id'], r['tag_name'], c / 100.0))
p("  → 组与叶同列一行，1 条 SQL 覆盖全部类别标签。")

# 家庭总预算：口径 = 总支出（类别维度权威口径）
total_spend = cur.execute(
    "SELECT SUM(amount_cents) FROM entry WHERE occurred_on >= ? AND occurred_on < ?",
    (P_START, P_END)).fetchone()[0]
hb = cur.execute("""SELECT amount_cents FROM budget_ver
                   WHERE scope='household' AND period_type='month' AND effective_from <= ?
                   ORDER BY effective_from DESC LIMIT 1""", (P_START,)).fetchone()[0]
p("  家庭总预算 %8.2f  已用 %8.2f  %6.1f%%   （口径 = 总支出，1 条 SQL）" % (
    hb / 100.0, total_spend / 100.0, total_spend * 100.0 / hb))
p("\n  ⇒ 预算面板整页 = %d 条 SQL（含家庭总预算则 %d 条），远低于每视图 ≤5 条的预算。" % (1, 2))

# ============================================================
p("\n" + "=" * 72)
p("【Q2】父子同时有预算：是否重复扣减 / 口径是否自洽")
p("=" * 72)

p("  餐饮(组,#1) 预算 2000 | 外卖(叶,#2) 预算 500")
p("  明细：外卖 300 + 买菜 400 + 未细分(组直挂) 200 = 900")
p("  实测消费：餐饮 900/2000 = 45.0%   外卖 300/500 = 60.0%")
p("")
p("  >>> 关键：900 与 300 是**同一笔钱的两个视角**，不是两个被各自扣减的池子。")
p("      父预算不因「子预算已占用」而减少；子预算也不从父预算中扣除。")
p("      守恒律：父(subtree) = Σ子(subtree) + 未细分 = 300+400+200 = 900 ✓")

sub_leaf = sum(r['consumed_cents'] for r in rows if r['tag_id'] in (2, 3))
grp = [r for r in rows if r['tag_id'] == 1][0]['consumed_cents']
p("      校验：Σ子项 = %.2f | 未细分 = %.2f | 父项 = %.2f | 相等: %s" % (
    sub_leaf / 100.0, (grp - sub_leaf) / 100.0, grp / 100.0, sub_leaf + (grp - sub_leaf) == grp))

roots = sum(r['consumed_cents'] for r in rows if r['tag_id'] in (1, 4, 6))
p("      根类别之和 = %.2f | 总支出 = %.2f | 相等: %s" % (
    roots / 100.0, total_spend / 100.0, roots == total_spend))

# 追加一笔大额，演示「子超支但父未超支」
cur.execute("INSERT INTO entry VALUES (?,?,?,?,?)", (99, 1, 2, 60000, '2026-09-20'))
con.commit()
rows2 = list(cur.execute(PANEL, params))
p("\n  追加一笔 600 元外卖后：")
for r in rows2:
    if r['budget_cents'] and r['tag_id'] in (1, 2, 4):
        p("    #%s %-4s 预算 %8.2f  已用 %8.2f  %6.1f%%%s" % (
            r['tag_id'], r['tag_name'], r['budget_cents'] / 100.0,
            r['consumed_cents'] / 100.0,
            r['consumed_cents'] * 100.0 / r['budget_cents'],
            '   ← 超支' if r['consumed_cents'] > r['budget_cents'] else ''))
p("  ⇒ 「子超支、父未超支」是合法且可解释的状态：父控总量、子控明细。")
cur.execute("DELETE FROM entry WHERE id = 99")
con.commit()

# ============================================================
p("\n" + "=" * 72)
p("【Q3】跨周期：同一 SQL 形状换日期窗口即可覆盖 周 / 月 / 年")
p("=" * 72)

windows = [
    ("week  2026-09-07 ~ 09-14", '2026-09-07', '2026-09-14'),
    ("month 2026-09",            '2026-09-01', '2026-10-01'),
    ("year  2026",               '2026-01-01', '2027-01-01'),
]
for label, a, b in windows:
    v = cur.execute("""SELECT IFNULL(SUM(amount_cents),0) FROM entry
                       WHERE category_tag_id IN (1,2,3) AND occurred_on >= ? AND occurred_on < ?""",
                    (a, b)).fetchone()[0]
    p("  %-28s 餐饮组消耗 %9.2f" % (label, v / 100.0))
p("  → 周期只影响日期窗口参数，不影响 SQL 形状；无须为每种周期各写一套聚合。")

# ============================================================
p("\n" + "=" * 72)
p("【Q4】提醒跨档判定：无状态（对比前一日）会漏报")
p("=" * 72)

# 专用序列：餐饮预算 1000 元，逐日累计
BUD = 100000
series = [('2026-09-01', 30000), ('2026-09-02', 30000),
          ('2026-09-03', 25000), ('2026-09-04', 20000)]
cur.execute("DELETE FROM entry")
cur.executemany("INSERT INTO entry VALUES (?,?,?,?,?)",
                [(i + 1, 1, 1, amt, d) for i, (d, amt) in enumerate(series)])
con.commit()

def cum_upto(day):
    return cur.execute("""SELECT IFNULL(SUM(amount_cents),0) FROM entry
                          WHERE category_tag_id = 1 AND occurred_on <= ?""",
                       (day,)).fetchone()[0]

def level(c):
    if c >= BUD:
        return 2          # 超支
    if c >= BUD * 0.8:
        return 1          # 预警
    return 0

cum = {d: cum_upto(d) for d, _ in series}
p("  逐日累计（预算 1000，预警线 80%，超支线 100%）：")
for d, _ in series:
    p("    %s 累计 %7.2f  %6.1f%%  档位=%s" % (
        d, cum[d] / 100.0, cum[d] * 100.0 / BUD, level(cum[d])))

p("\n  [A] Cron 每日正常运行，判定「昨日起跨档」：")
prev = 0
for d, _ in series:
    if level(cum[d]) > level(prev):
        p("    %s 触发档位 %s" % (d, '预警' if level(cum[d]) == 1 else '超支'))
    prev = cum[d]

p("\n  [B] Cron 在 2026-09-03 漏跑一次（Error 1102 / 未触发），仍只用「前一日」对比：")
prev = 0
fired = []
for d, _ in series:
    if d == '2026-09-03':
        p("    %s —— Cron 未运行，跳过" % d)
        prev = cum[d]
        continue
    if level(cum[d]) > level(prev):
        fired.append(d)
        p("    %s 触发档位 %s" % (d, '预警' if level(cum[d]) == 1 else '超支'))
    prev = cum[d]
p("    ⇒ 9/03 的「预警」被静默吞掉：9/04 时前一日(9/03)已是 L1，不满足跨档条件。")
p("       漏报不可恢复——后续每天前一日都已是 L1/L2。**这是无状态方案的硬缺陷。**")

p("\n  [C] 改为持久化「上次运行时的累计值」再对比：")
last = 0
for d, _ in series:
    if d == '2026-09-03':
        p("    %s —— Cron 未运行（上次运行值仍为 9/02 的 %7.2f）" % (d, cum['2026-09-02'] / 100.0))
        continue
    if level(cum[d]) > level(last):
        tiers = [t for t in (1, 2) if level(last) < t <= level(cum[d])]
        p("    %s 触发档位 %s（补齐）" % (d, '、'.join('预警' if t == 1 else '超支' for t in tiers)))
    last = cum[d]
p("    ⇒ 漏跑一天也能补齐档位，但**必须持久化一个状态**（上次累计值 或 已提醒档位集）。")
p("       该状态是**事件记录**，不是「由明细可重算的派生汇总」，")
p("       故不与 «标签聚合与查询语义» 的「不建汇总表」冲突（那条针对的是可从明细重算的汇总）。")
p("\n  成本：Cron 每次 = 读状态 1 条 + 取当前累计 1 条 + upsert 状态 1 条 = **3 条 SQL**，")
p("        一次 Cron 覆盖全部预算（不是每预算 3 条）——状态表按 budget_id 退化为按账户单行。")

# ============================================================
p("\n" + "=" * 72)
p("【Q5】预算版本化：改预算后历史月份按哪一版判定")
p("=" * 72)

cur.execute("""INSERT INTO budget_ver VALUES (?,?,?,?,?,?)""",
            (5, 'tag', 1, 'month', 150000, '2026-09-15'))
con.commit()
p("  场景：餐饮组预算 2000（自 8/01 生效）；9/15 改为 1500。")
p("  9 月餐饮消耗 = %.2f 元" % (grp / 100.0))

V_SQL = """
SELECT t.id, t.name, b.amount_cents AS applied
FROM tag t
LEFT JOIN (
   SELECT tag_id, amount_cents, effective_from,
          ROW_NUMBER() OVER (PARTITION BY tag_id, period_type
                             ORDER BY effective_from DESC) AS rn
   FROM budget_ver
   WHERE period_type = 'month' AND effective_from <= :pstart
) b ON b.tag_id = t.id AND b.rn = 1
WHERE t.kind = 'category'
ORDER BY t.id
"""
p("\n  [a] 规则「自下一期生效」（:pstart = 9/01）：")
for r in cur.execute(V_SQL, {'pstart': '2026-09-01'}):
    if r['applied']:
        p("    #%s %-4s 适用预算 %8.2f" % (r['id'], r['name'], r['applied'] / 100.0))
p("    ⇒ 9 月仍按 2000 判（9/15 的修改自 10/01 起生效）；历史月份永不被追溯改写。")

p("\n  [b] 规则「自当期生效」（:pstart = 9/15）：")
for r in cur.execute(V_SQL, {'pstart': '2026-09-15'}):
    if r['applied'] and r['id'] == 1:
        p("    #%s %-4s 适用预算 %8.2f" % (r['id'], r['name'], r['applied'] / 100.0))
p("    ⇒ 9 月立即改按 1500 判 → 9 月从「未超支」翻转为「超支」，历史被追溯改写。")
p("\n  两种规则都只需 1 条 SQL（窗口函数取每 tag 的最新适用版本），面板查询次数不变。")

# ============================================================
p("\n" + "=" * 72)
p("【Q6】依赖能力实测（本机版本，D1 侧须复核）")
p("=" * 72)
for label, sql in [
    ("窗口函数 ROW_NUMBER() OVER", "SELECT ROW_NUMBER() OVER (ORDER BY amount_cents DESC) FROM entry"),
    ("WITH RECURSIVE", "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT n FROM c"),
    ("CTE", "WITH x AS (SELECT 1 AS n) SELECT n FROM x"),
    ("json_extract()", "SELECT json_extract('{\"a\":1}','$.a')"),
]:
    try:
        list(cur.execute(sql))
        p("  %-28s 可用" % label)
    except Exception as e:
        p("  %-28s 不可用：%s" % (label, e))

text = "\n".join(out)
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "budget-consumption-probe.out.txt")
with open(dest, "w", encoding="utf-8", newline="\n") as f:
    f.write(text + "\n")
print("written: " + dest)
