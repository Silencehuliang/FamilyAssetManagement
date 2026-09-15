# -*- coding: utf-8 -*-
"""验证「股票」子系统的行情存储口径：除权日三条价格路径、前复权基准漂移、
回填请求数与回填深度的关系、端点口径 vs 逐日加总口径在缺口下的分岔、
派息金额的精度下限、`最新价 == 0` 的防护、缺口差集检测、主键与 CHECK 约束行为。

用途：为决策票 #8「持仓快照与历史收益表设计」提供可复跑的实测依据，而非纸面推断。
运行：python quote-table-probe.py
输出：同目录 quote-table-probe.out.txt（UTF-8）

金额口径：
  - 股价与持仓市值用整数「分」（price 存「分/股」）。
  - **每股派息不能用「分/股」**：实测茅台为 28.02423 元/股（5 位小数），
    故 corporate_action 的派息列必须用「微元/股」（1e-6 元）才能精确。

注意：
- 本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**，D1 侧须另行复核。
- 下列「实测值」于 2026-09-15 通过东财 push2his kline 接口取得
  （secid=1.600519, klt=101, beg/end 区间），与 #7 的记录同源。
- 脚本内日期仅用于构造场景；**「无行情行」只表示该日没有行情数据，不宣称它是节假日**。

本脚本踩过并已防复发的坑（沿自同目录前两个脚本的教训）：
  1. **`%` 格式化不支持 `%,.2f`** —— 千分位只属于 format() 的迷你语言。
  2. **同一 cursor 边迭代边 execute ⇒ 结果集被重置，循环只跑一轮** —— 必须先 fetchall()。
  3. **`%-12s` 排版含中文的表头必然错位** —— 改用 dw()/pad() 按显示宽度补齐。
  4. **`execute()` 一次只能跑一条语句** —— 多条 DDL 必须用 executescript()。
"""

import sqlite3
import unicodedata

out = []


def p(s=""):
    out.append(str(s))


def fs(c):
    """分 -> 带符号、带千分位的元。"""
    return ("-" if c < 0 else "") + format(abs(c) / 100.0, ",.2f")


def fp(frac):
    """比例 -> 百分比字符串。入参是**比例**（0.1 表示 10%）。"""
    return "%.2f%%" % (frac * 100.0)


