-- ============================================================================
-- 家庭财务管理系统 · D1 schema 迁移 0002：自研轻量鉴权
-- ----------------------------------------------------------------------------
-- 文件：migrations/0002_auth.sql
-- 生成依据：决策票 #9 «鉴权与访问控制方案»
--           （承接 #14 的未决缝：「member 表不含凭据列，由 0002 以 member.id 为锚补上」）
-- 设计说明：docs/specs/auth-contract.md
-- 可复跑验证：docs/verification/auth-schema-probe.py / .out.txt
--
-- 本迁移**只建表与约束，不含任何凭据数据**。
--   仓库为 public ⇒ 任何密码哈希都绝不能进 git。建号 / 重置由本地脚本生成 SQL，
--   经 wrangler d1 execute 落地（见 auth-contract.md §6）。
--
-- 时间戳：一律 UTC 秒（沿用 0001 的单位约定）。
-- 依赖：member 已存在（0001_init.sql §1）。
-- ============================================================================


-- ============================================================================
-- 1. 凭据（1 位成员 : 1 条凭据）
-- ============================================================================

-- 为什么是独立表，而不是给 member 加列：
--   SQLite 的 ALTER TABLE ADD COLUMN **不能加 UNIQUE 列**（实测见探针断言 A4）。
--   而「每位成员恰好一条凭据」正是靠主键唯一性保证的 ⇒ 加列这条路走不通。
--   另：凭据与成员是两个关注点，独立表也让未来第二种凭据（如 Passkey）能并列加。
--
-- phc：单列承载「算法 + 迭代次数 + 盐 + 散列」（PHC 风格）
--   pbkdf2-sha256$20000$<salt_b64url>$<hash_b64url>
--   换来「换算法 / 提强度不改表结构」；代价是**迭代次数无法用 SQL CHECK 限定区间**。
--   本票判断：可接受 —— 该值由写入脚本产生（非用户输入），而探针实测「哈希能验回」
--   比一条区间约束更能兜住算错。属可复议的取舍。
--
-- gen：凭据世代。**只在「改密码」时 +1，透明重哈希时不动**。
--   存在的唯一理由是让下面的触发器能区分这两件事 —— 二者在 phc 上长得一样
--   （都改了盐与散列），只有整数世代能给出可判定的意图信号。
CREATE TABLE member_credential (
  member_id  INTEGER PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  phc        TEXT    NOT NULL CHECK (phc LIKE 'pbkdf2-sha256$%'),
  gen        INTEGER NOT NULL DEFAULT 1 CHECK (gen >= 1),
  updated_at INTEGER NOT NULL                                    -- UTC 秒
);


-- ============================================================================
-- 2. 会话（不透明 token；明文不入库）
-- ============================================================================

-- token 明文是 32 字节 CSPRNG，**只存在于 Set-Cookie 那一刻**；表内只存其 SHA-256。
-- 这一条防的是最典型的失守路径：D1 一旦泄露（导出物外流、Cloudflare 侧事故），
-- 明文 token 表等于攻击者直接拿到可用会话、绕过全部密码防护。
-- 因 token 无「弱口令」问题，**快哈希足够**，不需要 PBKDF2，也就不占 CPU 预算。
--
-- token_hash 用 **hex（64 字符）而非 base64url（43 字符）**：下面那条 CHECK 因此能
-- 结构性挡住「误把明文 token 写进本列」—— 明文按 b64url 编码是 43 字符，长度就对不上。
CREATE TABLE session (
  id                  INTEGER PRIMARY KEY,
  member_id           INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  token_hash          TEXT    NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,                        -- UTC 秒
  last_seen_at        INTEGER NOT NULL,                        -- UTC 秒；写入按 24h 节流（契约 §5）
  expires_at          INTEGER NOT NULL,                        -- 滑动到期（UTC 秒）
  absolute_expires_at INTEGER NOT NULL,                        -- 绝对上限，签发即定死
  ua_hint             TEXT,                                    -- 仅供人工识别设备，不参与判定
  revoked_at          INTEGER,                                 -- 非 NULL 即已撤销
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (absolute_expires_at > created_at),
  CHECK (expires_at > created_at AND expires_at <= absolute_expires_at),
  CHECK (last_seen_at >= created_at AND last_seen_at <= absolute_expires_at),
  CHECK (ua_hint IS NULL OR length(ua_hint) <= 200)
);

