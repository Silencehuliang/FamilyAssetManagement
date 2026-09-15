# -*- coding: utf-8 -*-
"""验证「股票」子系统的收益口径：除权除息日的昨收分叉、持仓按生效日版本化取数、
持仓变动当日的收益误差上界、区间收益率的垫消恒等式、多成员加权收益率、现金不进分母。

用途：为决策票 #7「股票持仓与收益口径定义」提供可复跑的实测依据，而非纸面推断。
运行：python position-version-probe.py
输出：同目录 position-version-probe.out.txt（UTF-8）

金额口径：全程整数「分」。
  - 价格存「分/股」；持仓市值 = 价格(分/股) × 数量(股) = 「分」。
  - 每股现金红利可能含小数分；交易所的除权(息)参考价按分取整，故此处会有一处取整。

注意：
- 本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**，D1 侧须另行复核。
- 本票不涉及时区换算：行情 feed 返回的「日期」本身就是东八区日历日，
  交易日日期直接以 `YYYY-MM-DD` 文本存用，无需任何时区函数。
- 脚本内日期仅用于构造场景；**「无行情行」只表示该日没有行情数据，不宣称它是节假日**。

本脚本踩过并已修的两个坑（防复发）：
  1. **`%` 格式化不支持 `%,.2f`** —— 千分位只属于 `format()` 的迷你语言，
     写成 `"%,.2f" % x` 会抛 `ValueError: unsupported format character ','`。
  2. **同一 cursor 边迭代边 `execute` ⇒ 结果集被重置，循环只跑一轮**
     （症状：quote2 有 3 行，打印只出 1 行）。**必须先 `fetchall()` 再循环。**
"""

import datetime as dt
import sqlite3
import unicodedata

out = []


def p(s=""):
    out.append(str(s))


def fs(c):
    """分 -> 带符号、带千分位的元。"""
    return ("-" if c < 0 else "") + format(abs(c) / 100.0, ",.2f")


def fp(frac):
    """比例 -> 百分比字符串。入参是**比例**（0.1 表示 10%），不是百分数。"""
    return "%.2f%%" % (frac * 100.0)


def dw(s):
    """显示宽度：全角/宽字符（CJK）算 2 列。

    不能直接用 `%-12s` 排版含中文的表头：`%` 补空格按**字符数**算，
    「查询日」3 个字符其实占 6 列 → 表头与数据行必然错位。
    """
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def pad(s, width, right=False):
    n = max(0, width - dw(s))
    return (" " * n + str(s)) if right else (str(s) + " " * n)


WEEK = ["一", "二", "三", "四", "五", "六", "日"]

con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()

p("=" * 78)
p("[0] 环境")
p("=" * 78)
p("SQLITE_VERSION   = " + sqlite3.sqlite_version)
p("金额单位         = 整数「分」；价格存「分/股」")
p("时间口径         = 交易日日期为东八区日历日（文本 YYYY-MM-DD），无时区换算")

# ------------------------------------------------------------------
# 1. 除权除息日：「昨收」取自当日 feed 还是本地历史
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[1] 除权除息日：昨收取自当日 feed 还是本地历史，差出一条假暴跌")
p("=" * 78)

cur.executescript("""
DROP TABLE IF EXISTS quote_daily;
CREATE TABLE quote_daily (
    code        TEXT    NOT NULL,
    trade_date  TEXT    NOT NULL,   -- 东八区日历日
    prev_close  INTEGER NOT NULL,   -- 分/股：**取自当日行情 feed**
    close       INTEGER NOT NULL,   -- 分/股
    PRIMARY KEY (code, trade_date)
);
""")

# 实测数据（2026-09-15 经 WebFetch 取数，见
# docs/research/a-share-corporate-actions-and-cost-facts.md §3.2）
# 贵州茅台 600519，除权除息日 2026-06-26，10 派 280.2423 元（含税）
QUOTES = [
    ("600519", "2026-06-25", 120768, 121210),   # 1207.68 → 1212.10
    ("600519", "2026-06-26", 118408, 116863),   # 昨收=1184.08（除权参考价），收 1168.63
]
cur.executemany("INSERT INTO quote_daily VALUES (?,?,?,?)", QUOTES)

div_per_share = 280.2423 / 10 * 100              # 分/股 = 2802.423（含小数分）
ref_exact = 121210 - div_per_share               # 除权参考价，未取整
ref_round = int(round(ref_exact))                # 按分取整

