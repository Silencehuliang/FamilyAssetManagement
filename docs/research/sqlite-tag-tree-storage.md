# 调研笔记：家庭财务管理系统 —— 层级标签（tag）数据模型

> 调研目标：在 Cloudflare D1（免费套餐，每次 Worker 调用 ≤ 50 次查询，读多写少）约束下，
> 选择「取出完整标签树」与「按任意祖先聚合后代金额」查询数最少的层级存储模式。
>
> 检索日期（口径日期）：**2026-09-15**。除特别标注外，官方文档页面均为 current 版本，不附带逐版本日期，
> 故以检索日作为口径日期。社区/推断类结论单独标注，不与官方结论混同。

---

## 0. 硬约束事实（来自官方文档）

| 约束 | 官方口径 | 来源 |
|---|---|---|
| 每次 Worker 调用的查询数上限 | **50（Free）/ 1000（Workers Paid）**，字段名 “Queries per Worker invocation (read subrequest limits)” | https://developers.cloudflare.com/d1/platform/limits （current，检索 2026-09-15） |
| `LIKE` / `GLOB` 模式最大长度 | **50 bytes**（“Maximum characters (bytes) in a LIKE or GLOB pattern”） | 同上 |
| D1 运算的 CPU/内存归属 | “Operations on a D1 database, including query execution and result serialization, run within the Workers platform CPU and memory limits.” —— 即查询计算**计入** Worker CPU 预算 | 同上（FAQ 段） |
| D1 与 SQLite 的关系 | “D1 is compatible with most SQLite's SQL convention since it leverages SQLite's query engine.” | https://developers.cloudflare.com/d1/build-databases/query-databases/ （current，检索 2026-09-15） |

> 说明：用户给出的「Worker 每请求 CPU 上限 10ms」与官方「within the Workers platform CPU limits」口径一致（10ms 为 Workers 最小计费/包含 CPU 单位）。本笔记不挑战该数值，仅确认 D1 查询计算计入其中，因此“少查询”比“单查询内多算”更划算。

---

## 1. D1 对递归 CTE（`WITH RECURSIVE`）的支持

### 结论
**未找到 D1 官方文档对「支持 `WITH RECURSIVE`」的明确声明。** 仅有间接证据链：

1. **官方（D1 查询文档）**：D1 “leverages SQLite's query engine”，兼容大多数 SQLite SQL 约定。
   来源：https://developers.cloudflare.com/d1/build-databases/query-databases/
2. **官方（SQLite 文档）**：递归 CTE 自 **SQLite 3.8.3（2014 年发布）** 起原生支持，属 SQLite 核心能力。
   来源：https://sqlite.org/lang_with.html （“Recursive common table expressions provide the ability to do hierarchical or recursive queries of trees and graphs”）
3. **旁证（同门产品 Durable Objects `storage.sql`，非 D1）**：Cloudflare 官方示例直接使用了 `WITH RECURSIVE`（如 thread_tree 层级查询），证明 Cloudflare 的 SQLite 引擎实现了该特性。
   来源：Cloudflare Durable Objects 文档/示例（非 D1 文档）

### D1 当前使用的 SQLite 版本
**未找到权威来源声明 D1 的具体 SQLite 版本号。** 检索到的信息：
- 社区文章（crashbytes，2026）明确指出 “Cloudflare does not publish a pinned version number — there is no version field in the docs or the dashboard”。→ 归类为**社区经验/推断**。
- 社区文章（dev.to，2026）称 “Update your compatibility_date to 2024-09-23 or later to get full SQLite 3.46”（如 `RETURNING` 等 3.46 特性）。→ 归类为**社区经验/推断**，非官方。

> 审计判定：**D1 递归 CTE 支持属于「间接证据 + 高概率」，不应作为架构唯一依赖**。这正是下方推荐“不依赖递归 CTE” 模式的根本原因。

---

## 2. SQLite 中层级数据的四种存储模式对比

> 以下四模式为数据库领域经典方案（Bill Karwin《SQL Antipatterns》及 SQLite 官方递归/查询优化文档），
> 非 D1 专有。所有“单条 SQL”计数均指在**一次 Worker 调用内用 1 条 SQL 语句**完成，不依赖应用层按层往返。

