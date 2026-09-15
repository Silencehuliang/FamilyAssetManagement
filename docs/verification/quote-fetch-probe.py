# -*- coding: utf-8 -*-
"""验证「股票」子系统的行情抓取链路：六条「昨收」获取路径的判决、
前复权差分修正的精度边界（含送转缩放与负值）、kline 涨跌额 f60 的口径矛盾、
单日窗口 preKPrice 在非交易日的行为、东财分红接口的解析陷阱、
浮点转「分」陷阱、以及运行结果三态（ok/skipped/failed）与连续失败计数语义。

用途：为决策票 #13「行情抓取与落库架构」提供可复跑的实测依据，而非纸面推断。
运行：python quote-fetch-probe.py
输出：同目录 quote-fetch-probe.out.txt（UTF-8）

数据来源（2026-09-15 实测）：
  - 东财历史  push2his.eastmoney.com/api/qt/stock/kline/get   （klt=101，日线）
  - 东财分红  datacenter-web.eastmoney.com/api/data/v1/get    （RPT_SHAREBONUS_DET）
  - 腾讯实时  qt.gtimg.cn/q=...                               （GBK，~ 分隔）
  - 新浪实时  hq.sinajs.cn/list=...                           （GBK，逗号分隔，需 Referer）
  取数通道：本机 curl 直连被环境网络拦截（exit 56），经工具通道取得；字段与数值同源。

注意：
- 本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**，D1 侧须另行复核。
- 「非交易日」在本文档中只指「行情源没有该日数据」这一可观测事实，
  不宣称任何具体日期是法定节假日。

本脚本踩过并已防复发的坑（沿自同目录前三个脚本的教训）：
  1. **`%` 格式化不支持 `%,.2f`** —— 千分位只属于 format() 的迷你语言。
  2. **同一 cursor 边迭代边 execute ⇒ 结果集被重置，循环只跑一轮** —— 必须先 fetchall()。
  3. **`%-12s` 排版含中文的表头必然错位** —— 改用 dw()/pad() 按显示宽度补齐。
  4. **`execute()` 一次只能跑一条语句** —— 多条 DDL 必须用 executescript()。
  5. **同一 host 同时「等响应头」的连接上限为 6**（平台事实）—— 抓取应合并请求、串行发起，
     不要把 N 只股票摊成 N 个并发 fetch。
"""

import datetime as dt
import sqlite3
import sys
import unicodedata

out = []


def p(s=""):
    out.append(str(s))