p("  每股现金红利（税前）  = %.5f 元 = %.3f 分" % (div_per_share / 100, div_per_share))
p("  除权(息)参考价        = 前收盘 %s − 现金红利 = %.3f 分 → 按分取整 = %d 分 = %s 元"
  % (fs(121210), ref_exact, ref_round, fs(ref_round)))
p("  实测 feed 该日昨收     = %s 元" % fs(118408))
p("  → 取整后与实测完全一致（差 %d 分）；复权因子恰等于每股红利" % (ref_round - 118408))
p("")
p("  除权除息日 2026-06-26 的「当日收益（每股）」：")
pnl_a = 116863 - 118408
pnl_b = 116863 - 121210
p("    路径 A（昨收取自当日 feed，即除权参考价） = %s − %s = %s 元/股   ✔ 真实"
  % (fs(116863), fs(118408), fs(pnl_a)))
p("    路径 B（昨收取自本地前一日收盘）         = %s − %s = %s 元/股   ✘ 假暴跌"
  % (fs(116863), fs(121210), fs(pnl_b)))
p("    对应涨跌幅：路径 A %s ／ 路径 B %s"
  % (fp(pnl_a / 118408.0), fp(pnl_b / 121210.0)))
p("    两条路径之差 = %s 元/股 = 每股现金红利（本已落袋的那部分，被误算成亏损）"
  % fs(abs(pnl_b - pnl_a)))

# ------------------------------------------------------------------
# 2. 持仓版本：按查询日取「生效日 <= 该日」的最后一个版本
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[2] 持仓版本：一条 SQL 取「生效日 <= 查询日」的最后一个版本（含中间插入）")
p("=" * 78)

cur.executescript("""
DROP TABLE IF EXISTS position_version;
CREATE TABLE position_version (
    member_id      INTEGER NOT NULL,
    code           TEXT    NOT NULL,
    effective_date TEXT    NOT NULL,   -- 东八区日历日；「自该日起」生效
    qty            INTEGER NOT NULL,   -- 股；0 = 清仓
    cost_price     INTEGER NOT NULL,   -- 分/股；qty=0 时忽略
    PRIMARY KEY (member_id, code, effective_date)
);
""")

VERSIONS = [
    (1, "600519", "2026-01-05", 1000, 1250),   # 12.50
    (1, "600519", "2026-03-02", 1500, 1180),   # 11.80  ← 事后补录（中间插入）
    (1, "600519", "2026-06-26", 2000, 630),    # 6.30   ← 除权调整：10送10，量×2 价÷2
    (1, "600519", "2026-07-10", 1200, 610),    # 6.10
    (1, "600519", "2026-09-01", 0, 0),         # 清仓
]
cur.executemany("INSERT INTO position_version VALUES (?,?,?,?,?)", VERSIONS)

p("  版本序列（成员 1 × 600519）：")
for r in cur.execute("SELECT * FROM position_version WHERE member_id=1 AND code='600519'"
                     " ORDER BY effective_date").fetchall():
    if r["effective_date"] == "2026-03-02":
        note = "  ← 事后补录（插入到既有两版之间）"
    elif r["effective_date"] == "2026-06-26":
        note = "  ← 除权调整派生"
    elif r["qty"] == 0:
        note = "  ← 清仓"
    else:
        note = ""
    p("    %s  %5d 股  @ %s 元%s"
      % (r["effective_date"], r["qty"], fs(r["cost_price"]), note))

LOOKUP_SQL = """
WITH q(d) AS (VALUES ('2025-12-31'),('2026-02-10'),('2026-03-01'),('2026-03-02'),
                     ('2026-04-01'),('2026-06-25'),('2026-06-26'),('2026-07-10'),
                     ('2026-09-02'))
SELECT q.d AS d,
       v.effective_date AS hit,
       v.qty            AS qty,
       v.cost_price     AS cost
  FROM q
  LEFT JOIN position_version v
    ON v.member_id = 1 AND v.code = '600519'
   AND v.effective_date = (SELECT MAX(v2.effective_date)
                             FROM position_version v2
                            WHERE v2.member_id = 1 AND v2.code = v.code
                              AND v2.effective_date <= q.d)
 ORDER BY q.d
"""

p("")
p("  %s %s %s %s  %s"
  % (pad("查询日", 12), pad("命中版本", 12), pad("数量", 6, True), pad("成本价", 10, True), "备注"))
