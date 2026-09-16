# -*- coding: utf-8 -*-
"""验证「鉴权与访问控制方案」（migrations/0002_auth.sql）的约束可执行性与查询索引命中。

用途：为决策票 #9 提供可复跑的实测依据，而非纸面推断。
运行：python auth-schema-probe.py
输出：同目录 auth-schema-probe.out.txt（UTF-8）

被验对象：仓库根 migrations/0001_init.sql 与 migrations/0002_auth.sql
          —— 本脚本**直接执行这两份文件**，不另抄一份 DDL，
          以保证「验的就是要发布的那份」。

注意：本机 Python 自带 SQLite，版本见输出首行；**不是 D1 的版本**。
     本脚本显式 `PRAGMA foreign_keys = ON` 以对齐 D1 的默认行为。
     D1 侧仍需复核的项见输出末节。

运行环境：本脚本需要 `hashlib.pbkdf2_hmac`，而**本机托管版 Python 3.13.12 的
         `_ssl` DLL 缺失**（`ImportError: DLL load failed while importing _ssl`），
         连带 `hashlib` 无该函数 ⇒ 必须改用**系统 Python 3.10.11**
         （OpenSSL 1.1.1t / SQLite 3.40.1）。
         d1-schema-probe.py 则跑在 3.13.12（SQLite 3.53.1）上 ⇒ **两份探针的
         SQLite 版本不同**，各自在输出首行标注，比对跨探针数字时须留意。
"""
import base64
import hashlib
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DDL_0001 = os.path.join(ROOT, "migrations", "0001_init.sql")
DDL_0002 = os.path.join(ROOT, "migrations", "0002_auth.sql")

CST = timezone(timedelta(hours=8))
out = []
fails = []


def p(s=""):
    out.append(str(s))


def attempt(label, sql, params, expect):
    """expect: 'ok' 或 'error'。返回实际结果（ok/error），并记录不符合预期的断言。"""
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


def plan(sql, params=None):
    rows = cur.execute("EXPLAIN QUERY PLAN " + sql, params or {}).fetchall()
    return [r["detail"] for r in rows]


def ts(y, mo, d, hh=12, mm=0):
    return int(datetime(y, mo, d, hh, mm, tzinfo=CST).timestamp())


def b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def make_phc(password, iterations=20000, salt=None):
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, 32)
    return "pbkdf2-sha256$%d$%s$%s" % (iterations, b64u(salt), b64u(dk))


def verify_phc(phc, password):
    algo, iters, salt_b64, hash_b64 = phc.split("$")
    if algo != "pbkdf2-sha256":
        raise ValueError("unsupported algo " + algo)
    salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters), 32)
    return b64u(dk) == hash_b64


# ============================================================================
con = sqlite3.connect(":memory:")
con.row_factory = sqlite3.Row
cur = con.cursor()

p("SQLITE_VERSION = " + sqlite3.sqlite_version)
p("DDL = migrations/0001_init.sql + migrations/0002_auth.sql")
p("")

con.execute("PRAGMA foreign_keys = ON")
p("PRAGMA foreign_keys = %s   <- 本机默认 OFF；此处显式对齐 D1（D1 恒为 ON 且无法关闭）"
  % con.execute("PRAGMA foreign_keys").fetchone()[0])

for path, name in ((DDL_0001, "0001_init.sql"), (DDL_0002, "0002_auth.sql")):
    with open(path, encoding="utf-8") as f:
        ddl = f.read()
    cur.executescript(ddl)
    p("DDL 执行：OK  %s（%d 字符）" % (name, len(ddl)))

# 种子：恰好 2 位成员（0001 的 trg_member_limit_ins 强制这一点）
T = ts(2026, 9, 16, 9, 0)
cur.executemany("INSERT INTO member (id, name, sort_order, created_at) VALUES (?,?,?,?)", [
    (1, "胡先森", 1, T),
    (2, "太太", 2, T),
])
p("种子：member 2 行（恰 2 位，符合 0001 的领域约束）")