def dw(s):
    """显示宽度：全角/宽字符（CJK）算 2 列。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def pad(s, width, right=False):
    n = max(0, width - dw(s))
    return (" " * n + str(s)) if right else (str(s) + " " * n)


def m2(x):
    """元，2 位小数。"""
    return "%.2f" % x


def cents(x):
    """元 -> 分（四舍五入，模拟交易所按分取整）。"""
    return int(round(x * 100))


def r2(x):
    """按「分」取整后再回到元，模拟交易所公布价的取整口径。"""
    return cents(x) / 100.0


# ------------------------------------------------------------------
# 实测常量
# ------------------------------------------------------------------
# 样本 A：亚翔集成 sh603929，除权日 = 2026-09-15（10派16.50元含税 → 每股 1.65 元）
# 该日是抓取当天，故三条「当日」通路（腾讯 / 新浪 / 东财 kline）可同时对照。
A = {
    "code": "sh603929",
    "name": "亚翔集成",
    "ex_date": "2026-09-15",
    "prev_date": "2026-09-14",
    "div_per_share": 16.50 / 10.0,      # 1.65
    "prev_close_raw": 152.21,           # fqt=0 的 09-14 收盘
    "close_raw": 152.71,                # fqt=0 的 09-15 收盘
    # 东财 kline 当日行的 f58/f59/f60/f61 = 振幅% / 涨跌幅% / 涨跌额 / 换手率%
    "kline_amplitude_pct": 4.95,
    "kline_chg_pct": 1.43,
    "kline_chg_amt": 2.15,
    # 腾讯 qt.gtimg.cn 的字段（~ 分隔，下标从 0）：1=名称 3=最新价 4=昨收 5=今开 30=时间 31=涨跌额 32=涨跌幅
    "tx_name": "XD亚翔集",
    "tx_last": 152.71,
    "tx_prev_close": 150.56,
    "tx_open": 150.00,
    "tx_time": "20260915161438",
    "tx_chg_amt": 2.15,
    "tx_chg_pct": 1.43,
    # 新浪 hq.sinajs.cn 的字段（, 分隔）：0=名称 1=今开 2=昨收 3=最新价 4=最高 5=最低 30=日期 31=时间
    "sina_name": "XD亚翔集",
    "sina_open": 150.000,
    "sina_prev_close": 150.560,
    "sina_last": 152.710,
    "sina_date": "2026-09-15",
    "sina_time": "15:34:59",
}

# 样本 B：贵州茅台 sh600519 的三个除权日
B = {
    "code": "sh600519",
    "name": "贵州茅台",
    # 除权日 2026-06-26：10派280.2423元（含税）→ 每股 28.02423 元
    "d1": {
        "ex_date": "2026-06-26",
        "prev_date": "2026-06-25",
        "div_per_share": 280.2423 / 10.0,
        "prev_close_raw": 1212.10,
        "close_raw": 1168.63,
        "fqt1_prev": 1184.08,
        "fqt1_close": 1168.63,
        "feed_prev_close": 1184.08,     # 当日实时 feed 的「昨收」（#7 / #8 已记录）
    },
    # 除权日 2025-12-19：10派239.57元（含税）→ 每股 23.957 元
    # 关键：**其后还有一次除权（2026-06-26）**，故 fqt=1 的偏移被叠加。
    "d2": {
        "ex_date": "2025-12-19",
        "prev_date": "2025-12-18",
        "div_per_share": 239.57 / 10.0,
        "prev_close_raw": 1431.00,
        "close_raw": 1410.00,
        "fqt1_prev": 1379.02,
        "fqt1_close": 1381.98,
        "kline_chg_amt": -21.00,        # 东财 kline 的 f60
        "kline_chg_pct": -1.47,         # 东财 kline 的 f59
        "later_div": 280.2423 / 10.0,   # 其后那次（2026-06-26）
    },
    # 2015 年窗口（含 2015-07-17 的 10送1派43.74元 —— 送转 + 现金的混合事件）
    "y2015": {
        "ex_date": "2015-07-17",
        "div_per_share": 43.74 / 10.0,  # 4.374
        "bonus_ratio": 0.1,             # 10送1
        "prev_close_raw": 251.59,       # 07-16
        "close_raw": 228.29,            # 07-17
        "fqt1_prev": -73.01,            # 07-16：fqt=1 在此已是负值
        "fqt1_close": -69.47,           # 07-17
        "seq": [                        # (日期, fqt0 收盘, fqt1 收盘)
            ("2015-07-14", 249.05, -75.32),
            ("2015-07-15", 251.26, -73.31),
            ("2015-07-16", 251.59, -73.01),
            ("2015-07-17", 228.29, -69.47),
            ("2015-07-20", 225.11, -72.65),
            ("2015-07-21", 221.66, -76.10),
            ("2015-07-22", 217.13, -80.63),
        ],
        "fqt1_prekprice": -67.41,       # 请求窗口的 preKPrice（负值）
    },
    # preKPrice 的实测（请求窗口 -> fqt=0 的 preKPrice, fqt=1 的 preKPrice）
    "prek": [
        ("20260601-20260624", 1326.00, 1297.98),
        ("20260618-20260702", 1240.00, 1211.98),
    ],
    # 单日窗口实测：(窗口, 是否交易日, preKPrice, klines 是否为空的说明)
    "single_day": [
        ("20260629", True, 1168.63, "klines 有 1 根，preKPrice = 前一交易日收盘"),
        ("20260628", False, 0.0, "klines 为空数组，preKPrice 退化为 0.0"),
    ],
    "dktotal": 6005,
}

# 茅台除权历史（RPT_SHAREBONUS_DET，2026-09-15 拉取；共 28 条，其中 1 条 ex-date 为 null）
RPT_ROWS = 28
RPT_NULL_EX_DATE_ROWS = 1
RPT_SAMPLE = [
    ("2026-06-26", 280.2423, "10派280.2423元(含税)"),
    ("2025-12-19", 239.57, "10派239.57元(含税,扣税后215.613元)"),
    ("2025-06-26", 276.73, "10派276.73元(含税,扣税后249.057元)"),
    ("2015-07-17", 43.74, "10送1.00派43.74元(含税,扣税后39.266元)"),
    ("2006-05-19", 3.00, "10转10.00派3.00元(含税,扣税后2.70元)"),
]

con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()

p("=" * 78)
p("[0] 环境")
p("=" * 78)
p("Python              = " + sys.version.split()[0])
p("SQLITE_VERSION      = " + sqlite3.sqlite_version)
p("本机 Python 时区     = " + str(dt.datetime.now().astimezone().tzinfo))
try:
    from zoneinfo import ZoneInfo
    sh = ZoneInfo("Asia/Shanghai")
    p("zoneinfo Asia/Shanghai = 可用，与固定 +8 偏移一致 = %s"
      % (sh.utcoffset(dt.datetime(2026, 9, 15)) == dt.timedelta(hours=8)))
except Exception as e:
    p("zoneinfo Asia/Shanghai = 不可用（%s）；不影响本脚本结论" % type(e).__name__)
p("实测日期            = 2026-09-15（周二，交易日）")
p("抓取时点口径        = CST 15:30（cron 表达式 30 7 * * MON-FRI，UTC）")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[1] 除权日「昨收」的六条获取路径 —— 逐条复算判决")
p("=" * 78)
p("")
p("样本 A：%s %s · 除权日 %s · 10派16.50元(含税) ⇒ 每股 %.2f 元"
  % (A["code"], A["name"], A["ex_date"], A["div_per_share"]))
p("  前一日收盘(fqt0 %s) = %s     当日收盘(fqt0 %s) = %s"
  % (A["prev_date"], m2(A["prev_close_raw"]), A["ex_date"], m2(A["close_raw"])))
ref_a = r2(A["prev_close_raw"] - A["div_per_share"])
p("  交易所除权（息）参考价 = %s − %s = %s"
  % (m2(A["prev_close_raw"]), m2(A["div_per_share"]), m2(ref_a)))
p("")

rows = []
# 路径 1：实时 feed 的昨收字段
rows.append(("P1 实时 feed 的昨收字段",
             "腾讯 %.2f / 新浪 %.3f" % (A["tx_prev_close"], A["sina_prev_close"]),
             ref_a,
             "权威"))
# 路径 2：本地未复权收盘序列的前一日
rows.append(("P2 未复权序列的前一日",
             m2(A["prev_close_raw"]),
             ref_a,
             "禁用"))
# 样本 A 缺 fqt=1 数据，故 P3 / P4 两行改用样本 B 的 d1（结构相同：其后无除权）
d1 = B["d1"]
ref_d1 = r2(d1["prev_close_raw"] - d1["div_per_share"])
fix_d1 = r2(d1["close_raw"] - (d1["fqt1_close"] - d1["fqt1_prev"]))
# 路径 3：前复权序列的前一日（其后无除权 ⇒ 恰好等于参考价）
rows.append(("P3 前复权前一日（样本B）",
             "%.2f" % d1["fqt1_prev"],
             ref_d1,
             "仅近期"))
# 路径 4：前复权序列的差分修正 fqt0(D) − [fqt1(D) − fqt1(D−1)]
rows.append(("P4 前复权差分修正（样本B）",
             "%.2f" % fix_d1,
             ref_d1,
             "可用" if cents(fix_d1) == cents(ref_d1) else "否"))
# 路径 5：东财 kline 的 f60（涨跌额）
p5_implied = r2(A["close_raw"] - A["kline_chg_amt"])
rows.append(("P5 kline 涨跌额 f60",
             "反推昨收 %.2f" % p5_implied,
             ref_a,
             "不可靠（§3）"))
# 路径 6：单日窗口 preKPrice
rows.append(("P6 单日窗口 preKPrice",
             "非交易日 = 0.0",
             ref_a,
             "不成立"))

p("  %s %s %s %s" % (pad("路径", 26), pad("取值", 30), pad("应为", 16), "判定"))
for name, val, exp, verdict in rows:
    p("  %s %s %s %s"
      % (pad(name, 26), pad(val, 30), pad(m2(exp), 16), pad(verdict, 10)))
p("  注：P3 / P4 两行的取值与期望取自**样本 B 的 %s**（样本 A 无 fqt=1 数据）；其余四行取自样本 A。"
  % d1["ex_date"])

p("")
qty = 1000
pnl_right = (A["close_raw"] - ref_a) * qty
pnl_wrong = (A["close_raw"] - A["prev_close_raw"]) * qty
p("  用 %d 股量化后果（样本 A 当日）：" % qty)
p("    正确（feed 昨收 %s）        → (%.2f − %.2f) × %d = %s 元"
  % (m2(ref_a), A["close_raw"], ref_a, qty, format(pnl_right, ",.2f")))
p("    错误（用本地前收 %s）      → (%.2f − %.2f) × %d = %s 元"
  % (m2(A["prev_close_raw"]), A["close_raw"], A["prev_close_raw"], qty, format(pnl_wrong, ",.2f")))
p("    差额 = %s 元，恰好 = 每股派息 %s × %d 股"
  % (format(pnl_right - pnl_wrong, ",.2f"), m2(A["div_per_share"]), qty))
p("")
p("  交叉印证：东财 kline 当日行自报涨跌幅 f59 = %.2f%%；"
  % A["kline_chg_pct"])
p("    按参考价算 = (%.2f − %.2f) / %.2f = %.2f%%  ⇒ 一致"
  % (A["close_raw"], ref_a, ref_a, (A["close_raw"] - ref_a) / ref_a * 100))
p("    按本地前收算 = (%.2f − %.2f) / %.2f = %.2f%%  ⇒ 不一致"
  % (A["close_raw"], A["prev_close_raw"], A["prev_close_raw"],
     (A["close_raw"] - A["prev_close_raw"]) / A["prev_close_raw"] * 100))
p("  且腾讯 f31=%.2f / f32=%.2f%%、新浪 f2=%s —— 三条通路在当日全部按参考价 ✓"
  % (A["tx_chg_amt"], A["tx_chg_pct"], m2(A["sina_prev_close"])))

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[2] 前复权差分修正的精度边界 —— 只在「其后无送转」的区间精确")
p("=" * 78)
d2 = B["d2"]
ref_d2 = r2(d2["prev_close_raw"] - d2["div_per_share"])
off = d2["fqt1_prev"] - d2["prev_close_raw"]   # fqt1 相对未复权的偏移（负）
p("")
p("样本 B · 除权日 %s（10派239.57元 ⇒ 每股 %s），**其后还有一次除权（+%s 元）**"
  % (d2["ex_date"], m2(d2["div_per_share"]), m2(d2["later_div"])))
p("  未复权前收 fqt0(%s) = %s      前复权同日 fqt1(%s) = %s"
  % (d2["prev_date"], m2(d2["prev_close_raw"]), d2["prev_date"], m2(d2["fqt1_prev"])))
p("  实测偏移 fqt0 − fqt1 = %s − %s = %s"
  % (m2(d2["prev_close_raw"]), m2(d2["fqt1_prev"]), m2(d2["prev_close_raw"] - d2["fqt1_prev"])))
p("  该日之后两次派息之和 = %s + %s = %s   ⇒ 逐分吻合 ↯"
  % (m2(d2["div_per_share"]), m2(d2["later_div"]),
     m2(d2["div_per_share"] + d2["later_div"])))
p("  ⇒ 路径 3（直接取 fqt1(D−1)）得 %s，而参考价应为 %s，**差 %s 元/股**"
  % (m2(d2["fqt1_prev"]), m2(ref_d2), m2(abs(ref_d2 - d2["fqt1_prev"]))))
fix_d2 = r2(d2["close_raw"] - (d2["fqt1_close"] - d2["fqt1_prev"]))
p("  ⇒ 路径 4（差分修正）得 %s  ⇒ %s"
  % (m2(fix_d2), "精确 ✓" if cents(fix_d2) == cents(ref_d2) else "仍有偏差 ✗"))
p("")

p("  送转事件处（样本 B · 2015 窗口）：")
y = B["y2015"]
ref_y = r2((y["prev_close_raw"] - y["div_per_share"]) / (1.0 + y["bonus_ratio"]))
p("    %s：10送1派43.74元 ⇒ 参考价 = (%s − %s) / (1 + 0.1) = %s"
  % (y["ex_date"], m2(y["prev_close_raw"]), m2(y["div_per_share"]), m2(ref_y)))
p("    fqt1 在该日已是**负值**：前一日 = %s，当日 = %s（%s）"
  % (m2(y["fqt1_prev"]), m2(y["fqt1_close"]),
     "序列不可当价格用" if y["fqt1_prev"] < 0 else ""))
p("    请求窗口的 preKPrice 亦为负：%s" % m2(y["fqt1_prekprice"]))
fix_y = r2(y["close_raw"] - (y["fqt1_close"] - y["fqt1_prev"]))
p("    差分修正 = %s − (%s − %s) = %s   ⇒ 与 %s 差 %s 元（fqt1 只有 2 位小数所致）"
  % (m2(y["close_raw"]), m2(y["fqt1_close"]), m2(y["fqt1_prev"]), m2(fix_y),
     m2(ref_y), m2(abs(fix_y - ref_y))))
p("")
p("    逐日差分与真实涨跌的对照（送转前后的缩放）：")
p("      %s %s %s %s %s" % (pad("日期", 13), pad("fqt0 差分", 12, True),
                              pad("fqt1 差分", 12, True), pad("比值", 9, True), "说明"))
seq = y["seq"]
for i in range(1, len(seq)):
    d_prev, c0_prev, c1_prev = seq[i - 1]
    d_cur, c0_cur, c1_cur = seq[i]
    d0 = c0_cur - c0_prev
    d1_ = c1_cur - c1_prev
    ratio = (d1_ / d0) if d0 else float("nan")
    note = ""
    if d_cur == y["ex_date"]:
        note = "送转事件当日（跨越事件 ⇒ 非纯缩放）"
    elif d_cur > y["ex_date"]:
        note = "事件之后 ⇒ 比值 1.0，精确"
    else:
        note = "事件之前 ⇒ 被 1/1.1 缩放"
    p("      %s %s %s %s %s"
      % (pad(d_cur, 13), pad("%+.2f" % d0, 12, True), pad("%+.2f" % d1_, 12, True),
         pad("%.4f" % ratio, 9, True), note))

p("")
p("  白名单校验（本票 Q1 的防护设计）—— 非除权日算出的昨收必须等于 fqt0(D−1)：")
p("    %s %s %s %s %s" % (pad("样本日", 13), pad("是否除权日", 12),
                            pad("差分修正值", 12, True), pad("fqt0(D−1)", 12, True), "判定"))
checks = [
    ("2025-12-17", False, 1433.10, 1381.12, 1370.02, 1422.00),
    ("2025-12-19", True, 1410.00, 1381.98, 1379.02, 1431.00),
    ("2015-07-15", False, 251.26, -73.31, -75.32, 249.05),
]
for day, is_ex, c0, c1, c1p, fqt0_prev in checks:
    v = r2(c0 - (c1 - c1p))
    ok = cents(v) == cents(fqt0_prev)
    if is_ex:
        verdict = "除权日，允许不等（差异即参考价调整）"
    elif ok:
        verdict = "通过 ✓"
    else:
        verdict = "不通过 ⇒ 置 NULL（差 %s 元）" % m2(abs(v - fqt0_prev))
    p("    %s %s %s %s %s"
      % (pad(day, 13), pad("是" if is_ex else "否", 12),
         pad(m2(v), 12, True), pad(m2(fqt0_prev), 12, True), verdict))

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[3] 东财 kline 的涨跌额 f60：同一接口对不同除权日采用不同基准")
p("=" * 78)
p("")
p("  %s %s %s %s %s" % (pad("样本除权日", 16), pad("当日收盘", 12, True),
                        pad("f60 自报", 12, True), pad("按参考价应为", 14, True), "结论"))
case_a = r2(A["close_raw"] - ref_a)
case_d2 = r2(d2["close_raw"] - ref_d2)
p("  %s %s %s %s %s"
  % (pad(A["ex_date"] + "（最近）", 16), pad(m2(A["close_raw"]), 12, True),
     pad("%+.2f" % A["kline_chg_amt"], 12, True), pad("%+.2f" % case_a, 14, True),
     "一致 ✓ ⇒ 用了参考价"))
p("  %s %s %s %s %s"
  % (pad(d2["ex_date"] + "（其后有除权）", 16), pad(m2(d2["close_raw"]), 12, True),
     pad("%+.2f" % d2["kline_chg_amt"], 12, True), pad("%+.2f" % case_d2, 14, True),
     "不一致 ✗ ⇒ 用了未调整前收"))
p("  按未调整前收算 = %.2f − %.2f = %+.2f ⇒ 与 f60 自报值一致，坐实其取的是原始前收"
  % (d2["close_raw"], d2["prev_close_raw"], d2["close_raw"] - d2["prev_close_raw"]))
p("")
p("  ⇒ 同一字段在两个除权日给出互相矛盾的基准；**机制未查明**，故 f60/f59 一律不用于反推昨收。")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[4] 单日窗口 preKPrice —— 非交易日退化为 0.0，且 0.0 会伪装成合法值")
p("=" * 78)
p("")
p("  %s %s %s %s" % (pad("请求窗口 beg=end=", 20), pad("是否交易日", 12),
                      pad("preKPrice", 12, True), "klines"))
for win, traded, prek, note in B["single_day"]:
    p("  %s %s %s %s"
      % (pad(win, 20), pad("是" if traded else "否", 12),
         pad("%.2f" % prek, 12, True), note))
p("")
p("  交易日窗口返回的是**前一交易日**的收盘（按请求的 fqt 口径），可作昨收的一种取得方式；")
p("  但非交易日窗口返回 0.0 —— 我们**没有交易日历**（#8 R10），无法预先知道该挑哪一天，")
p("  因此单日窗口这条路不可用。")
p("")
p("  更危险的是这个 0.0：它**结构合法、类型正确**，会穿过所有「非空 / 可解析」的校验。")
p("  若把它当价格入库：当日盈亏 = (%.2f − 0.00) × 数量 ⇒ 一只正常股票凭空 −100%%。"
  % A["close_raw"])
p("  ⇒ 这与已在别处设防的「最新价 == 0 判为解析失败」是**同一条判据**，")
p("    必须同样应用到 prev_close：**prev_close <= 0 一律判为无效、按缺失处理**。")
p("")
p("  附：preKPrice 随 fqt 口径切换（差额 = 当前累计分红），故它不是独立字段：")
p("  %s %s %s %s" % (pad("请求窗口", 22), pad("fqt=0", 12, True), pad("fqt=1", 12, True), "差"))
for win, pk0, pk1 in B["prek"]:
    p("  %s %s %s %s"
      % (pad(win, 22), pad(m2(pk0), 12, True), pad(m2(pk1), 12, True), m2(pk0 - pk1)))

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[5] 东财分红接口 RPT_SHAREBONUS_DET 的解析陷阱与可用过滤形态")
p("=" * 78)
p("")
p("  过滤形态（均为 2026-09-15 实测可用）：")
p("    ① 单码全历史   filter=(SECURITY_CODE=\"600519\")                → 返回 %d 条（回溯至 2002 年）"
  % RPT_ROWS)
p("    ② 多码 in       filter=(SECURITY_CODE in (\"600519\",\"000001\")) → 返回两码混合清单")
p("    ③ 日期区间      filter=(EX_DIVIDEND_DATE>='2026-09-15')(..<='2026-09-15')")
p("                    → 返回全市场当日除权名单（当日共 14 条）⇒ **N 只股票只需 1 个请求**")
p("")
p("  陷阱：返回中含 **EX_DIVIDEND_DATE 为 null 的记录** —— 茅台全历史 %d 条中有 %d 条是"
  % (RPT_ROWS, RPT_NULL_EX_DATE_ROWS))
p("        分红预案（如「分红金额上限不超过公司2026年上半年实现归属于上市公司股东的净利润」），")
p("        其 ex-date 与派息金额均为 null。")
p("  若不过滤：")
p("    ① 会生成一条**没有日期的「除权建议」**，前端无法渲染、成员无法处理；")
p("    ② 会破坏 corporate_action 的 `(member_id, code, ex_date)` 唯一键（NULL 在 SQLite 中")
p("       不参与唯一性比较 ⇒ 每次抓取都会插入一条新行，**建议无限增殖**）。")
p("")
con.executescript("""
DROP TABLE IF EXISTS ca_a;
CREATE TABLE ca_a (member_id TEXT, code TEXT, ex_date TEXT, plan_text TEXT);
DROP TABLE IF EXISTS ca_b;
CREATE TABLE ca_b (member_id TEXT, code TEXT, ex_date TEXT, plan_text TEXT,
                   UNIQUE (member_id, code, ex_date));