for r in cur.execute(LOOKUP_SQL).fetchall():
    if r["hit"] is None:
        p("  %s %s %s %s  %s"
          % (pad(r["d"], 12), pad("-", 12), pad("-", 6, True), pad("-", 10, True),
             "无版本 ⇒ 该股当日不存在，不参与收益"))
    elif r["qty"] == 0:
        p("  %s %s %s %s  %s"
          % (pad(r["d"], 12), pad(r["hit"], 12), pad(r["qty"], 6, True),
             pad(fs(r["cost"]), 10, True), "清仓：不进分子也不进分母"))
    elif r["hit"] == "2026-06-26":
        p("  %s %s %s %s  %s"
          % (pad(r["d"], 12), pad(r["hit"], 12), pad(r["qty"], 6, True),
             pad(fs(r["cost"]), 10, True), "除权调整版"))
    else:
        p("  %s %s %s %s"
          % (pad(r["d"], 12), pad(r["hit"], 12), pad(r["qty"], 6, True),
             pad(fs(r["cost"]), 10, True)))

p("")
p("  索引命中检查（EXPLAIN QUERY PLAN）：")
for r in cur.execute("EXPLAIN QUERY PLAN "
                     "SELECT qty FROM position_version"
                     " WHERE member_id=1 AND code='600519' AND effective_date<='2026-04-01'"
                     " ORDER BY effective_date DESC LIMIT 1").fetchall():
    p("    " + r["detail"])
p("  → 走 PRIMARY KEY(member_id, code, effective_date) 的索引，非全表扫描。")

try:
    cur.execute("INSERT INTO position_version VALUES (1,'600519','2026-03-02',9999,9999)")
    p("  ⚠ 同生效日重复插入竟然成功 —— 与「一个日期一个版本」的约定不符")
except sqlite3.IntegrityError:
    p("  同 (成员, 代码, 生效日) 重复插入 → 抛 IntegrityError，被唯一约束挡住 ✔")

# ------------------------------------------------------------------
# 3. 持仓变动当日的收益误差上界
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[3] 持仓变动当日：按当日生效版本计算 ⇒ 存在不可消除的误差（须显式标注）")
p("=" * 78)

p("  系统不知道成交时点与成交价（不管理买卖），因此变动当日只能整日按新数量算。")
p("  误差上界 = |当日数量变动| × |当日每股涨跌额|")
p("")

CASES = [
    # 场景              变动前量 变动后量  当日昨收  当日收盘
    ("加仓 1000 股", 1000, 2000, 1000, 1050),
    ("减仓 1000 股", 2000, 1000, 1080, 1030),
]
p("  %s %s %s %s %s %s %s"
  % (pad("场景", 14), pad("变动前", 8, True), pad("变动后", 8, True), pad("每股涨跌", 10, True),
     pad("系统当日收益", 12, True), pad("真实值区间", 22, True), pad("误差上界", 12, True)))
for name, q0, q1, pc, cl in CASES:
    d = cl - pc
    sysv = d * q1
    alt = d * q0
    lo, hi = min(sysv, alt), max(sysv, alt)
    p("  %s %s %s %s %s %s %s"
      % (pad(name, 14), pad(q0, 8, True), pad(q1, 8, True), pad(fs(d), 10, True),
         pad(fs(sysv), 12, True), pad(fs(lo) + " ~ " + fs(hi), 22, True),
         pad(fs(abs(sysv - alt)), 12, True)))
p("")
p("  → 加仓且当日上涨时系统高估；加仓且当日下跌时系统低估。方向随涨跌与增减反向。")
p("  → 该误差**不可消除**（无成交时点信息），只能对含持仓变动的交易日打显式标记。")

# ------------------------------------------------------------------
# 4. 区间收益的垫消恒等式 + 区间收益率
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[4] 区间收益的垫消：Σ当日收益 = 期末市值 − 期初市值；区间收益率 = Σ ÷ 期初市值")
p("=" * 78)

cur.executescript("""
DROP TABLE IF EXISTS quote_probe;
CREATE TABLE quote_probe (
    trade_date TEXT    NOT NULL PRIMARY KEY,
    prev_close INTEGER NOT NULL,
    close      INTEGER NOT NULL
);
""")
SERIES = [
    ("2026-04-02", 1050, 1060),
    ("2026-04-03", 1060, 1042),
    ("2026-04-07", 1042, 1080),
    ("2026-04-08", 1080, 1075),
]
cur.executemany("INSERT INTO quote_probe VALUES (?,?,?)", SERIES)
QTY = 2000

p("  区间 2026-04-02 ~ 2026-04-08，持仓恒为 %d 股" % QTY)
p("")
p("  %s %s %s %s %s"
  % (pad("日期", 12), pad("星期", 4), pad("昨收", 10, True), pad("收盘", 10, True),
     pad("当日收益", 12, True)))