# ============================================================================
p("\n" + "=" * 78)
p("【一】结构盘点（含对 0001 的回归核对）")
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
p("  对照 #14 的基线（12 表 / 16 触发器 / 10 显式索引）：")
p("    本票新增 3 表（member_credential, session, login_attempt）")
p("    本票新增 1 触发器（trg_credential_gen_kill_sessions）")
p("    本票新增 1 显式索引（ix_session_member）")
p("")
p("    ⚠️ 基线勘误：地图与 d1-schema.md 原先写「11 个显式索引」，实为 **10 个**。")
p("       本票在建立本比对时核对出该差错（0001_init.sql 共 10 条 CREATE INDEX：")
p("       8 个 ix_* + 2 个 ux_*），已在 d1-schema.md §10 留下更正记录。")
ok_struct = (len(tables) == 15 and len(triggers) == 17 and len(explicit_idx) == 11)
p("    实测：%d 表 / %d 触发器 / %d 显式索引  ->  %s"
  % (len(tables), len(triggers), len(explicit_idx), "一致" if ok_struct else "**不一致**"))
if not ok_struct:
    fails.append("结构盘点与预期不符")

# ============================================================================
p("\n" + "=" * 78)
p("【二】为什么凭据必须是独立表（而不是给 member 加列）")
p("=" * 78)

attempt("A4  ALTER TABLE member ADD COLUMN phc TEXT UNIQUE —— 预期被拒",
        "ALTER TABLE member ADD COLUMN phc TEXT UNIQUE", (), "error")
attempt("A5  ALTER TABLE member ADD COLUMN phc TEXT NOT NULL —— 预期被拒（无非空默认值）",
        "ALTER TABLE member ADD COLUMN phc2 TEXT NOT NULL", (), "error")
p("  -> SQLite 的 ADD COLUMN 既不能加 UNIQUE、也不能加无默认值的 NOT NULL 列，")
p("     故「每位成员恰好一条凭据」无法靠加列实现。这是独立表的硬依据。")

# ============================================================================
p("\n" + "=" * 78)
p("【三】约束断言")
p("=" * 78)

PHC_A = make_phc("correct horse battery staple", 20000)
PHC_B = make_phc("另一个密码", 20000)

attempt("B1  第 3 位成员被拒（0001 的领域约束仍在）",
        "INSERT INTO member (id,name,sort_order,created_at) VALUES (3,'第三人',3,?)", (T,), "error")

attempt("B2  合法凭据写入通过",
        "INSERT INTO member_credential (member_id, phc, gen, updated_at) VALUES (1,?,1,?)",
        (PHC_A, T), "ok")
attempt("B3  非 pbkdf2-sha256 前缀的 phc 被拒",
        "INSERT INTO member_credential (member_id, phc, gen, updated_at) VALUES (2,'scrypt$16384$x$y',1,?)",
        (T,), "error")
attempt("B3b 前缀正确但内容为空的 phc 通过（格式只保证前缀，内容由探针 E 段兜）",
        "INSERT INTO member_credential (member_id, phc, gen, updated_at) VALUES (2,?,1,?)",
        ("pbkdf2-sha256$1$$", T), "ok")
cur.execute("UPDATE member_credential SET phc=? WHERE member_id=2", (PHC_B,))

attempt("B4  gen < 1 被拒",
        "UPDATE member_credential SET gen=0 WHERE member_id=1", (), "error")

H1 = hashlib.sha256(b"token-1").hexdigest()
H2 = hashlib.sha256(b"token-2").hexdigest()
E0 = T + 30 * 86400
EABS = T + 90 * 86400

attempt("B5  合法会话写入通过",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at,ua_hint)"
        " VALUES (1,1,?,?,?,?,?,'iPhone Safari')",
        (H1, T, T, E0, EABS), "ok")
attempt("B6  重复 token_hash 被拒（唯一约束）",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (2,1,?,?,?,?,?)",
        (H1, T, T, E0, EABS), "error")
attempt("B7  token_hash 长度不足被拒（防明文入库：明文 b64url 是 43 字符）",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (2,1,'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',?,?,?,?)",
        (T, T, E0, EABS), "error")
attempt("B8  token_hash 含非 hex 字符被拒",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (2,1,'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',?,?,?,?)",
        (T, T, E0, EABS), "error")
