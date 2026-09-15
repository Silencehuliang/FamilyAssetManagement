# -*- coding: utf-8 -*-
"""验证「汇报」的时间口径：CST 周期边界、UTC 天真分组陷阱、周期键幂等重跑判重、
以及 4 条 Cron 表达式到 CST 时点的换算与撞车检查。

用途：为决策票 #6「时间口径与汇报生成机制」提供可复跑的实测依据，而非纸面推断。
运行：python report-period-probe.py
输出：同目录 report-period-probe.out.txt（UTF-8）

注意：
- 本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**，D1 侧须另行复核。
- 本机 OS 时区即东八区，因此 `datetime('now','localtime')` 在本机会给出 CST；
  而 D1 运行时本地时区是 UTC（官方事实，见 cloudflare-cron-and-timezone-facts.md §6）。
  **同一条 SQL 在两处含义不同** —— 这正是「SQL 内禁用 localtime」这条纪律的来源。
  本脚本刻意把这个差异打出来。
"""

import datetime as dt
import sqlite3

CST = dt.timezone(dt.timedelta(hours=8), "CST")   # 中国自 1991 年起无夏令时，固定 +8 即精确
UTC = dt.timezone.utc

out = []


def p(s=""):
    out.append(str(s))


# ------------------------------------------------------------------
# 0. 应用层的周期边界与周期键（全部按 Asia/Shanghai 计算）
# ------------------------------------------------------------------
def cst(y, mo, d, hh=0, mi=0, ss=0):
    return dt.datetime(y, mo, d, hh, mi, ss, tzinfo=CST)


def utc_sec(x):
    return int(x.astimezone(UTC).timestamp())


def week_key(d):
    """ISO 8601 周键，周一起始。"""
    y, w, _ = d.isocalendar()
    return "%d-W%02d" % (y, w)


def week_start(d):
    return d - dt.timedelta(days=d.isoweekday() - 1)


def month_key(d):
    return "%d-%02d" % (d.year, d.month)


def prev_week_window(t_cst):
    """t_cst 触发时刻 → 最近一个**已结束**的自然周：CST [周一00:00, 下周一00:00)"""
    this_monday = week_start(t_cst.date())
    return this_monday - dt.timedelta(days=7), this_monday


def prev_month_window(t_cst):
    first_this = t_cst.date().replace(day=1)
    end = first_this
    start = (first_this - dt.timedelta(days=1)).replace(day=1)
    return start, end


def utc_range(start_date, end_date):
    """把 CST 的 [start_date 00:00, end_date 00:00) 转成 UTC 秒区间（左闭右开）。"""
    return (utc_sec(cst(start_date.year, start_date.month, start_date.day)),
            utc_sec(cst(end_date.year, end_date.month, end_date.day)))


# ------------------------------------------------------------------
# 1. 时区可用性核对
# ------------------------------------------------------------------
p("=" * 78)
p("[0] 环境")
p("=" * 78)
p("SQLITE_VERSION      = " + sqlite3.sqlite_version)
p("本机 Python 时区     = " + str(dt.datetime.now().astimezone().tzinfo))
try:
    from zoneinfo import ZoneInfo
    sh = ZoneInfo("Asia/Shanghai")
    p("zoneinfo Asia/Shanghai = 可用，与固定 +8 偏移一致性 = %s"
      % (sh.utcoffset(dt.datetime(2026, 9, 15)) == dt.timedelta(hours=8)))
except Exception as e:
    p("zoneinfo Asia/Shanghai = 不可用（%s）" % type(e).__name__)
p("")
p("为何不依赖 IANA 时区库：中国自 1986–1991 年试行夏时制，1992-04-05 国务院决定暂停，")
p("此后全国全年恒为 UTC+8，无任何时区偏移变动。")
p("  来源：新华网《夏时制：节能还是“添乱”》https://www.xinhuanet.com/world/2015-06/10/c_1115566756_3.htm")
p("  来源：Time in China, Wikipedia — “Daylight saving time has not been observed since 1991.”")
p("  → 固定 +8 偏移在**本系统全部数据**上精确成立（系统全新开始，不导入 1991 年前的历史）。")
p("  → 生产实现因此**不需要** IANA tz 数据（本机 zoneinfo 缺 tzdata 包也不构成风险）。")
p("    该结论为时效性事实，检索口径 2026-09-15。")