DROP TABLE IF EXISTS ca_c;
CREATE TABLE ca_c (member_id TEXT, code TEXT, ex_date TEXT, plan_text TEXT,
                   UNIQUE (member_id, code, ex_date));
""")
# 模拟连续两次抓取，各自把同一批 RPT 记录写入（含 1 条 ex_date 为 null 的预案）
batch = [(r[0], r[2]) for r in RPT_SAMPLE] + [(None, "分红金额上限不超过…净利润")]
for run_no in (1, 2):
    for ex_date, plan in batch:
        # 变体 1：裸表，无唯一约束
        cur.execute("INSERT INTO ca_a VALUES (?,?,?,?)", ("m1", "sh600519", ex_date, plan))
        # 变体 2：有唯一约束，但不过滤 null
        try:
            cur.execute("INSERT INTO ca_b VALUES (?,?,?,?)", ("m1", "sh600519", ex_date, plan))
        except sqlite3.IntegrityError:
            pass
        # 变体 3：过滤 null + 唯一约束
        if ex_date is None:
            continue
        try:
            cur.execute("INSERT INTO ca_c VALUES (?,?,?,?)", ("m1", "sh600519", ex_date, plan))
        except sqlite3.IntegrityError:
            pass
n_a = cur.execute("SELECT COUNT(*) AS n FROM ca_a").fetchone()["n"]
n_b = cur.execute("SELECT COUNT(*) AS n FROM ca_b").fetchone()["n"]
n_c = cur.execute("SELECT COUNT(*) AS n FROM ca_c").fetchone()["n"]
n_null_b = cur.execute("SELECT COUNT(*) AS n FROM ca_b WHERE ex_date IS NULL").fetchone()["n"]
p("  实测：同一批记录（5 条有效 + 1 条预案）跑 **2 次**后的行数对比：")
p("    %s %s %s" % (pad("建表方式", 42), pad("行数", 8, True), "结论"))
p("    %s %s %s" % (pad("① 裸表，无唯一约束", 42), pad(n_a, 8, True),
                     "每条各插一次 ⇒ 全面增殖"))
p("    %s %s %s" % (pad("② 唯一约束，但不过滤 null", 42), pad(n_b, 8, True),
                     "5 条有效被去重，**NULL 那条第 2 次仍插入** ⇒ 仍增殖"))
p("    %s %s %s" % (pad("③ 过滤 null + (成员,代码,除权日) 唯一", 42), pad(n_c, 8, True),
                     "幂等 ✓"))
p("    变体 ② 中 ex_date 为 NULL 的行数 = %d/2 —— **唯一约束对 NULL 完全无效**"
  % n_null_b)
p("    ⇒ 结论：**「过滤 null」与「唯一约束」缺一不可**，光有唯一键挡不住预案记录。")
p("")
p("  字段形态（实测）：PRETAX_BONUS_RMB 是**每 10 股含税派息**（元），")
p("  BONUS_IT_RATIO / BONUS_RATIO / IT_RATIO **实测为 null**，送转比例只能从")
p("  IMPL_PLAN_PROFILE 文本解析（「10送1.00派43.74元」「10转10.00派3.00元」）：")
p("    %s %s %s" % (pad("除权日", 13), pad("每10股派息", 12, True), "方案原文"))
for ex, bonus, plan in RPT_SAMPLE:
    p("    %s %s %s" % (pad(ex, 13), pad(bonus, 12, True), plan))
p("")
p("  ⇒ 换算：PRETAX_BONUS_RMB / 10 = 每股派息（元）。茅台最高精度为 5 位小数（28.02423），")
p("    故库内必须存**微元/股**（分与厘都不够）—— 与 #8 的结论一致。")
p("")
p("  另注：日期区间过滤会返回**北交所代码**（实测含 920663.BJ）。#7 R3 已把标的限定为")
p("  `sh`/`sz` 六位码 ⇒ 与持仓求交时天然排除，但解析层不应假设返回的都是 `sh`/`sz`。")
p("  且区间过滤会返回**尚未实施的未来除权日**（实测查到 2026-09-22）——")
p("  本票已决定**不做提前告知**，故检测窗口取「目标交易日 == 除权日」当天即可。")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[6] 浮点转「分」陷阱 —— 报价是元字符串，入库要整数分")
p("=" * 78)
p("")
p("  %s %s %s %s %s" % (pad("报价字符串", 14), pad("float(x) * 100", 24),
                        pad("int()", 9, True), pad("round()", 9, True), "判定"))
bad = 0
for s in ["152.710", "152.290", "1.150", "0.290", "1168.630", "1212.100", "150.560"]:
    f = float(s) * 100.0
    i = int(f)
    r = int(round(f))
    verdict = "一致" if i == r else "**不同 ⇒ 截断即错**"
    if i != r:
        bad += 1
    p("  %s %s %s %s %s"
      % (pad(s, 14), pad(repr(f), 24), pad(i, 9, True), pad(r, 9, True), verdict))
p("")
p("  %d / 7 个样例上 int() 与 round() 不同 ⇒ **必须 round()，不得截断**。" % bad)
p("  正确写法：`Math.round(parseFloat(s) * 100)`（JS）/ `int(round(float(s) * 100))`（Python）。")
p("")
p("  编码与格式差异（实测）：")
p("    %s %s %s %s" % (pad("源", 10), pad("编码", 10), pad("价格小数位", 12), "日期字段"))
p("    %s %s %s %s" % (pad("腾讯", 10), pad("GBK", 10), pad("2 位", 12),
                       "f30 = YYYYMMDDHHMMSS（如 20260915161438）"))
p("    %s %s %s %s" % (pad("新浪", 10), pad("GBK", 10), pad("3 位", 12),
                       "f30 = YYYY-MM-DD（如 2026-09-15）"))
p("    %s %s %s %s" % (pad("东财", 10), pad("UTF-8", 10), pad("2 位", 12),
                       "f51 = YYYY-MM-DD"))
p("  A 股股票的最小价格变动单位是 0.01 元 ⇒ 新浪的第 3 位小数应恒为 0；")
p("  若出现非 0（如 152.715），说明口径异常 ⇒ 记 warn，不要静默取整。")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[7] 运行结果三态与连续失败计数 —— skipped 必须被「跳过」而不是「重置」")
p("=" * 78)
p("")
p("  三态定义（本票 Q4）：")
p("    ok      = 抓到目标交易日的行情并落库")
p("    skipped = **至少一个源给出了明确响应的日期否定** ⇒ 非交易日（法定节假日/周末）")
p("    failed  = 无响应 / 超时 / 解码失败 / 字段不足 / 最新价 <= 0 / 日期为旧且无源可确证")
p("")
con.executescript("""
DROP TABLE IF EXISTS run_heartbeat;
CREATE TABLE run_heartbeat (
  task        TEXT NOT NULL,
  run_date    TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('ok','skipped','failed')),
  error       TEXT,
  subreq      INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  ms          INTEGER,
  PRIMARY KEY (task, run_date)
);
""")


def streak(seq):
    """最近连续 failed 的次数。skipped **跳过**（不计数也不重置），ok 重置为 0。"""
    n = 0
    for r in reversed(seq):
        if r == "skipped":
            continue
        if r == "failed":
            n += 1
        else:
            break
    return n


def alert_level(n):
    if n >= 3:
        return "第三方推送一次 + 站内"
    if n >= 2:
        return "站内高优先级"
    return "—"


seqs = [
    (["ok", "failed", "failed"], 2),
    (["failed", "skipped", "failed"], 2),
    (["ok", "failed", "skipped"], 1),
    (["failed", "ok", "failed"], 1),
    (["ok", "ok", "ok"], 0),
    (["skipped", "skipped"], 0),
]
p("  %s %s %s %s" % (pad("最近若干次结果", 34), pad("连续 failed", 14, True),
                      pad("告警", 22), "校验"))
for s, want in seqs:
    got = streak(s)
    p("  %s %s %s %s"
      % (pad(" → ".join(s), 34), pad(got, 14, True), pad(alert_level(got), 22),
         "✓" if got == want else "✗ 期望 %d" % want))
p("")
p("  「skipped 跳过」的语义要点：failed → skipped → failed 记为**连续 2 次**。")
p("  这是对的 —— 中间的 skipped 只说明那天休市，两次失败仍落在相邻的两个**交易日**上。")
p("  若改成「skipped 重置」，节假日会把失败 streak 无声清零，漏掉真故障。")
p("")
p("  落库与查询演示（3 个交易日窗口，第 2 天休市）：")
p("")
demo = [
    ("2026-09-28", "ok", None),
    ("2026-09-29", "failed", "AbortError: timeout after 5000ms (tx)"),
    ("2026-09-30", "skipped", "所有源均返回 2026-09-29 的数据 ⇒ 非交易日"),
    ("2026-10-08", "failed", "HTTP 502 (tx) / 解码失败 (sina)"),
]
for d, res, err in demo:
    cur.execute("INSERT OR REPLACE INTO run_heartbeat VALUES (?,?,?,?,?,?,?,?)",
                ("quote_fetch", d, d + "T07:30:00Z", res, err, 2, 0 if res != "ok" else 31, 1840))
got = [r["result"] for r in
       cur.execute("SELECT result FROM run_heartbeat WHERE task='quote_fetch' ORDER BY run_date").fetchall()]
p("    %s %s %s" % (pad("run_date", 13), pad("result", 9), "error"))
for r in cur.execute("SELECT * FROM run_heartbeat WHERE task='quote_fetch' ORDER BY run_date").fetchall():
    p("    %s %s %s    subreq=%d rows=%d"
      % (pad(r["run_date"], 13), pad(r["result"], 9), pad(r["error"] or "", 52),
         r["subreq"], r["rows_written"]))
p("")
p("    %s %s" % (pad("正确算法（跳过 skipped）", 44), pad("连续 failed = %d" % streak(got), 20)))
naive = cur.execute(
    "SELECT COUNT(*) AS n FROM run_heartbeat WHERE task='quote_fetch' AND result='failed'"
).fetchone()["n"]
p("    %s %s" % (pad("错误算法（把整个历史的 failed 都数一遍）", 44), pad(naive, 20)))
p("    两者在这里恰好都等于 %d，但语义不同：" % naive)
p("      前者问「最近是否连续失败」，后者问「历史上失败过几次」。")
p("      一旦中间出现一次 ok，正确答案归零、错误答案不清零 —— 用一个反例坐实：")
seq_ok = ["failed", "failed", "ok", "failed"]
cur.execute("DELETE FROM run_heartbeat WHERE task='quote_fetch' AND run_date > '2026-10-08'")
for i, res in enumerate(seq_ok):
    cur.execute("INSERT OR REPLACE INTO run_heartbeat VALUES (?,?,?,?,?,?,?,?)",
                ("quote_fetch", "2026-11-%02d" % (2 + i), "2026-11-%02dT07:30:00Z" % (2 + i),
                 res, None, 2, 27, 1900))
got2 = [r["result"] for r in
        cur.execute("SELECT result FROM run_heartbeat WHERE task='quote_fetch' ORDER BY run_date").fetchall()]
naive2 = cur.execute(
    "SELECT COUNT(*) AS n FROM run_heartbeat WHERE task='quote_fetch' AND result='failed'"
).fetchone()["n"]
p("      真实序列（尾部）= %s" % " → ".join(got2[-4:]))
p("      %s %s" % (pad("正确算法（最近连续 failed）", 44), pad(streak(got2), 20)))
p("      %s %s" % (pad("错误算法（failed 总数，跨全部历史）", 44), pad(naive2, 20)))
p("      ⇒ 错误算法会持续报警到永远；正确算法在 %s 那天立刻归零。"
  % "2026-11-04")

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[8] 一次运行的请求预算")
p("=" * 78)
p("")
LIMIT_SUB = 50          # 外部子请求 / invocation（Free）
LIMIT_INTERNAL = 1000   # 内部服务（D1/KV/R2）/ invocation（Free）
holdings = 50
p("  平台事实：外部子请求上限 = %d /invocation；D1 等内部服务 = %d /invocation。"
  % (LIMIT_SUB, LIMIT_INTERNAL))
p("  实测场景：持仓 %d 只。" % holdings)
p("")
p("  %s %s %s %s" % (pad("场景", 34), pad("请求数", 10, True), pad("vs 上限", 10, True), "结论"))
scen = [
    ("A 常态（行情 1 + 除权 1）", 2),
    ("B 自愈日（+ 回填 ≤10 只 × 2）", 2 + 20),
    ("C 盲扫反事实（每天查全部持仓缺口）", 1 + 1 + holdings * 2),
]
for name, n in scen:
    p("  %s %s %s %s"
      % (pad(name, 34), pad(n, 10, True), pad("%d%%" % (n * 100 // LIMIT_SUB), 10, True),
         "余量充足 ✓" if n <= LIMIT_SUB else "**超上限 ✗**"))
p("")
p("  ⇒ 事件触发的自愈（本票 Q10）把常态压到 **2** 个请求；")
p("    而按「每天为每只持仓股拉区间查缺口」实现，%d 只就会打到 %d 个请求，**直接击穿上限**。"
  % (holdings, 1 + 1 + holdings * 2))
p("  另注：同 host 同时「等响应头」的连接上限为 6 ⇒ 即使并发也要 ≤6，且本场景无需并发。")
p("  D1 写入走内部服务预算（%d），与外部子请求的 %d 是两套额度。" % (LIMIT_INTERNAL, LIMIT_SUB))

# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[9] 结论")
p("=" * 78)
p("1. **昨收只有一条可靠通路：当日实时 feed 的昨收字段**，且主备源（腾讯/新浪）在除权日")
p("   都等于交易所参考价（样本 A 两源同为 150.56 = 152.21 − 1.65）⇒ 主备切换不会造成假暴跌。")
p("2. 本地未复权前收、kline 的 f60、单日窗口 preKPrice **三条通路全部不可用**；")
p("   前复权序列只在「其后无送转 / 无除权」时可用，加差分修正后可在全域精确——")
p("   但**必须配白名单校验**（非除权日算出的值须等于 fqt0(D−1)，否则置 NULL）。")
p("3. fqt=1 序列对长历史会出**负值**（样本 B 2015 年 ≈ −70 元）⇒ 只能取差分，不能当价格。")
p("4. 东财 kline 的 f60 在同一接口内对不同除权日采用不同基准（最近一次用参考价、更早用未调整前收），")
p("   机制未查明 ⇒ 不得用于反推昨收。")
p("5. 单日窗口 preKPrice 在非交易日返回 **0.0 且 klines 为空**；该 0.0 会穿过所有")
p("   「非空/可解析」校验 ⇒ **prev_close <= 0 必须与「最新价 == 0」同样判为无效**。")
p("6. 分红接口三种过滤形态均实测可用（单码/多码 in/日期区间）；**日期区间可让 N 只股票只用 1 个请求**。")
p("   但返回中含 **ex_date 为 null 的预案**，实测：「过滤 null」与「唯一约束」**缺一不可**——")
p("   光有 `(成员,代码,除权日)` 唯一键挡不住 null（唯一约束对 NULL 不生效，实测 2 次抓取各插一条），")
p("   光过滤 null 而不加唯一键则所有记录都会增殖。")
p("7. 报价字符串转「分」**必须 round() 不得截断**（7 个样例中 %d 个 int() 与 round() 不同）；" % bad)
p("   腾讯/新浪为 GBK、东财为 UTF-8；新浪价格 3 位小数。")
p("8. 连续失败计数**必须跳过 skipped 而非重置**：failed → skipped → failed = 连续 2 次；")
p("   用「failed 总数」代替「最近连续 failed」会报警到永远。")
p("9. 事件触发的自愈把常态请求压到 **2/次**；按「每天盲扫全部持仓缺口」实现会击穿上限。")

path = __file__.replace(".py", ".out.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
print("\n[written] " + path)