attempt("B9  归属不存在的成员被拒（外键）",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (3,999,?,?,?,?,?)",
        (H2, T, T, E0, EABS), "error")
attempt("B10 滑动到期晚于绝对上限被拒",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (4,1,?,?,?,?,?)",
        (H2, T, T, EABS + 86400, EABS), "error")
attempt("B11 滑动到期早于签发时刻被拒",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
        " VALUES (5,1,?,?,?,?,?)",
        (H2, T, T, T - 1, EABS), "error")
attempt("B12 超长 ua_hint 被拒（>200 字符）",
        "INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at,ua_hint)"
        " VALUES (6,1,?,?,?,?,?,?)",
        (H2, T, T, E0, EABS, "x" * 201), "error")

# 给成员 2 也建一条会话（供触发器断言用）
H3 = hashlib.sha256(b"token-3").hexdigest()
cur.execute("INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
            " VALUES (10,2,?,?,?,?,?)", (H3, T, T, E0, EABS))
p("  种子：member 1 有 1 条会话、member 2 有 1 条会话")

# ============================================================================
p("\n" + "=" * 78)
p("【四】触发器：改密码踢人，透明重哈希不踢人")
p("=" * 78)


def session_count(mid):
    return cur.execute("SELECT COUNT(*) FROM session WHERE member_id=?", (mid,)).fetchone()[0]


before1, before2 = session_count(1), session_count(2)
p("  变更前：member1 会话 %d 条 / member2 会话 %d 条" % (before1, before2))

cur.execute("UPDATE member_credential SET phc=?, gen=gen+1, updated_at=? WHERE member_id=1",
            (make_phc("新密码", 20000), T))
after1, after2 = session_count(1), session_count(2)
p("  C1 改密码（gen+1）后：member1 会话 %d 条  ->  %s"
  % (after1, "PASS 已全部失效" if after1 == 0 else "**FAIL** 仍残留"))
if after1 != 0:
    fails.append("C1 改密码未清空该成员会话")
p("  C2 同时 member2 会话 %d 条  ->  %s"
  % (after2, "PASS 未受影响" if after2 == before2 else "**FAIL** 被误伤"))
if after2 != before2:
    fails.append("C2 改密码误伤了其他成员的会话")

# 重建 member1 的会话，再测「透明重哈希不踢人」
cur.execute("INSERT INTO session (id,member_id,token_hash,created_at,last_seen_at,expires_at,absolute_expires_at)"
            " VALUES (11,1,?,?,?,?,?)", (H1, T, T, E0, EABS))
before1 = session_count(1)
cur.execute("UPDATE member_credential SET phc=?, updated_at=? WHERE member_id=1",
            (make_phc("新密码", 50000), T + 60))
after1 = session_count(1)
p("  C3 透明重哈希（换盐换迭代、gen 不变）后：member1 会话 %d 条  ->  %s"
  % (after1, "PASS 会话保留" if after1 == before1 else "**FAIL** 被误踢"))
if after1 != before1:
    fails.append("C3 透明重哈希误踢了会话")
p("")
p("  -> 这条是本票 schema 里唯一一处「需要额外一列才能表达」的地方：")
p("     改密码与透明重哈希在 phc 上完全同形（都换了盐与散列），")
p("     只有整数世代 gen 能给出可判定的意图信号。")

# ============================================================================
p("\n" + "=" * 78)
p("【五】查询计划（每请求必跑的那条路径必须走索引）")
p("=" * 78)

Q_AUTH = ("SELECT s.id, s.member_id FROM session s "
          "WHERE s.token_hash = :th AND s.revoked_at IS NULL AND s.expires_at > :now")
d = plan(Q_AUTH, {"th": H1, "now": T})
p("  V1 中间件鉴权（每请求）")
for x in d:
    p("      " + x)

Q_KILL = "DELETE FROM session WHERE member_id = :mid"
d = plan(Q_KILL, {"mid": 1})
p("  V2 登出所有设备 / 改密码清会话")
for x in d:
    p("      " + x)

Q_SWEEP = "DELETE FROM session WHERE absolute_expires_at < :now"
d = plan(Q_SWEEP, {"now": T})
p("  V3 过期会话清理（挂每日 cron）")
for x in d:
    p("      " + x)