con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()
p("")
p("SQLite 侧时区行为（同一条 SQL 在本机 vs 在 D1 的含义）：")
for label, sql in [("datetime('now')", "SELECT datetime('now') AS v"),
                   ("datetime('now','localtime')", "SELECT datetime('now','localtime') AS v"),
                   ("unixepoch('now')", "SELECT unixepoch('now') AS v")]:
    p("  %-30s -> %s" % (label, cur.execute(sql).fetchone()["v"]))
p("  ※ 本机 OS 时区是东八区，故 localtime 给出 CST；D1 上它等于 UTC（空操作）。")
p("  ※ 结论：周期边界必须在应用层算成 UTC 区间后传参，SQL 内禁用 localtime。")

# ------------------------------------------------------------------
# 2. 建表：Entry 冗余业务日 biz_date
# ------------------------------------------------------------------
cur.executescript("""
CREATE TABLE entry (
  id            INTEGER PRIMARY KEY,
  member_id     INTEGER NOT NULL,
  amount_cents  INTEGER NOT NULL,
  occurred_at   INTEGER NOT NULL,          -- UTC unix 秒
  biz_date      TEXT    NOT NULL           -- 冗余：Asia/Shanghai 的 YYYY-MM-DD
);
CREATE INDEX idx_entry_biz_date ON entry(biz_date);
CREATE INDEX idx_entry_occurred ON entry(occurred_at);

CREATE TABLE report_delivery (
  id              INTEGER PRIMARY KEY,
  report_type     TEXT NOT NULL CHECK (report_type IN ('weekly','monthly')),
  period_key      TEXT NOT NULL,
  channel         TEXT NOT NULL,
  data_cutoff_at  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent','failed')),
  detail          TEXT,
  UNIQUE (report_type, period_key, channel)   -- 业务幂等键
);
""")

# 四个刻意构造的样本：跨过 CST 周一 00:00 这条周期边界
SAMPLES = [
    ("2026-09-13 23:30", "周日深夜，属 W37"),
    ("2026-09-14 00:30", "周一凌晨，属 W38 —— 但 UTC 尚在 09-13"),
    ("2026-09-14 07:30", "周一早晨，属 W38 —— 但 UTC 尚在 09-13"),
    ("2026-09-14 09:00", "周一上午，属 W38，UTC 也已是 09-14"),
]
rows = []
for i, (s, _) in enumerate(SAMPLES, start=1):
    t = dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=CST)
    rows.append((i, 1, i * 10000, utc_sec(t), t.strftime("%Y-%m-%d")))
cur.executemany("INSERT INTO entry VALUES (?,?,?,?,?)", rows)

p("")
p("=" * 78)
p("[1] UTC 天真分组的陷阱：按 date(occurred_at,'unixepoch') 分组会错位")
p("=" * 78)
p("%-4s %-17s %-22s %-12s %-12s %s" % ("id", "CST 本地时刻", "UTC", "biz_date", "UTC date()", "判定"))
# 注意：必须先把结果抓成 list。同一个 cursor 边迭代边 execute 会重置结果集，
# 循环只跑一轮 —— 这是本脚本第一版的真实 bug，留此注释以免复发。
all_rows = cur.execute(
    "SELECT id, occurred_at, biz_date, amount_cents FROM entry ORDER BY id").fetchall()
for r in all_rows:
    t_utc = dt.datetime.fromtimestamp(r["occurred_at"], UTC)
    naive = dt.datetime.fromtimestamp(r["occurred_at"], UTC).strftime("%Y-%m-%d")
    p("%-4d %-17s %-22s %-12s %-12s %s"
      % (r["id"],
         dt.datetime.fromtimestamp(r["occurred_at"], CST).strftime("%Y-%m-%d %H:%M"),
         t_utc.strftime("%Y-%m-%d %H:%M:%SZ"),
         r["biz_date"],
         naive,
         "错位" if naive != r["biz_date"] else "一致"))


# 两种口径下的周聚合
agg_naive, agg_biz = {}, {}
for r in all_rows:
    naive = dt.datetime.fromtimestamp(r["occurred_at"], UTC).strftime("%Y-%m-%d")
    k1 = week_key(dt.date.fromisoformat(naive))
    k2 = week_key(dt.date.fromisoformat(r["biz_date"]))
    agg_naive[k1] = agg_naive.get(k1, 0) + r["amount_cents"]
    agg_biz[k2] = agg_biz.get(k2, 0) + r["amount_cents"]

p("")
p("周聚合两种口径对照（单位：元）：")
for k in sorted(set(agg_naive) | set(agg_biz)):
    a = agg_naive.get(k, 0) / 100.0
    b = agg_biz.get(k, 0) / 100.0
    flag = "   <-- 差额 %.2f 元错位" % (b - a) if a != b else ""
    p("  %-10s  按 UTC date() = %8.2f   按 biz_date = %8.2f%s" % (k, a, b, flag))