total = 0
first_prev = None
last_close = None
for r in cur.execute("SELECT * FROM quote_probe ORDER BY trade_date").fetchall():
    d = r["trade_date"]
    wd = WEEK[dt.date.fromisoformat(d).weekday()]
    pnl = (r["close"] - r["prev_close"]) * QTY
    total += pnl
    if first_prev is None:
        first_prev = r["prev_close"]
    last_close = r["close"]
    p("  %s %s %s %s %s"
      % (pad(d, 12), pad(wd, 4), pad(fs(r["prev_close"]), 10, True),
         pad(fs(r["close"]), 10, True), pad(fs(pnl), 12, True)))

mv0 = first_prev * QTY
mv1 = last_close * QTY
p("")
p("  Σ当日收益            = %s 元" % fs(total))
p("  期末市值 − 期初市值   = %s − %s = %s 元   %s"
  % (fs(mv1), fs(mv0), fs(mv1 - mv0), "✔ 恒等" if total == mv1 - mv0 else "✘ 不等"))
p("  区间收益率           = %s ÷ %s = %s" % (fs(total), fs(mv0), fp(total * 1.0 / mv0)))

p("")
p("  非交易日不补零、不插值（把 2026-04-01 ~ 2026-04-09 的日历日全列出来看；")
p("  「无」只表示该日没有行情行，**不等于**该日必为节假日）：")
p("  %s %s %s" % (pad("日历日", 12), pad("星期", 4), "有无行情行"))
for i in range(1, 10):
    d = "2026-04-%02d" % i
    wd = WEEK[dt.date.fromisoformat(d).weekday()]
    hit = cur.execute("SELECT 1 FROM quote_probe WHERE trade_date=?", (d,)).fetchone()
    p("  %s %s %s" % (pad(d, 12), pad(wd, 4),
                      "有" if hit else "无 ⇒ 曲线无此点（不补 0、不插值）"))

# ------------------------------------------------------------------
# 5. 多成员：金额相加，收益率必须加权
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[5] 多成员汇总：金额相加；收益率必须按分母加权（简单平均会失真）")
p("=" * 78)

MEMBERS = [
    ("成员 A", 10000000, 1000000),   # 成本 100,000 元，盈亏 +10,000 元
    ("成员 B", 1000000, -100000),    # 成本  10,000 元，盈亏  -1,000 元
]
p("  %s %s %s %s"
  % (pad("成员", 8), pad("持仓成本", 14, True), pad("累计浮动盈亏", 16, True),
     pad("累计收益率", 12, True)))
tot_cost = tot_pnl = 0
for name, cost, pnl in MEMBERS:
    tot_cost += cost
    tot_pnl += pnl
    p("  %s %s %s %s"
      % (pad(name, 8), pad(fs(cost), 14, True), pad(fs(pnl), 16, True),
         pad(fp(pnl * 1.0 / cost), 12, True)))

simple_avg = sum(pnl * 1.0 / cost for _, cost, pnl in MEMBERS) / len(MEMBERS)
weighted = tot_pnl * 1.0 / tot_cost
p("  %s %s %s" % (pad("合计", 8), pad(fs(tot_cost), 14, True), pad(fs(tot_pnl), 16, True)))
p("")
p("  简单平均收益率 = %s" % fp(simple_avg))
p("  加权收益率     = %s ÷ %s = %s   ✔ 采用" % (fs(tot_pnl), fs(tot_cost), fp(weighted)))
p("  两者相差       = %.2f 个百分点 —— 简单平均会被小账户的高波动率带偏"
  % ((weighted - simple_avg) * 100))

# ------------------------------------------------------------------
# 6. 现金（未交易金额）不进收益率分母
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[6] 未交易金额不进收益率分母（否则是「现金不产出却被算作本金」的自相矛盾）")
p("=" * 78)

CASH = [("成员 A", 5000000), ("成员 B", 0)]      # 合计现金 50,000 元
cash_total = sum(c for _, c in CASH)
denom_with_cash = tot_cost + cash_total
p("  持仓成本合计   = %s 元" % fs(tot_cost))
p("  未交易金额合计 = %s 元" % fs(cash_total))
p("")
p("  口径 A（推荐）：分母 = 持仓成本合计")
p("      累计收益率 = %s ÷ %s = %s" % (fs(tot_pnl), fs(tot_cost), fp(tot_pnl * 1.0 / tot_cost)))
p("  口径 B：分母 = 持仓成本合计 + 未交易金额")
p("      累计收益率 = %s ÷ %s = %s"
  % (fs(tot_pnl), fs(denom_with_cash), fp(tot_pnl * 1.0 / denom_with_cash)))
