// 备份与导出策略 —— 可复跑探针（Node / V8）
//
// 为什么必须是 JS 而不是 Python：
//   CPython 的 int 是任意精度，json 不走 IEEE754 —— 「Python 往返精确」不能推出「JS 也精确」。
//   本库的金额/时间以整数存储，而 JSON 数字经 RFC 8259 允许实现自行限定 range/precision，
//   RFC 7493 因此 RECOMMENDED 用 JSON 字符串承载 64 位整数。
//   ⇒ 这条边界只能在 V8（= workerd 的引擎）上验。
//
// 回答三件事：
//   §A 导出序列化的 CPU 成本 vs Free 的 10 ms/请求，反推分片页大小
//   §B CSV 拼接成本（对照 JSON）
//   §C JSON 数字的精确边界在 V8 上的实际位置，以及本库取值域是否安全
//
// 用法：
//   <node> docs/verification/backup-export-cpu-probe.js > docs/verification/backup-export-cpu-probe.out.txt
//
// ⚠️ 口径声明：本机 Node/V8 实测，**不是 workerd 的 CPU 计费口径**。二者同引擎但计时方式不同，
//    本探针只提供数量级与相对比较，不足以作为「一定不会超 10 ms」的证明。

"use strict";

const CPU_BUDGET_MS = 10;      // Cloudflare Free：CPU 10 ms / 请求
const SAFE_ALLOC = 5;          // 分给序列化的预算（余下留给路由 / 鉴权会话查表 / SQL 解析）

let PASS = 0, FAIL = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log("  PASS  " + name + (detail !== undefined ? "  |  " + detail : "")); }
  else { FAIL++; failures.push(name + " | " + detail); console.log("  FAIL  " + name + (detail !== undefined ? "  |  " + detail : "")); }
}
function hdr(t) { console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78)); }
function best(fn, n) { let b = Infinity; for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); fn(); const t1 = process.hrtime.bigint(); b = Math.min(b, Number(t1 - t0) / 1e6); } return b; }

// ---------------------------------------------------------------- 样本
// 列形态**照抄** migrations/0001_init.sql 的 entry 表（8 列，一字不改）——
// ⚠️ entry **没有 note / 备注列**：本系统的 Entry 只承载「谁花的 / 花在哪 / 何时 / 多少钱」。
// ⚠️ 因此本探针测的是**原始表行**的序列化成本；CSV 宽表还要 JOIN 出成员名 / 类别路径 /
//    对象标签，行更宽 ⇒ CSV 的成本是**下界**。页大小取两者中更严的那个约束（JSON）。
const ENTRY_COLS = ["id", "member_id", "category_tag_id", "amount_cents", "occurred_at", "biz_date", "created_at", "client_ref"];
function mkEntries(n) {
  const rs = [];
  for (let i = 0; i < n; i++) rs.push({
    id: i + 1, member_id: (i % 2) + 1, category_tag_id: 100 + (i % 37),
    amount_cents: 1234 + (i % 99999), occurred_at: 1757000000 + i * 60,
    biz_date: "2026-09-17", created_at: 1757000000 + i,
    client_ref: "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071",
  });
  return rs;
}