p("  （总额守恒：两种口径合计均为 %.2f 元）" % (sum(agg_biz.values()) / 100.0))

# ------------------------------------------------------------------
# 3. 正确做法：应用层算 UTC 区间，SQL 只做整数比较
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[2] 正确做法：应用层算周期边界 → UTC 区间 → SQL 整数区间查询")
p("=" * 78)


def report_window(cron_name, trigger_cst):
    if cron_name == "weekly":
        s, e = prev_week_window(trigger_cst)
        key = week_key(s)
    else:
        s, e = prev_month_window(trigger_cst)
        key = month_key(s)
    lo, hi = utc_range(s, e)
    return key, s, e, lo, hi


DEMO = [
    ("weekly", cst(2026, 9, 21, 8, 0), "周报触发：2026-09-21(周一) 08:00 CST"),
    ("monthly", cst(2026, 10, 1, 8, 0), "月报触发：2026-10-01 08:00 CST"),
]
for kind, trig, label in DEMO:
    key, s, e, lo, hi = report_window(kind, trig)
    total = cur.execute(
        "SELECT COALESCE(SUM(amount_cents),0) AS v FROM entry WHERE occurred_at >= ? AND occurred_at < ?",
        (lo, hi)).fetchone()["v"]
    p("")
    p("  %s" % label)
    p("    周期键          = %s" % key)
    p("    覆盖 CST 区间   = [%s 00:00, %s 00:00)" % (s.isoformat(), e.isoformat()))
    p("    等价 UTC 区间   = [%d, %d)  (%s ~ %s)"
      % (lo, hi,
         dt.datetime.fromtimestamp(lo, UTC).strftime("%Y-%m-%d %H:%MZ"),
         dt.datetime.fromtimestamp(hi, UTC).strftime("%Y-%m-%d %H:%MZ")))
    p("    该窗口支出合计  = %.2f 元（单条 SQL，无时区函数）" % (total / 100.0))

# ------------------------------------------------------------------
# 4. 幂等：周期键唯一约束让重跑自动跳过
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[3] 幂等重跑：唯一索引 (report_type, period_key, channel)")
p("=" * 78)
key_w37 = week_key(dt.date(2026, 9, 7))
cutoff = utc_sec(cst(2026, 9, 21, 8, 0))
p("  周期键 = %s" % key_w37)

cur.execute("INSERT INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status) "
            "VALUES ('weekly',?,'inapp',?,'sent')", (key_w37, cutoff))
p("  第 1 次写入 inapp           -> 写入 1 行（站内权威通道）")

cur.execute("INSERT OR IGNORE INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status) "
            "VALUES ('weekly',?,'inapp',?,'sent')", (key_w37, cutoff))
p("  重跑再写 inapp（OR IGNORE） -> 实际影响 %d 行（判重跳过）" % cur.rowcount)

cur.execute("INSERT OR IGNORE INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,detail) "
            "VALUES ('weekly',?,'pushplus',?,'failed','HTTP 502')", (key_w37, cutoff))
p("  第三方通道失败               -> 实际影响 %d 行，status='failed'（站内已发，互不污染）" % cur.rowcount)

cur.execute("INSERT OR IGNORE INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status,detail) "
            "VALUES ('weekly',?,'pushplus',?,'failed','HTTP 502')", (key_w37, cutoff))
p("  重跑第三方（按决策不重试）   -> 实际影响 %d 行（判重跳过，不重发）" % cur.rowcount)

try:
    cur.execute("INSERT INTO report_delivery (report_type,period_key,channel,data_cutoff_at,status) "
                "VALUES ('weekly',?,'inapp',?,'sent')", (key_w37, cutoff))
    p("  裸 INSERT 重跑               -> 未报错（不应发生）")
except sqlite3.IntegrityError as e:
    p("  裸 INSERT 重跑               -> IntegrityError: %s（约束生效）" % e)

p("  表内行数 = %d" % cur.execute("SELECT COUNT(*) AS c FROM report_delivery").fetchone()["c"])

# ------------------------------------------------------------------
# 5. Cron 表达式 → CST 时点换算与撞车检查
# ------------------------------------------------------------------
p("")
p("=" * 78)
p("[4] Cron 表达式换算（Cloudflare 恒按 UTC 执行；星期编号 1=周日 … 7=周六）")
p("=" * 78)

DOW_CF = {"SUN": 1, "MON": 2, "TUE": 3, "WED": 4, "THU": 5, "FRI": 6, "SAT": 7}