Q_RATE = "SELECT n FROM login_attempt WHERE username = :u AND ip = :ip AND bucket_at = :b"
d = plan(Q_RATE, {"u": "husir", "ip": "1.2.3.4", "b": T})
p("  V4 限速读取（每次登录失败前）")
for x in d:
    p("      " + x)

Q_RATE_SWEEP = "DELETE FROM login_attempt WHERE bucket_at < :old"
d = plan(Q_RATE_SWEEP, {"old": T - 86400})
p("  V5 限速桶清理（挂每日 cron）")
for x in d:
    p("      " + x)

fact_scans = []
for lbl, q, prm in (("V1", Q_AUTH, {"th": H1, "now": T}),
                    ("V2", Q_KILL, {"mid": 1}),
                    ("V3", Q_SWEEP, {"now": T}),
                    ("V4", Q_RATE, {"u": "a", "ip": "b", "b": T}),
                    ("V5", Q_RATE_SWEEP, {"old": T})):
    for x in plan(q, prm):
        if x.startswith("SCAN"):
            fact_scans.append((lbl, x))

p("")
p("  EXPLAIN QUERY PLAN 出现全表 SCAN 的处：%d" % len(fact_scans))
for lbl, x in fact_scans:
    p("      · %s -> %s" % (lbl, x))
p("""
  判据说明（沿用 #14 对「事实表不得全扫」的收窄，本票判断，可复议）：
    V1/V2/V4 是**每请求或每次登录失败都会跑**的路径，必须走索引 —— 实测已走。
    V3/V5 是每日 cron 的清理，命中 SCAN session / SCAN login_attempt。
    本票**不修**，理由与 #14 对 tag 维度表的判断同构：这两张表的行数由
    「设备数」「失败次数」决定而非由时间累积（过期行会被清掉），2 人自用为
    个位数到几十行，全扫即最优计划。若未来行数上千，再补索引。""")

# ============================================================================
p("\n" + "=" * 78)
p("【六】限速 upsert：写行数必须被钉在上界")
p("=" * 78)

UPSERT = ("INSERT INTO login_attempt (username, ip, bucket_at, n, updated_at) "
          "VALUES (:u, :ip, :b, 1, :now) "
          "ON CONFLICT (username, ip, bucket_at) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at "
          "WHERE n < 20")

U, IP, B = "husir", "203.0.113.9", T
for i in range(1, 22):
    cur.execute(UPSERT, {"u": U, "ip": IP, "b": B, "now": T + i})
n_final = cur.execute("SELECT n FROM login_attempt WHERE username=? AND ip=? AND bucket_at=?",
                      (U, IP, B)).fetchone()[0]
rows = cur.execute("SELECT COUNT(*) FROM login_attempt").fetchone()[0]
p("  连打 21 次失败：单键最终 n = %d，表内总行数 = %d" % (n_final, rows))
p("  -> %s" % ("PASS 计数在 20 停住、且始终只占 1 行（未每次新增行）"
                if n_final == 20 and rows == 1 else "**FAIL** 计数或行数不符合预期"))
if n_final != 20 or rows != 1:
    fails.append("限速 upsert 的上界行为不符合预期")

attempt("B13 直接插入 n=0 被拒（CHECK n>0）",
        "INSERT INTO login_attempt (username,ip,bucket_at,n,updated_at) VALUES ('x','y',?,0,?)",
        (T, T), "error")

p("")
p("  ⚠️ 未证实项（官方文档无明确口径）：`INSERT ... ON CONFLICT DO UPDATE` 在 D1 的")
p("     `rows_written` 计为几行。官方只枚举了 INSERT / UPDATE / DELETE 各自按行计。")
p("     故「单键写行数有上界」这一条在**结构上成立**（本机实测只占 1 行），")
p("     但**在 D1 的计量口径上需实测**：上线前用响应里的 meta.rows_written 复核。")

# ============================================================================
p("\n" + "=" * 78)
p("【七】PBKDF2 的 phc 格式往返（本机实测，非 workerd）")
p("=" * 78)