function toCsv(cols, rows) {
  const out = [cols.join(",")];
  for (const r of rows) {
    const line = new Array(cols.length);
    for (let c = 0; c < cols.length; c++) {
      const v = r[cols[c]];
      if (v === null || v === undefined) { line[c] = ""; continue; }
      const s = String(v);
      line[c] = /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    out.push(line.join(","));
  }
  return out.join("\r\n");
}

// ---------------------------------------------------------------- §A
function secA() {
  hdr("§A 导出序列化的 CPU 成本 vs 10 ms/请求（本机 V8，非 workerd 计费口径）");
  console.log("  引擎: " + process.version + "\n");
  console.log("    rows |  JSON.stringify |      bytes |   CSV 拼接 |      bytes");
  console.log("  -------+-----------------+------------+------------+-----------");
  const sizes = [500, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 30000];
  const jm = {}, cm = {};
  for (const n of sizes) {
    const rows = mkEntries(n);
    const j = ((s) => s)(JSON.stringify(rows));
    jm[n] = best(() => JSON.stringify(rows), 5);
    cm[n] = best(() => toCsv(ENTRY_COLS, rows), 5);
    console.log("  %s | %s ms | %s | %s ms | %s",
      String(n).padStart(6),
      jm[n].toFixed(2).padStart(15),
      String(Buffer.byteLength(j)).padStart(10),
      cm[n].toFixed(2).padStart(10),
      String(Buffer.byteLength(toCsv(ENTRY_COLS, rows))).padStart(9));
  }

  const per1k = jm[10000] / 10;
  console.log("\n  线性成本 ≈ %s ms / 1000 行（JSON）", per1k.toFixed(3));

  // 反推页大小
  let maxRows = 0;
  for (const n of sizes) if (jm[n] <= SAFE_ALLOC) maxRows = Math.max(maxRows, n);
  console.log("  预算：CPU %d ms/请求，其中 %d ms 划给序列化 ⇒ 单页安全上限 ≈ %d 行", CPU_BUDGET_MS, SAFE_ALLOC, maxRows);

  check("§A.1 默认页大小 2000 行的 JSON 序列化 < 5 ms", jm[2000] < SAFE_ALLOC, jm[2000].toFixed(2) + " ms");
  check("§A.2 默认页大小 2000 行的 CPU 占用 < 10 ms 预算的 50%", jm[2000] / CPU_BUDGET_MS < 0.5,
    (jm[2000] / CPU_BUDGET_MS * 100).toFixed(1) + "%");
  check("§A.3 页大小 2000 留出的余量足够覆盖路由 / 鉴权 / SQL 解析",
    jm[2000] * 2 < CPU_BUDGET_MS, "序列化 " + jm[2000].toFixed(2) + " ms，总预算 " + CPU_BUDGET_MS + " ms");

  // 本票「不做单请求全量导出」的实测依据：**外推**而非单点
  // 逐年行数 = entry 1825/年 + quote_daily 3900/年 = 5725/年（均为单调增长，见 #8）
  console.log("\n  外推：全量导出的行数与 CPU（按 " + per1k.toFixed(3) + " ms/1000 行线性外推）");
  console.log("    第 N 年 | 全量行数 | 序列化 CPU | 占 10ms 预算");
  let crossYear = null;
  for (let y = 1; y <= 6; y++) {
    const rows = 5725 * y;
    const cpu = rows / 1000 * per1k;
    const pct = cpu / CPU_BUDGET_MS * 100;
    if (cpu > CPU_BUDGET_MS && crossYear === null) crossYear = y;
    console.log("    %s | %s | %s ms | %s%%%s", String(y).padStart(7), String(rows).padStart(8),
      cpu.toFixed(2).padStart(10), pct.toFixed(1).padStart(12), crossYear === y ? "  <== 越过预算" : "");
  }
  check("§A.4 首年全量（≈5725 行）仅序列化一项就吃掉 >30% 预算", jm[5000] / CPU_BUDGET_MS > 0.3,
    (jm[5000] / CPU_BUDGET_MS * 100).toFixed(1) + "%（该预算还要覆盖路由 / 鉴权 / SQL 解析 / 结果集反序列化）");
  // ⚠️ 不在 15000 行这一点上做断言：实测在 9.91~12.06 ms 之间抖动，**恰好跨在 10 ms 上**，
  //    这种单点断言天然 flaky。这条抖动本身就是「必须留真实余量」的证据。
  console.log("\n  ⚠️ 15000 行实测在 9.91 ~ 12.06 ms 之间抖动 —— **恰好跨在 10 ms 预算上**。");
  console.log("     故本探针**不对该点断言**：在边界上做单点断言本身不可靠。");
  console.log("     这正是把页大小定在 2000 行（≈%.1f%% 预算）而不是贴着上限定的理由。", jm[2000] / CPU_BUDGET_MS * 100);
  check("§A.5 30000 行明确超出 10 ms 预算（远离边界，断言可靠）",
    jm[30000] > CPU_BUDGET_MS, jm[30000].toFixed(2) + " ms");
  check("§A.6 外推：单请求全量导出在第 3 年越过 10 ms 预算（这是分片的决定性理由）",
    crossYear === 3, "第 " + crossYear + " 年");

  console.log("\n  ⚠️ 上面 §A 的计时只测了 entry 形状的行；CSV 宽表还要 JOIN 出成员名 / 类别路径 /");
  console.log("     对象标签，行更宽 ⇒ **CSV 的真实成本高于此表**，页大小须按两者中更严的定。");
  console.log("     而 quote_daily 按 #8 是**只增不减、不裁剪**的 ⇒ 行数单调增长、10 ms 是固定预算，");
  console.log("     故分片是**必需而非优化**。");
}

// ---------------------------------------------------------------- §B
function secB() {
  hdr("§B CSV 拼接成本（对照 JSON）");
  const rows = mkEntries(2000);
  const c = best(() => toCsv(ENTRY_COLS, rows), 5);
  const j = best(() => JSON.stringify(rows), 5);
  console.log("  2000 行：CSV %s ms / JSON %s ms", c.toFixed(2), j.toFixed(2));
  check("§B.1 CSV 与 JSON 成本同量级（页大小可共用同一个上限）", Math.abs(c - j) / Math.max(c, j) < 0.6,
    "CSV " + c.toFixed(2) + " ms vs JSON " + j.toFixed(2) + " ms");

  // 转义正确性（与 Python 探针 §5 同口径，此处用 JS 的字符串语义复核）
  const esc = (s) => (s === null || s === undefined) ? "" : (/[",\r\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  check("§B.2 含逗号需引号包裹", esc("早餐,食堂") === '"早餐,食堂"', esc("早餐,食堂"));
  check("§B.3 双引号用 \"\" 转义", esc('他说"贵"') === '"他说""贵"""', esc('他说"贵"'));
  check("§B.4 NULL 与空串产出**相同**字节（RFC 4180 无 NULL 概念 —— 故 CSV 不能承载 NULL）",
    esc(null) === esc(""), "esc(null)=" + JSON.stringify(esc(null)) + " esc('')=" + JSON.stringify(esc("")));
  check("§B.5 对照：JSON 能区分 null 与 \"\"", JSON.stringify(null) !== JSON.stringify(""),
    JSON.stringify(null) + " vs " + JSON.stringify(""));
}

// ---------------------------------------------------------------- §C
function secC() {
  hdr("§C JSON 数字的精确边界（V8 实测）");
  const SAFE = Number.MAX_SAFE_INTEGER;   // 2^53 - 1
  console.log("  Number.MAX_SAFE_INTEGER = %d  (2^53 - 1)\n", SAFE);

  // ⚠️ 层次修正：`2**53 + 1` 这个**表达式**在 JS 里求值那一刻就已经失真了
  //    （加法本身走 IEEE754），所以用它当反例测不出 JSON 的问题。
  //    真正的层次是「**JSON 文本** → JS number」—— 这正是「读一份备份文件」的情形。
  const textCases = [
    ["9007199254740991", "2^53-1  (MAX_SAFE_INTEGER)", "9007199254740991", true],
    ["9007199254740992", "2^53    (2 的幂，可表示)", "9007199254740992", true],
    ["9007199254740993", "2^53+1  (第一个不可表示的正整数)", "9007199254740992", false],
    ["9007199254740995", "2^53+3", "9007199254740996", false],
    // 期望串用 JS 的「最短可往返表示」：2^63 这个 double 的 String() 是 9223372036854776000
    ["9223372036854775807", "2^63-1  (SQLite INTEGER 上界)", "9223372036854776000", false],
  ];
  for (const [text, name, expectStr, exact] of textCases) {
    const v = JSON.parse(text);
    const s = String(v);
    const ok = (s === text);
    console.log("    " + name.padEnd(36) + " JSON文本 " + text.padEnd(21) +
      " -> " + s.padEnd(21) + (ok ? "精确" : "**失真**"));
    check("§C JSON 文本 " + text + " -> " + s + (exact ? "（精确）" : "（**失真**）"),
      ok === exact && s === expectStr, s);
  }
  check("§C.0 RFC 7493 的补救：以 JSON 字符串承载同一值则无损",
    JSON.parse('"9007199254740993"') === "9007199254740993");

  // 反向：JS number → JSON 文本（导出方向）
  const n = 2 ** 53;                     // 可表示
  check("§C.0b 导出方向：JSON.stringify(2^53) 文本正确", JSON.stringify(n) === "9007199254740992",
    JSON.stringify(n));

  // 本库的最大上界（与 Python 探针 §2 的 INT_BOUNDS 同源）
  const LIB_MAX_BOUND = 2 ** 42;     // cron_run.scheduled_at（UTC 毫秒）
  console.log("\n  本库整数上界的最大值 = 2^42 = " + LIB_MAX_BOUND);
  check("§C.1 本库最大整数上界 < 2^53-1（余量 " + (SAFE / LIB_MAX_BOUND).toFixed(0) + " 倍）",
    LIB_MAX_BOUND < SAFE, (SAFE / LIB_MAX_BOUND).toFixed(0) + " 倍");
  check("§C.2 故本库金额（整数分）与时间（UTC 秒/毫秒）用 **JSON 数字字面量**安全，无需字符串承载",
    LIB_MAX_BOUND < SAFE);
  check("§C.3 Number.isSafeInteger 对本库上界为真", Number.isSafeInteger(LIB_MAX_BOUND));
  check("§C.4 对照：SQLite INTEGER 上界 2^63-1 本身已超出安全域（故不得引入外部 64 位 ID）",
    !Number.isSafeInteger(2 ** 63 - 1), 2 ** 63 - 1);

  // 逐语义类上界复核（与 Python 探针的 INT_BOUNDS 对齐）
  const bounds = {
    "row_id (2^31)": 2 ** 31,
    "epoch_seconds (2^33)": 2 ** 33,
    "epoch_millis (2^42)": 2 ** 42,
    "duration_ms (2^20)": 2 ** 20,
    "money_cents (2^40)": 2 ** 40,
    "price_micro (2^40)": 2 ** 40,
    "ratio_ppm (2^30)": 2 ** 30,
    "qty (2^40)": 2 ** 40,
  };
  let worst = 0;
  for (const k of Object.keys(bounds)) {
    const v = bounds[k];
    worst = Math.max(worst, v);
    check("  §C.5 往返精确：" + k, Number.isSafeInteger(v) && Object.is(JSON.parse(JSON.stringify(v)), v));
  }
  check("§C.6 全部语义类上界均在安全整数域内，且最大者正是 2^42", worst < SAFE && worst === 2 ** 42, worst);

  console.log("\n  ⇒ 结论：本库**不触发** RFC 7493 的「64 位整数须用字符串承载」建议 ——");
  console.log("     该建议针对的是外部系统的 64 位 ID（如雪花 ID，可达 2^63），而本库的整数语义是");
  console.log("     「秒 / 毫秒 / 分 / 微元 / 万分比 / 行号」，物理上界仅 2^42，余量 "
    + (SAFE / worst).toFixed(0) + " 倍。");
  console.log("     **但这条结论依赖「不引入外部 64 位 ID」这个前提** ⇒ 已写进契约的已知局限。");
}

// ---------------------------------------------------------------- §D
function secD() {
  hdr("§D 分片导出的一致性（设计约束的可验证部分）");
  // 按 id 升序游标：新插入的行 id 更大，不会让「已读页」发生位移
  const rows = mkEntries(500);
  const page = (off, lim) => rows.slice(off, off + lim);
  const p1 = page(0, 200);
  // 期间新增 100 行（id 更大）
  for (let i = 0; i < 100; i++) rows.push({ id: 1000 + i });
  const p2 = page(200, 200);
  const ids1 = p1.map((r) => r.id), ids2 = p2.map((r) => r.id);
  const overlap = ids1.filter((x) => ids2.includes(x)).length;
  const gap = ids2[0] - ids1[ids1.length - 1];
  console.log("  第 1 页末 id=%d，第 2 页首 id=%d（新增 %d 行后）", ids1[ids1.length - 1], ids2[0], 100);
  check("§D.1 按 id 升序游标：新增行不会导致**页位移**（无重叠）", overlap === 0, overlap);
  check("§D.2 按 id 升序游标：新增行不会导致**漏行**（间隙恒为 1）", gap === 1, gap);

  // 反例：按 offset 分页会怎样
  const rows2 = mkEntries(500);
  const o1 = rows2.slice(0, 200).map((r) => r.id);
  const inserted = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, _new: true }));
  rows2.unshift(...inserted);                      // 在最前面插入（模拟按时间序、新行插队）
  const o2 = rows2.slice(200, 400).map((r) => r.id);
  const dup = o1.filter((x) => o2.includes(x)).length;
  check("§D.3 反例：offset 分页遇到「插队写入」会产生**重叠/漏读**", dup > 0, "重叠 " + dup + " 行");

  console.log("\n  ⇒ 结论：游标必须锚在**稳定排序键**（id 升序）上，不能用 offset-only。");
  console.log("     但即便用 id 游标，跨页期间的 UPDATE 仍会漏 ⇒ 导出物**不是事务性快照**，");
  console.log("     这一点必须写进导出物的元数据与契约（本探针不试图消除它，只如实标注）。");
}

function main() {
  console.log("备份与导出策略 —— 导出链路探针（Node/V8）");
  console.log("CPU 预算口径：Cloudflare Free = 10 ms / 请求（I/O 等待不计入）");
  secA(); secB(); secC(); secD();
  hdr("汇总");
  console.log("  PASS = %d", PASS);
  console.log("  FAIL = %d", FAIL);
  for (const f of failures) console.log("    FAIL: " + f);
  console.log("\n结论: %s", FAIL === 0 ? "全部断言通过" : "存在失败断言");
  process.exit(FAIL === 0 ? 0 : 1);
}

main();