### 2.1 邻接表（adjacency list）
- 定义：每行存 `parent_id` 自引用指向父节点。
- 取全树：1 条 `SELECT * FROM tags`（取全部行，树结构在应用层组装）。
- 取某节点全部后代：**单条 SQL 不可行，除非使用递归 CTE**（`WITH RECURSIVE` 自连接）。若不用递归，则需按层逐次查询（深度 D 级 → 最多 D 次往返）。
- 插入：低。读父 `parent_id` + 1 次 `INSERT`。
- 移动子树：低。1 次 `UPDATE` 改被移动节点的 `parent_id`，所有后代自动跟随。
- 来源：经典方案（社区/经典文献）；递归写法见 sqlite.org/lang_with.html。

### 2.2 路径枚举（path enumeration）
- 定义：每行存 `path` 字段，如 `/1/7/23/`（以 `/` 分隔、以 `/` 结尾，保证前缀匹配无歧义）。
- 取全树：**1 条** `SELECT * FROM tags ORDER BY path`（路径字典序即层级顺序）。
- 取某节点全部后代：**1 条，无需递归**：`WHERE path LIKE '/1/7/%'`。
- 插入：低。读父 `path` + 1 次 `INSERT`（拼 `父path + 自身id + '/'`）。
- 移动子树：中。需重写该子树**所有后代**的 `path`：`UPDATE tags SET path = ... WHERE path LIKE '/旧前缀%'`，写次数 = 后代数量。在 <200 节点、深度 ≤3 时代价极小。
- 来源：经典方案；`LIKE` 前缀可索引性见 sqlite.org/optoverview.html（第 3 节）。

### 2.3 闭包表（closure table）
- 定义：主表 `tags` + 一张独立关系表 `tag_closure(ancestor, descendant, depth)`，存所有祖先-后代对（含自身）。
- 取全树：1 条 `SELECT * FROM tags`（应用层组装，或 JOIN 闭包取 depth）。
- 取某节点全部后代：**1 条，无需递归**：`SELECT t.* FROM tags t JOIN tag_closure c ON c.descendant = t.id WHERE c.ancestor = ?`。
- 插入：中。主表 1 行 + 闭包表 (depth+1) 行（自身 + 各祖先链），可在一次 `db.batch()` 内完成。
- 移动子树：中高。删旧祖先链路 + 插新祖先链路，写次数 ≈ 子树规模 × 深度，可在 `batch()` 内完成。
- 来源：经典方案（社区/经典文献）。

### 2.4 嵌套集（nested set）
- 定义：每行存 `lft` / `rgt` 左右边界值。
- 取全树：1 条 `SELECT * FROM tags ORDER BY lft`。
- 取某节点全部后代：**1 条，无需递归**：`WHERE lft BETWEEN X.lft AND X.rgt`。
- 插入：高。需把右侧所有节点的 `lft`/`rgt` 整体后移，O(N) 次写。
- 移动子树：高。需临时重编号 + 重排，O(N) 次写，逻辑易错。
- 来源：经典方案（社区/经典文献）。

### 2.5 四模式对比表

| 模式 | 取全树查询数 | 取后代查询数 | 单条 SQL 是否可行 | 插入代价 | 移动子树代价 | 来源 URL |
|---|---|---|---|---|---|---|
| 邻接表 | 1（应用层组装） | 1（**仅限递归 CTE**；否则每级 1 次） | **否**（除非递归 CTE） | 低：读父+1 INSERT | 低：1 UPDATE 改 parent_id | 经典方案；递归见 sqlite.org/lang_with.html |
| 路径枚举 | 1（`ORDER BY path`） | 1（`LIKE '/前缀%'`） | **是（无需递归）** | 低：读父path+1 INSERT | 中：`UPDATE...WHERE path LIKE 旧前缀%`（后代数 次写） | 经典方案 + sqlite.org/optoverview.html |
| 闭包表 | 1（取全部行） | 1（`JOIN` 闭包表 `ancestor=?`） | **是（无需递归）** | 中：节点1行+闭包(depth+1)行，batch 内 | 中高：删旧链+插新链，batch 内 | 经典方案 |
| 嵌套集 | 1（`ORDER BY lft`） | 1（`BETWEEN lft AND rgt`） | **是（无需递归）** | 高：重排右侧所有 lft/rgt，O(N) 写 | 高：重排+临时编号，O(N) 写，易错 | 经典方案 |