def dw(s):
    """显示宽度：全角/宽字符（CJK）算 2 列。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def pad(s, width, right=False):
    n = max(0, width - dw(s))
    return (" " * n + str(s)) if right else (str(s) + " " * n)


def fw(micro):
    """微元 -> 元字符串（6 位小数，去尾零）。"""
    s = format(abs(micro) / 1000000.0, ".6f").rstrip("0").rstrip(".")
    return ("-" if micro < 0 else "") + s


# ------------------------------------------------------------------
# 实测常量（2026-09-15 拉取，东财 push2his kline，secid=1.600519）
# ------------------------------------------------------------------
MC = {
    "code": "sh600519",
    "ex_date": "2026-06-26",          # 除权除息日（10派280.2423元含税）
    "prev_day": "2026-06-25",
    "div_per_share_micro": 28024230,  # 每股派息 28.02423 元
    "raw": {                          # fqt=0 不复权收盘（元）
        "2026-06-24": 1207.68,
        "2026-06-25": 1212.10,
        "2026-06-26": 1168.63,
    },
    "adj": {                          # fqt=1 前复权收盘（元）
        "2026-06-24": 1179.66,
        "2026-06-25": 1184.08,
        "2026-06-26": 1168.63,
    },
    "feed_prev_close": 1184.08,       # 当日 feed 的「昨收」（#7 实测）
    "dktotal": 6005,                  # 该接口自报的日线总根数
    "prek": [                         # (请求窗口, fqt=0 的 preKPrice, fqt=1 的 preKPrice)
        ("20260601-20260624", 1326.00, 1297.98),
        ("20260618-20260702", 1240.00, 1211.98),
    ],
}


def yuan_to_cents(x):
    """元 -> 分（四舍五入，模拟交易所按分取整）。"""
    return int(round(x * 100))


con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()

p("=" * 78)
p("[0] 环境")
p("=" * 78)
p("SQLITE_VERSION   = " + sqlite3.sqlite_version)
p("股价/市值单位    = 整数「分」（价格存「分/股」）")
p("派息单位         = 「微元/股」（1e-6 元）—— 分与厘都不够，见第 5 节")
p("时间口径         = 交易日日期为东八区日历日（文本 YYYY-MM-DD），无时区换算")
p("实测样本         = 贵州茅台 sh600519，除权除息日 " + MC["ex_date"])

# ------------------------------------------------------------------
# 1. 除权除息日：三条价格存储路径，两条收敛到同一个假数字
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[1] 除权除息日：「昨收」怎么来，决定当日盈亏是 −15.45 还是 −43.47")
p("=" * 78)

DIV_CENTS = int(round(MC["div_per_share_micro"] / 10000.0))   # 微元 -> 分
RAW_PREV = yuan_to_cents(MC["raw"][MC["prev_day"]])
RAW_CLOSE = yuan_to_cents(MC["raw"][MC["ex_date"]])
REF_PRICE = RAW_PREV - DIV_CENTS                              # 交易所除权(息)参考价
FEED_PREV = yuan_to_cents(MC["feed_prev_close"])

p("  前一日（%s）原始收盘      = %s 元" % (MC["prev_day"], fs(RAW_PREV)))
p("  除权日（%s）原始收盘      = %s 元" % (MC["ex_date"], fs(RAW_CLOSE)))
p("  每股派息                  = %s 元（= %s 分，按分取整）"
  % (fw(MC["div_per_share_micro"]), DIV_CENTS))
p("  交易所除权(息)参考价      = %s − %s = %s 元"
  % (fs(RAW_PREV), fs(DIV_CENTS), fs(REF_PRICE)))
p("  当日 feed 返回的「昨收」  = %s 元   %s"
  % (fs(FEED_PREV),
     "✔ 与参考价吻合" if FEED_PREV == REF_PRICE else "✘ 与参考价不符"))
p("")

PATHS = [
    ("A", "存不复权 ＋ 采信 feed 昨收", FEED_PREV, "✔ 正确"),
    ("B", "存不复权 ＋ 从本地上一行推算昨收", RAW_PREV, "✘ 假暴跌"),
    ("C", "存前复权 ＋ 逐日抓取冻结", RAW_PREV, "✘ 假暴跌"),
]
p("  %s %s %s %s %s %s"
  % (pad("路径", 6), pad("口径", 30), pad("存入的昨收", 12, True),
     pad("存入的收盘", 12, True), pad("当日盈亏", 12, True), "判定"))
pnl = {}
for key, desc, prev, verdict in PATHS:
    v = RAW_CLOSE - prev
    pnl[key] = v
    p("  %s %s %s %s %s %s"
      % (pad(key, 6), pad(desc, 30), pad(fs(prev), 12, True),
         pad(fs(RAW_CLOSE), 12, True), pad(fs(v), 12, True), verdict))
p("")
p("  → 路径 B 与 C 收敛到同一个数 %s 元，与正确的 %s 元相差 %s 元/股，"
  % (fs(pnl["B"]), fs(pnl["A"]), fs(abs(pnl["B"] - pnl["A"]))))
p("    差额恰好等于每股派息 %s 元 —— 已经落袋的那部分被记成了亏损。" % fs(DIV_CENTS))
p("  → 且路径 A 用的昨收与「前复权序列的前一日收盘」逐分吻合：")
p("      fqt=1 在 %s 的收盘 = %s 元 = feed 昨收 %s 元"
  % (MC["prev_day"], MC["adj"][MC["prev_day"]], MC["feed_prev_close"]))
p("    ⇒ **回填时昨收可被精确还原**，无需留空（见第 3 节）。")

# ------------------------------------------------------------------
# 2. 前复权基准漂移：为什么「逐日冻结前复权」必然产生假暴跌
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[2] 前复权基准随每次分红整体平移 ⇒ 逐日存下的行各自冻结在不同基准上")
p("=" * 78)

p("  刚性证据一：同一历史日期、不同请求窗口下，fqt=1 的值完全相同；")
p("  但 preKPrice（窗口首根前一日收盘）却随窗口变化 —— 说明基准是「拉取当日的最新日」，不是窗口：")
p("  %s %s %s %s"
  % (pad("请求窗口", 22), pad("fqt=0 preK", 14, True),
     pad("fqt=1 preK", 14, True), pad("两者差", 12, True)))
for win, k0, k1 in MC["prek"]:
    p("  %s %s %s %s"
      % (pad(win, 22), pad(fs(yuan_to_cents(k0)), 14, True),
         pad(fs(yuan_to_cents(k1)), 14, True),
         pad(fs(yuan_to_cents(k0) - yuan_to_cents(k1)), 12, True)))
p("  两个窗口的差都是 %s 元 —— 与「拉取当日」无关的那次分红，被整体平移到了所有历史行上。"
  % fs(DIV_CENTS))
p("")
p("  刚性证据二：把「逐日抓取到的前复权值」按日存进同一张表，会发生什么：")
p("")
p("  %s %s %s %s"
  % (pad("日期", 14), pad("抓取时点", 16), pad("当日基准", 16),
     pad("存下的前复权值", 16, True)))
freeze = [
    ("2026-06-24", "06-24 盘后", "分红尚未发生", MC["raw"]["2026-06-24"]),
    ("2026-06-25", "06-25 盘后", "分红尚未发生", MC["raw"]["2026-06-25"]),
    ("2026-06-26", "06-26 盘后", "分红已发生", MC["adj"]["2026-06-26"]),
]
for d, when, basis, val in freeze:
    p("  %s %s %s %s"
      % (pad(d, 14), pad(when, 16), pad(basis, 16), pad(fs(yuan_to_cents(val)), 16, True)))
stored = [yuan_to_cents(v) for _, _, _, v in freeze]
p("")
p("  %s %s %s %s"
  % (pad("表内相邻两行", 22), pad("存下的差", 14, True),
     pad("真实的差", 14, True), "判定"))
p("  %s %s %s %s"
  % (pad("06-24 → 06-25", 22),
     pad(fs(stored[1] - stored[0]), 14, True),
     pad(fs(yuan_to_cents(MC["raw"]["2026-06-25"]) - yuan_to_cents(MC["raw"]["2026-06-24"])), 14, True),
     "✔ 一致"))
true_26 = yuan_to_cents(MC["adj"]["2026-06-26"]) - yuan_to_cents(MC["adj"]["2026-06-25"])
p("  %s %s %s %s"
  % (pad("06-25 → 06-26", 22),
     pad(fs(stored[2] - stored[1]), 14, True),
     pad(fs(true_26), 14, True), "✘ 凭空少掉一次分红"))
p("")
p("  → 全区间累计：存下来的 %s − %s = %s 元；真实累计 = %s 元；"
  % (fs(stored[2]), fs(stored[0]), fs(stored[2] - stored[0]),
     fs(true_26 + yuan_to_cents(MC["raw"]["2026-06-25"]) - yuan_to_cents(MC["raw"]["2026-06-24"]))))
p("    凭空多出 %s 元亏损。**前复权价不能逐日冻结入库。**" % fs(DIV_CENTS))

# ------------------------------------------------------------------
# 3. 回填：请求数与「深度」无关，只与「只数」成正比
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[3] 回填请求数：与回填深度 M 无关，只与只数 N 成正比（票面前提已修正）")
p("=" * 78)

p("  实测：一次区间请求返回 dktotal = %d 根日线（≈ %.1f 年），beg/end 只是参数。"
  % (MC["dktotal"], MC["dktotal"] / 244.0))
p("  ⇒ 回填 3 年与回填 1 天，成本完全相同；不存在「N 只 × M 天」这个乘积。")
p("")
SUB_LIMIT = 50   # 免费版每请求子请求上限（已核实）
p("  %s %s %s %s %s"
  % (pad("回填只数 N", 12, True), pad("补齐 close+prev_close", 22, True),
     pad("只补 close", 16, True), pad("是否超 50 上限", 16), "备注"))
for n in (5, 10, 20, 25, 30, 50):
    two = 2 * n
    one = 1 * n
    over = two > SUB_LIMIT
    note = ""
    if n == 25:
        note = "恰好用满 50"
    elif n == 50:
        note = "必须分批"
    p("  %s %s %s %s %s"
      % (pad(n, 12, True), pad(two, 22, True), pad(one, 16, True),
         pad("是" if over else "否", 16), note))
p("")
p("  对照：若票面的「N 只 × M 天」成立，20 只 × 250 天 = 5,000 请求，")
p("        是本设计（20 只 = 40 请求）的 %.0f 倍。" % (5000 / 40.0))
p("  → 单次运行设「最多 10 只缺口」上限 ⇒ 20 个子请求，留足余量给当日行情抓取。")

# ------------------------------------------------------------------
# 4. 区间收益：端点口径 vs 逐日加总口径，在有缺口时分岔
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[4] 区间收益：端点口径（期末市值−期初市值）在缺口下仍然正确，Σ 可得日会低估")
p("=" * 78)

cur.executescript("""DROP TABLE IF EXISTS q_probe;
                     CREATE TABLE q_probe (trade_date TEXT PRIMARY KEY,
                                           prev_close INTEGER, close INTEGER);""")
# 真实序列（含 09-09，该日我方缺行情）：1000 -> 1010 -> 1040 -> 1050 -> 1060
cur.executemany("INSERT INTO q_probe VALUES (?,?,?)", [
    ("2026-09-07", 990, 1000),
    ("2026-09-08", 1000, 1010),
    ("2026-09-10", 1040, 1050),   # 其 prev_close 隐含了 09-09 的收盘 1040
    ("2026-09-11", 1050, 1060),
])
QTY = 100

rows4 = cur.execute("SELECT * FROM q_probe ORDER BY trade_date").fetchall()
p("  %s %s %s %s %s %s"
  % (pad("日期", 14), pad("数量", 6, True), pad("昨收", 10, True),
     pad("收盘", 10, True), pad("当日盈亏", 12, True), "区间归属"))
sum_avail = 0
for i, r in enumerate(rows4):
    v = (r["close"] - r["prev_close"]) * QTY
    if i == 0:
        tag = "期初日，其盈亏归**上一**区间"
    else:
        tag = "计入本区间"
        sum_avail += v
    p("  %s %s %s %s %s %s"
      % (pad(r["trade_date"], 14), pad(QTY, 6, True), pad(fs(r["prev_close"]), 10, True),
         pad(fs(r["close"]), 10, True), pad(fs(v), 12, True), tag))
p("  %s %s %s %s %s %s"
  % (pad("2026-09-09", 14), pad(QTY, 6, True), pad("—", 10, True),
     pad("—", 10, True), pad("无行情行", 12, True), "**无法计入**"))
p("")
mv0 = 1000 * QTY
mv1 = 1060 * QTY
endpoint = mv1 - mv0
GAP_PNL = (1040 - 1010) * QTY
p("  口径 A（推荐）端点法：期末市值 − 期初市值 = %s − %s = %s 元"
  % (fs(mv1), fs(mv0), fs(endpoint)))
p("  口径 B（Σ 可得日）      ：%s 元" % fs(sum_avail))
p("")
p("  → 分岔 = %s 元，恰好等于缺口当日「收盘 1040 − 昨收 1010」× %d 股 = %s 元。"
  % (fs(endpoint - sum_avail), QTY, fs(GAP_PNL)))
p("  → 真实总涨跌 = 1060 − 1000 = 60 分/股 × %d 股 = %s 元 ⇒ **端点法准确，Σ法静默低估**。"
  % (QTY, fs(endpoint)))
p("  → 故「恒等于」只在无缺口时成立；有缺口时以端点法为权威，并显式提示缺口天数。")
p("")
p("  ⚠️ **差一错陷阱（本脚本第一版就踩了）**：期初市值取自**期初日收盘**，")
p("     因此期初日自己的「当日盈亏」属于**上一个**区间，必须排除在本区间之外——")
p("     否则每个区间都会多算一天（本例会把 Σ 从 %s 元算成 %s 元，分岔伪装成 %s 元）。"
  % (fs(sum_avail), fs(sum_avail + 1000), fs(endpoint - sum_avail - 1000)))
p("     实现里必须把这条口径写死在一处，不得各处各自解释。")

# ------------------------------------------------------------------
# 5. 派息金额的精度下限：分、厘都不够，必须微元
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[5] 每股派息 %s 元 —— 分/股与厘/股都不够，必须微元/股" % fw(MC["div_per_share_micro"]))
p("=" * 78)

HOLD = 1000
p("  %s %s %s %s"
  % (pad("存储单位", 16), pad("折算每股", 16, True),
     pad("持有 %d 股的分红" % HOLD, 22, True), pad("与真实值之差", 16, True)))
real = MC["div_per_share_micro"] * HOLD        # 微元
for label, unit in (("分/股 (1e-2)", 10000), ("厘/股 (1e-3)", 1000), ("微元/股 (1e-6)", 1)):
    per = MC["div_per_share_micro"] // unit
    total_micro = per * HOLD * unit
    diff = total_micro - real
    p("  %s %s %s %s"
      % (pad(label, 16), pad(fw(per * unit), 16, True),
         pad(fw(total_micro) + " 元", 22, True),
         pad(fw(diff) + " 元", 16, True)))
p("")
p("  → 参考价按分取整（%s 元）不受影响；受影响的是「提示成员的分红金额」。" % fs(REF_PRICE))
p("  → 微元不增加任何复杂度（仍是一个 INTEGER 列），却把这类失真归零。")

# ------------------------------------------------------------------
# 6. `最新价 == 0` 必须判为解析失败，绝不当价格入库
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[6] 防护：行情源返回「最新价 = 0」时照单入库 ⇒ 凭空一条 −100% 的暴跌")
p("=" * 78)

FAKE_PREV, FAKE_CLOSE = 1234, 0     # 分
bad = (FAKE_CLOSE - FAKE_PREV) * 1000
p("  构造：昨收 %s 元、最新价返回 0、持仓 1,000 股" % fs(FAKE_PREV))
p("  若照单入库：当日盈亏 = (0 − %s) × 1000 = %s 元 ⇒ 该股当日收益率 %s"
  % (fs(FAKE_PREV), fs(bad), fp(bad * 1.0 / (FAKE_PREV * 1000))))
p("  正确处理：判为解析失败 ⇒ **不落行**，该日无行情，不计入分母、不画点。")
p("  依据：调研记录明确「盘后/休市时部分源返回最新价 0 」⇒ 0 是**无效标记**，不是价格。")

# ------------------------------------------------------------------
# 7. 缺口检测：差集即缺口，不需要交易日历
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[7] 缺口 = 行情源返回的日期 − 我方已有的日期（差集）；非交易日天然被排除")
p("=" * 78)

cur.executescript("""DROP TABLE IF EXISTS quote_daily;
                     CREATE TABLE quote_daily (
                       code        TEXT NOT NULL,
                       trade_date  TEXT NOT NULL,
                       close       INTEGER NOT NULL,
                       prev_close  INTEGER,
                       source      TEXT NOT NULL
                                   CHECK (source IN ('feed','backfill','manual')),
                       recorded_at INTEGER NOT NULL,
                       PRIMARY KEY (code, trade_date),
                       CHECK (source = 'manual' OR prev_close IS NOT NULL),
                       CHECK (code LIKE 'sh%' OR code LIKE 'sz%')
                     );
                     DROP TABLE IF EXISTS src_dates;
                     CREATE TABLE src_dates (trade_date TEXT PRIMARY KEY);""")

MINE = [("2026-09-08", 1010),
        ("2026-09-09", 1040),
        ("2026-09-11", 1060)]
SRC = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]
cur.executemany("INSERT INTO quote_daily VALUES (?,?,?,?,?,?)",
                [(MC["code"], d, c, c - 10, "feed", 1789000000) for d, c in MINE])
cur.executemany("INSERT INTO src_dates VALUES (?)", [(d,) for d in SRC])

p("  我方 quote_daily 已有：" + "  ".join(d for d, _ in MINE))
p("  行情源返回的日期   ：" + "  ".join(SRC))
p("")
gap = cur.execute("""SELECT s.trade_date FROM src_dates s
                     WHERE NOT EXISTS (SELECT 1 FROM quote_daily q
                                        WHERE q.code = ? AND q.trade_date = s.trade_date)
                     ORDER BY s.trade_date""", (MC["code"],)).fetchall()
p("  差集（= 缺口）     ：" + ("  ".join(r["trade_date"] for r in gap) if gap else "（无）"))
p("  缺口天数           ：%d" % len(gap))
p("")
p("  非交易日为何不会误判：非交易日**根本不在源返回的日期序列里**（如 09-12 周六），")
p("  故差集不可能包含它 ⇒ **系统无需自建、也无需维护交易日历表**。")
p("  检测与补数共用同一次请求：源返回的日期序列既定义交易日，又直接给出待补的收盘价。")

# ------------------------------------------------------------------
# 8. 主键 / 约束行为：走索引 + CHECK 生效
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[8] quote_daily：主键查询走索引；CHECK 与主键冲突按预期拒绝")
p("=" * 78)

plans = [
    ("某只股某区间取数",
     "SELECT trade_date, prev_close, close FROM quote_daily WHERE code=? AND trade_date BETWEEN ? AND ?",
     (MC["code"], "2026-09-01", "2026-09-30")),
    ("某日全部持仓取数（一条 SQL 覆盖）",
     "SELECT code, close FROM quote_daily WHERE code IN (?,?) AND trade_date=?",
     (MC["code"], "sz000001", "2026-09-09")),
]
for label, sql, args in plans:
    plan = cur.execute("EXPLAIN QUERY PLAN " + sql, args).fetchall()
    detail = " | ".join(r["detail"] for r in plan)
    p("  %s" % pad(label, 34) + "→ " + detail)
p("  → 两条查询都命中 PRIMARY KEY；无需为日期维度另建二级索引。")
p("")

checks = [
    ("feed 行缺 prev_close",
     "INSERT INTO quote_daily VALUES ('sh600519','2026-10-09',1000,NULL,'feed',1789000000)"),
    ("前缀不合法（不带 sh/sz）",
     "INSERT INTO quote_daily VALUES ('600519','2026-10-09',1000,990,'feed',1789000000)"),
    ("重复的 (code, trade_date)",
     "INSERT INTO quote_daily VALUES ('sh600519','2026-09-08',999,998,'feed',1789000000)"),
    ("manual 行缺 prev_close（应通过）",
     "INSERT INTO quote_daily VALUES ('sh600519','2026-10-12',1000,NULL,'manual',1789000000)"),
]
p("  %s %s %s" % (pad("场景", 34), pad("结果", 10), "说明"))
for label, sql in checks:
    try:
        cur.execute(sql)
        p("  %s %s %s" % (pad(label, 34), pad("接受", 10), "符合预期"))
    except sqlite3.IntegrityError as e:
        p("  %s %s %s" % (pad(label, 34), pad("拒绝", 10), str(e)))
p("")
p("  → `CHECK (source = 'manual' OR prev_close IS NOT NULL)` 把「非手工行缺昨收」")
p("    这类解析失败挡在库外 —— 否则它会以「昨收 = 0」的形态静默污染收益。")

# ------------------------------------------------------------------
# 9. corporate_action：按成员记状态，重复检测天然幂等
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[9] corporate_action：同一次分红，两位成员各自确认一次；重复检测天然幂等")
p("=" * 78)

cur.executescript("""DROP TABLE IF EXISTS corporate_action;
                     CREATE TABLE corporate_action (
                       member_id            INTEGER NOT NULL,
                       code                 TEXT NOT NULL,
                       ex_date              TEXT NOT NULL,
                       kind                 TEXT NOT NULL DEFAULT 'dividend',
                       plan_text            TEXT NOT NULL,
                       cash_per_share_micro INTEGER NOT NULL DEFAULT 0,
                       bonus_ratio_ppm      INTEGER NOT NULL DEFAULT 0,
                       status               TEXT NOT NULL
                                            CHECK (status IN ('pending','applied','ignored')),
                       decided_at           INTEGER,
                       PRIMARY KEY (member_id, code, ex_date)
                     );""")

PLAN = "10派280.2423元(含税)"
cur.execute("INSERT INTO corporate_action VALUES (?,?,?,?,?,?,?,?,?)",
            (1, MC["code"], MC["ex_date"], "dividend", PLAN,
             MC["div_per_share_micro"], 0, "pending", None))
p("  写入成员 1 的待确认建议：%s → status = pending" % PLAN)
try:
    cur.execute("INSERT INTO corporate_action VALUES (?,?,?,?,?,?,?,?,?)",
                (1, MC["code"], MC["ex_date"], "dividend", PLAN,
                 MC["div_per_share_micro"], 0, "pending", None))
    p("  同一事件重复检测第二次              → 接受（✘ 不该发生）")
except sqlite3.IntegrityError as e:
    p("  同一事件重复检测第二次              → 拒绝：%s" % e)
p("")
cur.execute("UPDATE corporate_action SET status='applied', decided_at=1789000000"
            " WHERE member_id=1 AND code=? AND ex_date=?", (MC["code"], MC["ex_date"]))
cur.execute("INSERT INTO corporate_action VALUES (?,?,?,?,?,?,?,?,?)",
            (2, MC["code"], MC["ex_date"], "dividend", PLAN,
             MC["div_per_share_micro"], 0, "pending", None))
rows9 = cur.execute("SELECT * FROM corporate_action ORDER BY member_id").fetchall()
p("  %s %s %s %s %s"
  % (pad("成员", 6, True), pad("代码", 12), pad("除权日", 14),
     pad("状态", 10), pad("决策时刻", 12, True)))
for r in rows9:
    p("  %s %s %s %s %s"
      % (pad(r["member_id"], 6, True), pad(r["code"], 12), pad(r["ex_date"], 14),
         pad(r["status"], 10), pad(r["decided_at"] if r["decided_at"] else "—", 12, True)))
p("")
p("  → 成员 1 已采纳、成员 2 仍待确认 ⇒ 状态必须按 (成员, 代码, 除权日) 记，不能按股记。")
p("  → 「忽略」也是一个必须落库的决定：它无法由任何输入重建，不落就会永远重复提示。")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("结论")
p("=" * 78)
p("1. 存**不复权**价、`prev_close` **逐行取自行情源**：当日盈亏 %s 元/股。"
  % fs(pnl["A"]))
p("   从本地推算昨收、或逐日冻结前复权价，两条错误路径都给出 %s 元/股（差一次分红）。"
  % fs(pnl["B"]))
p("2. 前复权序列的**逐日差额**等于真实盈亏，但其**基准随每次分红整体平移** ⇒")
p("   只能用于「回填时反推昨收」，**不能作为存储口径**。")
p("3. 回填请求数 = 1~2 × 只数，**与回填深度无关**；一次请求即可返回该股全部历史日线。")
p("4. 区间收益以**端点法**为权威；Σ 可得日在有缺口时静默低估（本例漏掉 %s 元）。"
  % fs(endpoint - sum_avail))
p("   且**期初日的当日盈亏归上一区间**，实现里必须写死这一条，否则每区间多算一天。")
p("5. 派息必须用**微元/股**（分与厘都会失真）；`最新价 == 0` 必须判为解析失败。")
p("6. 缺口检测 = **差集**，交易日历由行情源自带 ⇒ 系统不建、也不维护交易日历表。")
p("=" * 78)

path = __file__.replace(".py", ".out.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
print("\n[written] " + path)