def _num(s, names):
    if names and s.upper() in names:
        return names[s.upper()]
    return int(s)


def _field(f, value, names=None):
    for part in f.split(","):
        step = 1
        if "/" in part:
            part, st = part.split("/")
            step = int(st)
        if part == "*":
            lo, hi = 0, 10 ** 9
        elif "-" in part:
            a, b = part.split("-")
            lo, hi = _num(a, names), _num(b, names)
        else:
            lo = hi = _num(part, names)
        if lo <= value <= hi and (value - lo) % step == 0:
            return True
    return False


def cron_fires(expr, t_utc):
    mi, hh, dom, mon, dow = expr.split()
    dow_cf = (t_utc.weekday() + 1) % 7 + 1     # Python 周一=0 → Cloudflare 1=周日
    return (_field(mi, t_utc.minute) and _field(hh, t_utc.hour) and
            _field(dom, t_utc.day) and _field(mon, t_utc.month) and
            _field(dow, dow_cf, DOW_CF))


CRONS = [
    ("行情抓取", "30 7 * * MON-FRI", "CST 15:30 交易日"),
    ("预算提醒巡检", "0 12 * * *", "CST 20:00 每日"),
    ("周报推送", "0 0 * * MON", "CST 周一 08:00"),
    ("月报推送", "10 0 1 * *", "CST 每月 1 日 08:10"),
]
for name, expr, want in CRONS:
    p("  %-12s %-22s 期望 %s" % (name, expr, want))

# 扫描 2026-09-15 → 2027-12-31，UTC 分钟粒度
start = int(dt.datetime(2026, 9, 15, tzinfo=UTC).timestamp())
stop = int(dt.datetime(2027, 12, 31, tzinfo=UTC).timestamp())
fires = {name: [] for name, _, _ in CRONS}
day_map = {}
t = start
while t < stop:
    d = dt.datetime.fromtimestamp(t, UTC)
    for name, expr, _ in CRONS:
        if cron_fires(expr, d):
            c = dt.datetime.fromtimestamp(t, CST)
            fires[name].append(c)
            day_map.setdefault(c.strftime("%Y-%m-%d"), []).append((name, c.strftime("%H:%M")))
    t += 60

p("")
p("  扫描区间：2026-09-15 00:00Z ~ 2027-12-31 00:00Z（UTC 分钟粒度）")
for name, expr, _ in CRONS:
    lst = fires[name]
    p("")
    p("  %s（%s）共触发 %d 次，最近 3 次（CST）：" % (name, expr, len(lst)))
    for c in lst[:3]:
        p("    %s UTC → %s CST" % (
            c.astimezone(UTC).strftime("%Y-%m-%d %H:%M"),
            c.strftime("%Y-%m-%d %H:%M %a")))

p("")
p("  同一天多个任务撞车检查（同一 Worker 多 cron 的并发语义官方未说明，故须错开）：")
p("  判定口径：同一条 UTC 分钟即视为撞车；仅同一天不算。")
per_minute = {}
for name, expr, _ in CRONS:
    for c in fires[name]:
        per_minute.setdefault(c.astimezone(UTC).strftime("%Y-%m-%d %H:%M"), []).append(name)
clash = {k: v for k, v in per_minute.items() if len(v) > 1}
if not clash:
    p("    无任何一条 UTC 分钟出现两个任务 —— 四个时点两两不重叠，并发风险归零。")
else:
    for k in sorted(clash)[:10]:
        p("    %s UTC   %s" % (k, " / ".join(clash[k])))
p("")
p("  同日多任务情形（非并发，仅提示一天内触发次数）：")
same_day = {k: v for k, v in day_map.items() if len(v) > 1}
for k in sorted(same_day)[:5]:
    v = sorted(same_day[k], key=lambda x: x[1])
    p("    %s   %s" % (k, " / ".join("%s@%s" % (a, b) for a, b in v)))
p("    共 %d 天出现多任务（其中周报与月报同日的情形由 10 分钟错开规避并发）。" % len(same_day))

p("")
p("  配额占用 = %d / 5（Workers Free，账户级上限）" % len(CRONS))

p("")
p("=" * 78)
p("结论：周期边界必须由应用层按 Asia/Shanghai 算成 UTC 区间；")
p("      UTC 天真分组会把 CST 00:00–08:00 的支出错记到前一日，进而错位到上一周期。")
p("=" * 78)

path = __file__.replace(".py", ".out.txt")
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print("\n".join(out))
print("\n[written] " + path)