> 关键标注：**只有「路径枚举、闭包表、嵌套集」可以仅用一条普通 SQL（不递归）完成「取全部后代」**。
> 其中路径枚举靠 `LIKE` 前缀，闭包表/嵌套集靠 `JOIN` / 区间比较。

---

## 3. 前缀匹配查询的可索引性（关键）

### 3.1 `WHERE path LIKE '/1/7/%'` 在 SQLite 能否命中索引？
**能，但必须满足 SQLite 官方《The LIKE Optimization》规定条件。**

官方原文（https://www.sqlite.org/optoverview.html ，第 5 节 “The LIKE Optimization”，检索 2026-09-15）：

> “The LIKE optimization might occur if the column named on the left of the operator is indexed using the built-in **BINARY** collating sequence and **case_sensitive_like** is turned on. Or the optimization might occur if the column is indexed using the built-in **NOCASE** collating sequence and the **case_sensitive_like** mode is off. These are the only two combinations under which LIKE operators will be optimized.”

> “The right-hand side of the GLOB or LIKE operator must be either a literal string or a parameter that has been bound to a string literal. The string literal must not begin with a wildcard; if the right-hand side begins with a wildcard character then this optimization is not attempted.”

> 当模式为 `column LIKE x%` 且仅右侧有一个全局通配符时：**“the original LIKE ... tests are disabled when the virtual terms constrain an index”** —— 即直接用索引虚拟项 `column >= x AND column < y` 圈定范围，无需再对每行做 LIKE 判断。

**落地条件（针对 D1 实操建议）：**
- `path` 列建索引，且排序规则选 **NOCASE**（`CREATE INDEX ... ON tags(path COLLATE NOCASE)`），保持 `case_sensitive_like` 默认 OFF → 命中优化（路径只含数字与 `/`，NOCASE 无副作用，最稳）。
- 或建 **BINARY** 索引并在连接中 `PRAGMA case_sensitive_like=ON`（D1 是否能设 PRAGMA 未找到官方确认，故**优先选 NOCASE 方案**）。
- `LIKE` 右侧必须是字面量或绑定参数，且**不以通配符开头**：`'/1/7/%'` 以 `/` 开头，合规。
- 受 D1 限制：LIKE 模式 ≤ **50 bytes**（官方 limits）——前缀模式很短，远未触及上限。

### 3.2 路径存成「整数数组」或「定长零填充」是否更好？
- **整数数组（BLOB / JSON array）**：**不推荐**。数组无法用 `LIKE` 前缀索引，要么退化为全表扫描，要么必须用递归/应用层遍历，与“最少查询”目标相悖。→ 我的推断（基于 3.1 索引条件）。
- **定长零填充路径**（如 `/0000000001/0000000007/`，每级固定宽度）：
  - 仍可用 `LIKE '/0000000001/0000000007/%'` 前缀命中索引（条件同 3.1）。
  - 额外收益：字典序 == 层级顺序，**无需单独排序列即可天然有序**；且定宽避免 `/1/` 与 `/10/` 比较歧义（但 `/1/` vs `/10/` 问题已用「每级以 `/` 结尾」的定界法解决，非必需）。
  - 代价：路径更长，但仍远小于 50 bytes 限制；写入时需格式化。
  - 结论：零填充是**可选增强**（尤其想白嫖字典序排序时），非必需。→ 我的推断（基于 3.1 + 字符串定宽比较常识）。

---

## 4. 排序与「稳定展示顺序」

需求：同级可拖拽排序，需用户自定义展示顺序。