-- 会话按成员撤销（「登出所有设备」，以及下面触发器里的 DELETE）：
-- 该查询不带 token_hash，用不上唯一索引 ⇒ 必须单建，否则全表扫描。
CREATE INDEX ix_session_member ON session(member_id);


-- ============================================================================
-- 3. 登录尝试计数（防爆破）
-- ============================================================================

-- 为什么落 D1 而不是 KV：KV 免费额度**仅 1,000 次写/天**，一次爆破就能打爆当天的
--   写额度；D1 免费是 100,000 写行/天，量级差 100 倍。
-- 为什么不用 Durable Objects：它免费可用（10 万请求/天），但要为一个计数器引入
--   本项目至今为零的新原语，复杂度不划算。若未来 D1 写额度成为瓶颈，这是首选替代。
--
-- 关键风险与对策：登录失败要写库，攻击者狂打登录端点即可把 D1 写额度打满，
--   导致**全家正常记账写不进去**（超限后整个 D1 拒服务）。故本表必须满足两条：
--   ① 同一 (用户名, IP, 小时桶) 在窗口内**反复覆盖而非新增行** ⇒ 单键写行数有上界；
--   ② 单键计数达上限后**不再写**（由契约 §5 的 upsert WHERE 条件实现）。
--   全局每日写行数另有硬顶，见契约 §5。
--
-- username 存**小写归一化**后的值（实现侧保证）；IP 取 CF-Connecting-IP（客户端无法伪造）。
-- 本表无「成员」外键：用户名字段可能对应一个**并不存在**的成员，那正是要计数的情形。
CREATE TABLE login_attempt (
  username   TEXT    NOT NULL,
  ip         TEXT    NOT NULL,
  bucket_at  INTEGER NOT NULL,          -- 窗口起点（UTC 秒，按小时对齐）
  n          INTEGER NOT NULL CHECK (n > 0),
  updated_at INTEGER NOT NULL,          -- UTC 秒
  PRIMARY KEY (username, ip, bucket_at)
);


-- ============================================================================
-- 4. 触发器
-- ============================================================================

-- 改密码 ⇒ 该成员全部会话立刻失效。做成触发器而非应用层约定：
--   任何改密路径（本地重置脚本、站内改密 API）都不可能绕过它。
--   与 0001 的「取舍 G」（除权撤销一步到位）是同一条纪律。
-- 用 `UPDATE OF gen` + `WHEN NEW.gen <> OLD.gen` 双重限定，动机见上面对 gen 的说明：
--   透明重哈希（换盐换迭代、不改 gen）**必须不踢人**，否则用户会在参数升级那天
--   被自己刚签发的会话踢出（登录成功 → 重哈希 → 会话被删 → 下一个请求 401）。
CREATE TRIGGER trg_credential_gen_kill_sessions
AFTER UPDATE OF gen ON member_credential
WHEN NEW.gen <> OLD.gen
BEGIN
  DELETE FROM session WHERE member_id = NEW.member_id;
END;


-- ============================================================================
-- 刻意不建（每条都有实测依据）
-- ----------------------------------------------------------------------------
--   · session(absolute_expires_at) —— 过期清理查询的消费者确实存在，但 session 的
--     行数由**设备数**决定而非由时间累积（过期行会被清理），2 人自用为个位数行；
--     全扫即最优计划。与 0001 对 tag 维度表的判断同构（#14 的判据收窄）。
--     若未来行数上千，再补此索引。
--   · session(token_hash) —— 已由列上的 UNIQUE 隐式建立，勿重复建（#14 纪律：
--     没消费者的索引不该存在）。
--   · login_attempt(bucket_at) —— 清理查询 `WHERE bucket_at < ?` 确实用不上主键前缀，
--     但本表只记**失败**登录，2 人自用常态为空表；全扫即最优计划。同上，行数上千再补。
--   · 任何 member 表的凭据列 —— 见上方「为什么是独立表」。
--   · 建号 / 重置用的种子数据 —— 仓库 public，凭据数据永不入库（契约 §6）。
--
-- 未决缝（明确不闭合）：
--   · 若未来引入 Passkey，其凭据形状不预判 —— 但 member_credential 的独立表设计
--     已使其可以并列新增，不需要改本表。
--   · 本迁移未纳入备份策略的取舍（session 不备份、member_credential 必须备份）——
--     那是 #15 的决定，本文件只提供事实（见 auth-contract.md §8）。
-- ============================================================================