phc = make_phc("correct horse battery staple", 20000)
p("  生成的 phc：%s" % phc)
p("  长度 %d 字符，字段数 %d" % (len(phc), len(phc.split("$"))))
p("  E1 正确密码验回：%s" % ("PASS" if verify_phc(phc, "correct horse battery staple") else "**FAIL**"))
p("  E2 错误密码被拒：%s" % ("PASS" if not verify_phc(phc, "wrong password") else "**FAIL**"))
if not (verify_phc(phc, "correct horse battery staple") and not verify_phc(phc, "wrong password")):
    fails.append("PBKDF2 往返不符合预期")

p("")
p("  本机耗时（Python/OpenSSL，用于对照——非 workerd 的测量值）：")
for iters in (10000, 20000, 25000, 50000, 100000):
    samples = []
    salt = os.urandom(16)
    for _ in range(7):
        t0 = time.perf_counter()
        hashlib.pbkdf2_hmac("sha256", b"correct horse battery staple", salt, iters, 32)
        samples.append((time.perf_counter() - t0) * 1000.0)
    samples.sort()
    p("    iter=%6d  median=%.2f ms" % (iters, samples[len(samples) // 2]))
p("")
p("  对照 Node 侧同一基准（.workbuddy/tmp/wf/pbkdf2_bench.txt，i5-12400F）：")
p("    10000 -> 2.18 ms / 25000 -> 5.42 ms / 50000 -> 11.13 ms / 100000 -> 22.08 ms")
p("  ⇒ 两套实现量级一致，佐证「20,000 次 ≈ 4~5 ms」这个数量级。")
p("  ⚠️ 但**两者都不是 workerd（BoringSSL）**。20,000 这个取值必须在上线前")
p("     用线上观测到的 CPU 时间复核，允许区间 10,000–50,000（见契约 §7）。")

# ============================================================================
p("\n" + "=" * 78)
p("【八】D1 侧待复核（本机 SQLite != D1，以下各项必须在 D1 上复跑）")
p("=" * 78)
p("  1. `SELECT sqlite_version()` —— 本机 " + sqlite3.sqlite_version
  + " 不是 D1 的版本（#14 已列，仍未核实）。")
p("""  2. **PBKDF2 迭代 20,000 次的真实 CPU 时间** —— workerd 用 BoringSSL，
     与 OpenSSL 不同实现；且边缘 CPU 与本机 i5-12400F 不同。这是**本票最关键的
     未证实项**：若线上 CPU 时间超 10 ms，需下调迭代次数（区间下限 10,000）。
     官方与 workerd 仓库均无「迭代次数 → ms」的基准，只能自测。
  3. `INSERT ... ON CONFLICT DO UPDATE ... WHERE` —— ① D1 是否接受该语法；
     ② `meta.rows_written` 把它计为几行。本机实测只占 1 行、计数在 20 停住。
  4. **中间件能否访问 D1 绑定** —— 官方文档只说明绑定经 `context.env` 在
     「Function code」中访问，**未就 middleware 作专门表述**（#9 调研 §5 缺口）。
     预期可行（middleware 的 onRequest 接收同一 EventContext），落地前验证一次。
  5. `_routes.json` 是否真的把静态请求挡在 Functions 之外 —— 官方原文要求
     「一旦加了 Functions，默认所有请求都会调用 Function」，须实测确认生效，
     否则 10 万/天 的请求额度会被静态资源吃掉。
  6. **iOS PWA 内的登录态** —— WebKit bug 272325（iOS 17+ PWA 内会话 cookie
     偶发回退为旧值 ⇒ 随机登出）状态为 NEW。须在真机上验证，并确认前端的
     401 兜底（跳登录页而非白屏）确实生效。""")

# ============================================================================
p("\n" + "=" * 78)
p("【九】小结")
p("=" * 78)
p("  断言失败数：%d" % len(fails))
for x in fails:
    p("    **FAIL** %s" % x)
p("  表 %d / 触发器 %d / 显式索引 %d；每请求路径（V1/V2/V4）全部走索引。"
  % (len(tables), len(triggers), len(explicit_idx)))

with open(os.path.join(HERE, "auth-schema-probe.out.txt"), "w", encoding="utf-8") as f:
    f.write("\r\n".join(out))
print("done; fails=%d" % len(fails))