- **路径枚举 / 闭包表 / 嵌套集** 本身**不编码**同级自定义顺序：
  - 路径枚举的 `ORDER BY path` 给的是“创建/字典序”，**非**用户拖拽顺序。
  - 做法：在主表加一个 `sort_order INTEGER` 列（同级内唯一）。取树时 `ORDER BY path, sort_order`（路径枚举）或 `ORDER BY sort_order`（闭包/邻接在应用层组装时按 sort_order 排）。
  - 插入节点：赋 `sort_order = (同级最大 + 1)`，O(1)。
  - 移动子树：路径枚举需重写后代 `path`（已在 2.2 计入）；`sort_order` 随节点一起保留，不受子树移动影响。闭包表同理。
  - 同级重排（拖拽）：更新涉及行的 `sort_order`，通常为批量 `UPDATE`，可在 `batch()` 内完成；节点数 <200 时成本可忽略。
- 来源：排序字段为通用实践（社区/经典设计推断），非单一官方文档。D1 `batch()` API 见官方 Worker API 文档（https://developers.cloudflare.com/d1/worker-api/d1-database/）。

---

## 5. 结论与推荐

约束回顾：层级深度大概率 ≤ 3 级、标签数 < 200、单次请求 ≤ 50 查询、读多写少、且**不希望架构依赖递归 CTE**。

**推荐：路径枚举（path enumeration）为主，闭包表为备选。**

理由（对照硬约束）：
1. **取全树**：`SELECT * FROM tags ORDER BY path` —— **1 条 SQL，无递归**。
2. **按任意祖先聚合后代金额**：`SELECT SUM(amount) FROM tags WHERE path LIKE ?`（`?` = 该祖先 path 前缀）—— **1 条 SQL，无递归，可命中 LIKE 索引**（满足第 3 节条件）。
3. **不依赖 `WITH RECURSIVE`**：即使 D1 递归 CTE 存在坑（第 1 节已说明无官方明确保证），本方案完全不受影响。
4. **查询预算宽裕**：一次请求通常 1~3 条 SQL（取树 1 条 + 聚合 N 条），远低于 50 上限。
5. **写入代价在约束内可接受**：<200 节点、深度 ≤3，移动子树最差改写几十行 `path`，用 `batch()` 一次请求内完成，写操作按行计费但量极小。

**为何不选其他：**
- 邻接表：取后代必须递归 CTE，违反“不依赖递归”的稳妥诉求。
- 嵌套集：插入/移动需 O(N) 重排 `lft`/`rgt`，写代价最高、易错，不适合任何频度的写。
- 闭包表：功能等价且同样不依赖递归，但需第二张表 + 每次写维护多条闭包行；在 <200 节点规模下优势不明显，可作为“后续若子树聚合极频繁、想用纯 JOIN 替代 LIKE”时的升级方案。

**一句话**：路径枚举用「定界前缀 + LIKE 索引」把“取树”和“取后代聚合”都压成单条非递归 SQL，最契合 D1 的 50 查询预算与“不依赖递归”的稳健性要求。

---

## 附：来源清单（可审计）

| # | 来源 URL | 类型 | 口径日期 | 证明内容 |
|---|---|---|---|---|
| 1 | https://developers.cloudflare.com/d1/platform/limits | 官方 | 2026-09-15 | 50/1000 查询上限；LIKE 模式 ≤50 bytes；D1 运算计入 Worker CPU |
| 2 | https://developers.cloudflare.com/d1/build-databases/query-databases/ | 官方 | 2026-09-15 | D1 复用 SQLite 查询引擎，兼容多数 SQLite 约定 |
| 3 | https://sqlite.org/lang_with.html | 官方 | 2026-09-15 | 递归 CTE 自 SQLite 3.8.3 起原生支持 |
| 4 | https://www.sqlite.org/optoverview.html | 官方 | 2026-09-15 | The LIKE Optimization：两组合、RHS 非通配符前缀、`x%` 禁用原测试 |
| 5 | https://developers.cloudflare.com/d1/worker-api/d1-database/ | 官方 | 2026-09-15 | `batch()` API（一次调用多语句） |
| 6 | https://crashbytes.com/articles/cloudflare-d1-serverless-sql-database | 社区 | 2026 | “D1 不公布固定 SQLite 版本号” |
| 7 | https://dev.to/whoffagents/cloudflare-d1-sqlite-at-the-edge-after-6-months-in-production-551j | 社区 | 2026 | compatibility_date ≥ 2024-09-23 可得 SQLite 3.46 特性（社区推断，非官方） |
| 8 | 四模式定义与代价 | 经典文献/推断 | — | Bill Karwin《SQL Antipatterns》等通用层级建模知识 |