p("")
p("  → 现金不产生收益，分子里没有它的贡献；把它放进分母只是稀释。")
p("  → 未交易金额的角色只有两个：构成「账户总资产」、展示仓位。")

# ------------------------------------------------------------------
# 7. 清仓后该股不进分子也不进分母
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[7] 清仓（qty=0 版本）：其后不进分子也不进分母，持有区间内的历史贡献保留")
p("=" * 78)

cur.executescript("""DROP TABLE IF EXISTS quote2;
                     CREATE TABLE quote2 (code TEXT, trade_date TEXT,
                                          prev_close INTEGER, close INTEGER);""")
cur.executemany("INSERT INTO quote2 VALUES (?,?,?,?)", [
    ("600519", "2026-08-31", 1000, 1010),
    ("600519", "2026-09-01", 1010, 1050),
    ("600519", "2026-09-02", 1050, 990),
])


def qty_on(code, d):
    r = cur.execute("""SELECT qty FROM position_version
                        WHERE member_id=1 AND code=? AND effective_date<=?
                        ORDER BY effective_date DESC LIMIT 1""", (code, d)).fetchone()
    return None if r is None else r["qty"]


# 必须先 fetchall()：下面循环里要调用 qty_on() 执行新的 SQL，
# 若边迭代边 execute，同一个 cursor 的结果集会被重置，循环只跑一轮。
rows7 = cur.execute("SELECT * FROM quote2 WHERE code='600519'"
                    " ORDER BY trade_date").fetchall()
p("  %s %s %s %s %s"
  % (pad("日期", 12), pad("数量", 6, True), pad("当日收益", 12, True),
     pad("持仓市值", 12, True), pad("计入分母?", 12)))
for r in rows7:
    d = r["trade_date"]
    q = qty_on("600519", d)
    q = 0 if q is None else q
    p("  %s %s %s %s %s"
      % (pad(d, 12), pad(q, 6, True), pad(fs((r["close"] - r["prev_close"]) * q), 12, True),
         pad(fs(r["close"] * q), 12, True), "是" if q > 0 else "否（已清仓）"))
p("")
p("  历史查询 2026-05-06 的数量 = %s 股 ⇒ 清仓只截断未来，不改写过去。"
  % qty_on("600519", "2026-05-06"))

# ------------------------------------------------------------------
# 8. 未交易金额不版本化 ⇒ 账户总资产只能作当前值
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[8] 未交易金额不版本化 ⇒ 历史「账户总资产」是两个时点混算，只能作当前值")
p("=" * 78)

CURRENT_CASH = 5000000
hist_d, hist_close = "2026-03-02", 1200
hist_qty = qty_on("600519", hist_d)
hist_mv = hist_close * hist_qty
p("  历史日 %s：数量 %d 股 × 当日收盘 %s 元 = 市值 %s 元（历史值）"
  % (hist_d, hist_qty, fs(hist_close), fs(hist_mv)))
p("  未交易金额：      %s 元（**今日值**，无版本）" % fs(CURRENT_CASH))
p("  「总资产」若如此相加 = %s 元 —— 市值是 2026-03-02 的，现金却是今天的。"
  % fs(hist_mv + CURRENT_CASH))
p("  → 结论：账户总资产**只作当前值展示，不画历史曲线**；历史曲线一律画持仓收益。")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("结论")
p("=" * 78)
p("1. 除权除息日的「昨收」必须取自当日行情 feed：交易所已把它置为除权(息)参考价，")
p("   `(今收−昨收)` 因此天然免疫分红/送转跳空。若用本地前收，会凭空造出 %s 元/股的假暴跌。"
  % fs(abs(pnl_b - pnl_a)))
p("2. 持仓版本 `(成员, 代码, 生效日) → (数量, 成本价)` 用一条 SQL 按日取数，走主键索引；")
p("   允许「中间插入」，补录历史变更不改动既有行 —— 这是版本化相对当前基线的核心优势。")
p("3. 持仓变动当日的收益误差上界 = |数量变动| × |当日每股涨跌额|，不可消除，须显式标注。")
p("4. 区间收益满足垫消恒等式（Σ当日收益 = 期末市值 − 期初市值），区间收益率为其 ÷ 期初市值。")
p("5. 多成员金额相加、收益率加权；未交易金额不进分母；清仓版本截断未来不改写过去。")
p("=" * 78)

path = __file__.replace(".py", ".out.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
print("\n[written] " + path)