**未找到权威来源的声明（严禁当作事实）：**
- D1 官方**未明确声明**支持 `WITH RECURSIVE`（仅有“复用 SQLite 引擎”的间接证据）。
- D1 **未公布**具体 SQLite 版本号（社区称约 3.46，属推断）。
- 排序字段、`sort_order` 维护方式为通用设计推断，非单一官方文档。

---

## 6. 实测补充（2026-09-15）

> **触发**：决策票 «标签体系数据模型» 最终把层级定为**硬性两级**（组 › 标签），比本笔记上文
> 第 5 节所设的「深度 ≤ 3」前提更窄。因此在裁决 «标签聚合与查询语义» 时，建样例库实测了
> 聚合 SQL 与索引命中，结论对本节之前的推荐做了一处**修正**。
>
> **口径**：本机 Python 3.13 自带 **SQLite 3.53.1**。**这不是 D1 的版本**——D1 侧须以
> `SELECT sqlite_version()` 另行复核。可复跑脚本与完整输出见
> `docs/verification/tag-aggregation-probe.py` 与 `.out.txt`。

### 6.1 聚合：两级约束下无需 path 前缀匹配

父标签金额 = 自身直挂 + 全体后代，**单条 SQL、无递归**：

```sql
SELECT COALESCE(p.id, t.id) AS group_id,
       SUM(e.amount_cents)  AS total
FROM entry e
JOIN tag t      ON e.category_tag_id = t.id
LEFT JOIN tag p ON t.parent_id = p.id
GROUP BY COALESCE(p.id, t.id)
```

实测：各根组之和 **5,400 元** = 总支出 **5,400 元**，守恒成立。
同一查询可扩展为「类别 × 成员」交叉表（`SUM(CASE WHEN member_id = ? …)`），仍是一条 SQL。

### 6.2 索引陷阱：`path LIKE` 前缀在默认配置下**全表扫描**

| 索引形态 | `case_sensitive_like` | 字面量 pattern | 绑定参数 pattern |
|---|---|---|---|
| `path`（BINARY） | OFF（SQLite 默认） | **SCAN tag** | **SCAN tag** |
| `path`（BINARY） | ON | SEARCH … USING INDEX | SEARCH … USING INDEX |
| `path COLLATE NOCASE` | OFF（默认） | SEARCH … USING INDEX | SEARCH … USING INDEX |

→ **默认配置 + 普通索引 = 全表扫描**。若仍采用 path 前缀方案，**必须**给索引加
`COLLATE NOCASE`（或在连接中开 `PRAGMA case_sensitive_like=ON`，但 D1 能否设该 pragma
未找到官方确认，故 NOCASE 是唯一稳妥项）。绑定参数与字面量 pattern 行为一致。

### 6.3 结论修正

在**硬性两级**的实际约束下，`path` 前缀匹配是**多余**的：

- 取某组的子标签 → `WHERE parent_id = ?`
- 父 = 自身 + 后代 → §6.1 的自连接
- 相邻层钻取 → 单次 JOIN，无需递归、无需前缀

因此 **`path` 字段降级为展示与排错的冗余字段，不参与任何查询**，也就完全绕开 §6.2 的陷阱。

对上文第 5 节的处置：**「路径枚举」的推荐在「深度 ≤ 3」前提下依然成立**（原文保留不改，
以保持可追溯）；但在两级前提下，**邻接表（`parent_id` 自连接）是更简且更稳的选择**。
第 2.1 节原判「邻接表取后代必须递归」仅在**任意深度**下成立——两级是它的一个特例，
一次 `LEFT JOIN` 即可覆盖。
