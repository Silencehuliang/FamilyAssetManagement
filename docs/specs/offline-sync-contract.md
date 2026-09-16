# PWA 与移动端离线 · 实现契约

> 决策来源：决策票 #10 «PWA 与移动端离线策略»
> 落地 DDL：`migrations/0003_offline.sql`（**唯一真相**）
> 可复跑实测：`docs/verification/offline-sync-probe.py` / `.out.txt`
> 本文件是**实现契约**，不是决策记录 —— 决策的论证与取舍住在那张票里。

---

## 1. 一句话总纲

**可离线写入，但只开一个口子：新增 Entry。** 离线队列存 **IndexedDB**；重放靠**前台触发**
（Safari 无 Background Sync，这条已被一手事实钉死）；幂等靠**客户端生成的 `client_ref`**；
编辑 / 删除 / 持仓 / 除权 / 预算 / 标签 / 分析页**一律在线**。
`manifest.display` 必须为 `standalone` —— 它决定 iOS 是否把本域排除在 ITP 的 7 天清除之外。

---

## 2. 端到端流程

```
① 在线记账  POST /api/entries
            → 客户端先生成 client_ref（一次，永不变）
            → INSERT ... ON CONFLICT(client_ref) DO NOTHING

② 离线记账  用户点保存 → 写 IndexedDB 队列（带 client_ref）
            → UI 立即按已录入呈现，并打「待同步」标记

③ 重放     触发点 = App 启动 / online / visibilitychange→visible
            且「队列非空」且「距上次 ≥30s」
            → 一次请求带整批 →  服务端：逐条应用层校验
                                 → 1 条预校验 SQL
                                 → 有效者进 1 个事务
            → 响应逐条 {client_ref, status, entry_id?}
            → created/duplicate 出队；rejected 留队标红

④ 读        列表 = 服务端缓存响应 ∪ 队列（前端合并，队列项带标记）
            汇总 = 只用服务端缓存值 + 「另有 N 条待同步未计入」（见 §8.3）

⑤ SW 更新   检测到 waiting → 提示条（队列非空时一并显示 N 条）
            → 用户点击 → messageSkipWaiting() → controlling → reload
```

---

## 3. 迁移 `0003_offline.sql` 的三处结构决定

| # | 决定 | 依据（实测见探针） |
|---|---|---|
| 1 | **先加可空列，再建唯一索引** | SQLite 的 `ALTER TABLE ADD COLUMN` 不能加 `UNIQUE`，也不能加无默认值的 `NOT NULL`（A1/A2 实测被拒）⇒ 三步而非一条 DDL |
| 2 | **历史行留 `NULL`** | 唯一索引中 **NULL 互不冲突**，正是「历史行无需幂等键」的语义（B1/B2）。⚠️ 这与 #14 的预算版本 NULL 陷阱是**同一条事实、相反的用法** |
| 3 | **新行非空由触发器把关** | `ALTER ... ADD COLUMN` 带 `CHECK` 时不对既有行求值，但**既有行之后一旦被 UPDATE 就会重新求值**（A3/A4）；`entry` 上已有 `biz_date` 的 CHECK，故改用「只管新写入」的触发器 |

**刻意不做**：不校验 `client_ref` 格式（唯一性才是语义，锁死 36 字符会让将来换 ULID 多一次迁移）；
不加 `BEFORE UPDATE` 触发器（没有这条路径）；不新增 `synced_at` 列（`created_at` 已承载接收时刻）。

**`entry_object` 无需改动** —— 主键 `(entry_id, tag_id)` 天然幂等。

---

## 4. 数据契约

### 4.1 `client_ref`

| 项 | 规定 |
|---|---|
| 生成者 | **客户端**，在用户点「保存」的瞬间生成一次，**此后重试复用同一个值** |
| 形态 | UUID v4（`crypto.randomUUID()`，需安全上下文；MDN BCD：Safari / iOS **15.4** 起） |
| 适用范围 | **所有 Entry 都带**，不是离线专属 —— 在线同样有「点保存 → 超时 → 再点一次」的重复风险 |
| 可变性 | **一经写入不得修改**（应用层约束，SQL 不设触发器） |
| 格式约束 | SQL 层**不校验**；唯一性才是幂等所需的全部语义 |

### 4.2 `occurred_at` 与「不可指向未来」

`occurred_at` 恒指**发生时间**（#6 已冻结），可回填任意过去日期、**不可指向未来**。

**校验（应用层，服务端）**：`occurred_at <= 服务端 now + 300`（5 分钟容差）。

- 超出 ⇒ **拒绝该条**，返回明确原因，队列保留并标红提示用户修正时间。
- **绝不静默把时间夹到 `now`** —— 那会让用户看到一笔"发生在别处"的账，
  而且「不可指向未来」这条校验随即失去意义（永远不可能失败）。
- 5 分钟的依据：iPhone 通常经 NTP 同步、偏差 <1 秒；该容差只拦**真正出错**的设备。

### 4.3 `created_at` 的口径（一处必须说清的事）

**`created_at` 定义为「服务端接收该行的时刻」，恒为服务端时钟。**

| 路径 | 实际含义 |
|---|---|
| 在线录入 | ≈ 用户点保存的时刻（相差 <1s） |
| 离线重放 | **= 同步时刻**，不是用户录入的时刻 |

- 这样定义是为了**口径统一**：两种路径下它是同一把尺子量的。
- 代价：离线项「用户何时录的」**不可得**。因为没有任何消费者，故**不新增 `recorded_at` 列**。
- **UI 不得展示 `created_at`**（0001 已注明它是技术列）。

### 4.4 `biz_date`

由 `occurred_at` 推导，服务端**不重算** —— 0001 的 CHECK
（`biz_date = date(occurred_at,'unixepoch','+8 hours')`）保证二者自洽。

⚠️ **已知局限**：离线录入时该值由**设备时钟**算出。设备时钟错 ⇒ `biz_date` 跟着错，
而 CHECK 拦不住（因为两者自洽）。如实标注，不做规避。

---

## 5. 重放协议

### 5.1 端点

| 方法 | 路径 | 需认证 | 说明 |
|---|---|---|---|
| `POST` | `/api/entries/replay` | 是 | 离线队列整批重放 |

**请求**：

```json
{"items": [
  {"client_ref": "…-…-4…-…", "category_tag_id": 2, "amount_cents": 1500,
   "occurred_at": 1789000000, "biz_date": "2026-09-16", "object_tag_ids": [10, 11]}
]}
```

⚠️ **`member_id` 不在请求里** —— 它由**会话**决定（`context.data.member_id`）。
上游已冻结「录入者恒等于归属成员、不支持代记」，#9 的中间件已把成员挂进上下文；
客户端带 `member_id` 也**一律不信**。

**响应**：

```json
{"results": [
  {"client_ref": "…", "status": "created",   "entry_id": 231},
  {"client_ref": "…", "status": "duplicate", "entry_id": 231},
  {"client_ref": "…", "status": "rejected",  "reason": "category_tag_id 不存在"}
]}
```

`status` 三值：`created`（本次写入）/ `duplicate`（此前已写入，幂等命中）/ `rejected`（校验失败）。

### 5.2 服务端处理次序（**顺序不可调换**）

```
1. 逐条应用层校验    金额 > 0、occurred_at 在容差内、object_tag_ids ≤ 4、字段齐全
2. 1 条预校验 SQL    一次性查出：① 引用的 tag 是否存在且类型正确
                                  ② 哪些 client_ref 已经存在（用于判 duplicate）
3. 有效且未存在的条目 → 1 个 batch() 原子写入
4. 失败条目 + duplicate 条目 → 原样返回，不进事务
```

**为什么必须有第 2 步**：`batch()` 是原子事务，一条坏数据会**把整批拖下水**
（探针 §六 E1 实测：3 条含 1 条无效 ⇒ 整批回滚、净增 0 行）。
预校验把无效条目挡在事务之外，才能做到「逐条失败隔离」。
总代价：**1 次预校验查询 + 1 个事务**。

⚠️ 预校验与写入之间存在理论竞态窗口（这中间标签被删）。2 人自用可忽略；
且此时事务会整体回滚、**不会写入半条** —— 失败是显式的，不是静默的。

### 5.3 写入语句（**契约级，不得改写**）

```sql
-- ① 幂等插入
INSERT INTO entry (member_id, category_tag_id, amount_cents, occurred_at, biz_date, created_at, client_ref)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(client_ref) DO NOTHING;

-- ② 对象行；仅当该 entry 尚无对象时才插
INSERT INTO entry_object (entry_id, tag_id)
SELECT e.id, j.value
  FROM entry e, json_each(?8) j
 WHERE e.client_ref = ?7
   AND NOT EXISTS (SELECT 1 FROM entry_object eo WHERE eo.entry_id = e.id)
```

**禁用清单**：

| 禁用 | 理由 |
|---|---|
| `INSERT OR IGNORE` | 会吞掉**约束类**失败（主键 / NOT NULL / CHECK）⇒ 写入静默不一致。错误应显式暴露（实测：它**不**吞 `RAISE(ABORT)`，但吞约束违反） |
| `ON CONFLICT … DO UPDATE` | 重放**不得覆盖**已写入的值。实测 B6：同一 `client_ref` 带不同内容重放，已写入的值保持不变 |
| `RETURNING` 取 id | D1 的 SQLite 版本未核实（#14 已列）。改用一条 `SELECT id FROM entry WHERE client_ref IN (…)` 批量取回 |

### 5.4 为什么 `ON CONFLICT` 不可能退化成全表扫描

**删掉 `ux_entry_client_ref`，同一语句直接无法编译**（探针 §七 判据一实测）：

> `error: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`

即「`ON CONFLICT(client_ref)`」这个语义**本身就依赖该唯一索引** ⇒ 不存在「扫描找冲突」这条路径。

---

## 6. 离线队列

### 6.1 存储

**IndexedDB**。库名 `fam-offline`，object store `pending_entries`，主键 `client_ref`。

```js
{ client_ref, category_tag_id, amount_cents, occurred_at, biz_date,
  object_tag_ids: [], saved_at, sync_state: "pending" | "failed", last_error? }
```

**为什么是 IndexedDB**：`localStorage` 是同步 API（阻塞渲染），且本身就在 ITP 7 天清除清单里；
Cache Storage 的语义是 HTTP 响应，不是结构化队列。

### 6.2 生命周期（四条硬规则）

| 规则 | 内容 |
|---|---|
| **队列属于设备，不属于会话** | 登出、会话过期、改密码全端失效 —— **都不清空队列** |
| **登出前必须提示** | 队列非空时提示「N 条待同步，登出后将保留至下次登录」；「登出所有设备」同此 |
| **401 只挂起、不丢弃** | 重放遇 401 ⇒ 挂起 + 跳登录页（#9 的硬要求）；登录成功后**自动继续重放** |
| **不设过期** | 这是用户的账，系统无权替他决定丢弃。但 >7 天未同步的条目显式标「长期未同步」 |

**容量兜底**：队列达 **100 条**时停止接受新的离线录入并提示先联网。
该数字远高于真实使用（一次离线最多几笔），只是一道防无限堆积的闸。

### 6.3 触发与节流

触发点三个：**App 启动** · **`online` 事件** · **`visibilitychange → visible`**。
条件：队列非空 **且** 距上次重放 ≥ **30 秒**（否则网络抖动会连续打请求）。

### 6.4 失败隔离

逐条独立判定。被拒条目**留队、标红、显示服务端给的原因**，等用户手动处理。
**一条坏数据卡死整队是不可接受的。**

### 6.5 写行数

100 条 Entry ≈ 200 行（含索引），占 D1 日额度（10 万行）的 **0.2%**。不构成约束。

---

## 7. Service Worker

### 7.1 🔴 硬门禁：`manifest.display`

**必须为 `standalone`（或 `fullscreen`）。**

事实依据（WebKit 官方）：ITP 的「7 天无交互清除」**明确涵盖
`Service Worker registrations and cache`**；Home Screen web app 的第一方域名被
**明文豁免**，但该豁免**以 manifest 的 `display` 为 `standalone`/`fullscreen` 为前提**。
WebKit 工程师原话：

> *"There is no way to get an exception in Safari. If you adjust your manifest to use either the
> 'standalone' or 'fullscreen' display mode, your home screen web application will open full-screen
> in Web.app and you will get the behavior you want."* —— WebKit bug 232302

写成 `minimal-ui` 或省略 ⇒ **离线队列与 SW 缓存每 7 天被清空一次**。

### 7.2 缓存策略

| 对象 | 策略 |
|---|---|
| 静态资源（构建产物） | **precache**（`workbox-precaching`，`revision` 由构建期内容哈希生成，**禁止手写**） |
| `/api/*` 的 **GET** | `NetworkFirst` —— 网络优先，失败回落缓存；写缓存时**另记 `cachedAt` 时刻** |
| `/api/login`、`/api/session`、**任何非 GET** | **禁止缓存** |
| **全部分析页的 GET** | **不缓存** —— 筛选组合开放（分组轴 × 成员 × 时间区间 × 下钻），命中率低；离线时用户要的是「记下来」而不是「看分析」 |

🔴 **登出 / 会话失效时必须清空所有 runtime 缓存**（precache 保留）。
理由：SW 的 runtime 缓存**不区分会话**，若不清，同一设备上未认证的人可能看到已缓存的鉴权响应。
前端启动时先探 `/api/session`：未认证 ⇒ 清 runtime 缓存 + 跳登录页。

### 7.3 更新流程

```
SW 注册（workbox-window）
  → 检测到 waiting（新版本已就绪）
  → 站内提示条「有新版本」；**队列非空时一并显示「N 条待同步」**
  → 用户点击 → messageSkipWaiting() → controlling → location.reload()
```

- **禁用**安装期无条件 `skipWaiting()`。Chrome 系官方明确警告：
  > *"…unconditionally calling skipWaiting() … may be a bad idea"* —— 会让旧页面与新 SW 混用，
  > 对 SPA + 懒加载路由尤其危险（正是本项目的形态）。
- 提示条文案**必须说明「刷新不会丢失待同步记录」** —— 否则用户不敢更新
  （IndexedDB 不随页面刷新丢失，这是事实，但用户不知道）。

---

## 8. 离线能力分档

### 8.1 三档

| 档 | 能力 | 范围 |
|---|---|---|
| **完整可用** | 读 + 写 | **记一笔新账**（写入面唯一的口子）；**流水列表**（读缓存 ∪ 队列合并显示） |
| **只读降级** | 只读 | **首页汇总**（缓存值 + 待同步提示，见 §8.3）；**股票页**（缓存行情 + 双时间戳，见 §8.4） |
| **必须在线（置灰）** | 无 | 编辑 / 删除 Entry、持仓登记、除权确认、预算设置、标签管理、**全部分析页**、**设置页**（含「登出所有设备」） |

**设置页必须在线**：本地操作一个不存在的会话只会制造假信号。

### 8.2 写入面为什么只开 Entry 新增

上游已冻结「每笔 Entry 单归属一位成员、不支持代记」⇒ 不存在两人改同一笔；
再加「离线只装新增」⇒ **冲突面归零**（新增与新增之间天然无冲突）。
这把离线写入的成本从「冲突解决 + 合并语义」压到**只需要幂等**一件事。

### 8.3 离线时的汇总口径

**只用服务端缓存值，另显示「另有 N 条待同步未计入」。**

**不做**「前端把队列项加进汇总」—— 那意味着前端要复刻服务端的聚合口径
（子树合计、展开时的虚拟「未细分」行、对象维度的「未指定对象」桶、周期边界的 CST 换算……）。
**复刻口径就是造第二个真相源**，它必然漂移，而且是"看起来对、其实差了"的那种漂移。
宁可显示一个不完整但口径正确的数字，配一句明确说明。

### 8.4 离线时的行情

- 显示最后缓存的行情快照 + **双时间戳**：
  **数据日期**（`quote_daily.trade_date`，这是「数据截至」）+ **本地缓存时刻**。
  只给一个都会让人误判新鲜度。
- 文案示例：`离线显示 · 行情截至 2026-09-15（缓存于 09-16 09:12）`
- **持仓登记与除权确认在离线时置灰**并说明原因：这两件事每月只写入几次，**离线收益≈0**，
  而风险高（会造出重复的持仓版本，且 #13 R12 的三步撤销流程需要在线状态）。**不做离线排队。**

---

## 9. 移动端录入

### 9.1 纳入 / 排除

| 项 | 决定 | 说明 |
|---|---|---|
| 金额键盘 | ✅ 纳入 | `type="text"` + `inputmode="decimal"`（**不用 `type="number"`** —— 它忽略 `pattern`、`step` 默认 1、允许 `e`/`+`/`-`） |
| 常用标签置顶 | ✅ 纳入 | **服务端实时算**：取最近 20 笔 Entry 的标签频次，**1 条 SQL**，不建汇总表（与「报告 = 视图」同构） |
| 最近使用组合 | ✅ 纳入 | 同上一条 SQL 出「最近用过的类别＋对象组合」，一键复用 |
| 本地模板 | ✅ 纳入 | 纯前端存 IndexedDB 的一键预填（标签组合 + 金额）；**不落服务端、不新增表、不生成 Entry** |
| 服务端「定期消费」规则（房租等） | ❌ 排除 | 需要新表 + 一个 cron 去生成实例，而 **cron 配额只剩 1 个、要留给 #15 备份**；用「模板」替代 —— 一键预填、仍需手动确认 |
| 标签自动补全输入框 | ❌ 排除 | 标签集只有几十个，下拉选择比打字快；多一个交互形态不划算 |

### 9.2 金额解析（两条已实测的陷阱）

1. **同时接受 `.` 与 `,` 作为小数分隔符** —— WebKit bug 247242（仍 NEW）：
   iOS 键盘给 `.` 而输入框可能按区域显示 `,`。只认一处、其余一律判为非法输入。
2. **用字符串解析成整数分，禁用 `parseFloat(x) * 100`** —— 后者是浮点陷阱，
   #13 的探针已实测并记录。金额一律以 `INTEGER` 分进入系统。

---

## 10. 上线前门禁（必须逐项实测，不可推断）

| # | 项 | 判据 |
|---|---|---|
| 1 | `manifest.display === "standalone"` | **构建产物里断言**。写错 ⇒ ITP 每 7 天清空一切本地数据 |
| 2 | 真机 iOS PWA：断网记一笔 → 恢复网络 → 同步成功 | 且期间 UI 始终显示该笔（带「待同步」） |
| 3 | 队列非空时 SW 更新提示条出现 | 且显示「N 条待同步」 |
| 4 | 登出 / 会话过期后 runtime 缓存被清 | 未认证时打开 App 看不到任何缓存数据 |
| 5 | `sw.js` 的响应头不被长期缓存 | **待与 #12 确认** Cloudflare Pages 对 `/sw.js` 的默认 `Cache-Control`；若被长缓存，SW 更新检查会被 HTTP 缓存挡住 |
| 6 | D1 侧复核四项 | 见 §13.3 |

---

## 11. 给下游票的派生要求

### → «前端信息架构与页面清单»（#11）

1. **全局「待同步」指示器**（显示条数）。
2. 流水列表项需有**「待同步」视觉状态**，与已同步项可区分。
3. 登出前需有「N 条待同步」确认。
4. **iOS 安装引导条**：已登录 + 非 standalone + 从未引导过 ⇒ 底部一次性引导条，
   图文说明「分享 → 添加到主屏幕」；可关闭，关闭后**永久不再自动弹**（设置页保留入口）。
   检测以 `matchMedia('(display-mode: standalone)')` 为准，`navigator.standalone` 兜底。
   文案需跟上 iOS 26 的变化（已默认「Open as Web App」，无需教用户找开关）。
   ⚠️ `beforeinstallprompt` **只存在于 Chromium 系**，Safari 完全没有 ⇒ 必须自绘。
   **本期不做 Android / 桌面的安装引导**（Web 为辅）。
5. **离线时置灰的入口清单**见 §8.1；置灰须**说明原因**，不能只灰不说。
6. **没有注册页**（#9 已交，此处重申）；**不给访客链接留位置**。
7. **新版本提示条**（§7.3），队列非空时带「N 条待同步」。
8. **离线行情的双时间戳**（§8.4）。
9. 首页汇总在「离线且队列非空」时显示「另有 N 条待同步未计入」（§8.3）。

### → «部署拓扑定稿»（#12）

1. `/sw.js` 与 `/manifest.webmanifest` 必须由**静态层直出**，`_routes.json` 的 exclude 需覆盖，
   不得走 Functions。
2. **`/sw.js` 的缓存头**：需确保浏览器能定期拿到新版 SW 脚本（见门禁 5）。
3. SW 作用域为 `/`（本项目部署在根路径，默认成立）。

### → «备份与导出策略»（#15）

1. **本地队列与本地模板不在备份范围内** —— 备份 / 导出只覆盖服务端数据；
   设备侧数据（IndexedDB）丢了**不可恢复**。导出说明里必须写明。
2. 导出若被用于「迁移到新设备」，**未同步的队列项会丢失** ⇒ 说明里需提示**先同步再导出**。
3. `entry.client_ref` 只是幂等键，**不构成备份的必需项**（丢了不影响数据可用性）。

---

## 12. 未决缝与已知局限（明确不闭合）

1. **离线录入依赖设备时钟** —— `biz_date` 由设备算，服务端 CHECK 只保证它与 `occurred_at` 自洽（§4.4）。
2. **离线期间跨设备不可见** —— A 设备离线记的账，B 设备看不到（尚未同步）⇒ 理论上可能重复记账。
   不做规避（要规避就得引入跨设备实时通道，成本远超收益）。
3. **本地模板不进备份**，换设备或清数据即丢失。
4. **写入面只覆盖 Entry 新增**，其余一律在线（§8.2）。
5. **预校验与写入的竞态窗口**（§5.2），2 人自用可忽略。
6. **Safari 的 LRU 驱逐** —— 配额（单 origin ≤60% 磁盘）对本项目远未触及，
   但「本地数据永不丢失」**不作为假设**；队列中的未同步项是唯一不可重建的东西。
7. **WebKit bug 247242 未修复** ⇒ 金额解析同时接受 `.` 与 `,`（§9.2）。
8. **离线项的「用户何时录的」不可得** —— `created_at` 口径统一为服务端接收时刻的代价（§4.3）。

---

## 13. 一手事实与实测

### 13.1 平台事实（Apple / WebKit / MDN 官方，采集 2026-09-16）

| 事实 | 来源 |
|---|---|
| **Safari 完全不支持 Background Sync，也不支持 Periodic Sync**（`safari: false`）；规范本身仅为 WICG 社区组报告、不在 W3C 标准轨道；WebKit 只有 2018-02 提交、**至今 NEW** 的特性请求 | MDN BCD `api/SyncManager.json`；`wicg.github.io/background-sync/spec/`；`bugs.webkit.org/182565` |
| **ITP 7 天清除涵盖 `Service Worker registrations and cache`**；Home Screen web app 第一方域名**明文豁免**，**前提是 `display` 为 `standalone`/`fullscreen`** | `webkit.org/blog/10218`；`webkit.org/tracking-prevention/`；`bugs.webkit.org/232302` |
| Safari 存储配额 = 单 origin ≤60% 磁盘、overall ≤80%，LRU 驱逐；standalone web app 与 Safari **同待遇** | `webkit.org/blog/14403` |
| `navigator.storage.persist()` 自 Safari 15.2 可用、**不弹框**、按启发式批准；**未找到「添加到主屏幕即自动持久化」的官方说法** | MDN BCD `api/StorageManager.json`；MDN Storage quotas |
| 无条件 `skipWaiting()` *"may be a bad idea"*；官方推荐 `workbox-window` 的 `waiting` → `messageSkipWaiting` → `controlling` → reload | `developer.chrome.com/docs/workbox/service-worker-lifecycle`；`…/handling-service-worker-updates` |
| precache manifest 的 `revision` = 构建期内容哈希，**禁止手写** | `developer.chrome.com/docs/workbox/modules/workbox-precaching` |
| `beforeinstallprompt` 在 Safari **不存在**（非标准） | MDN BCD `api/BeforeInstallPromptEvent.json` |
| SW 自 **iOS 11.3** 支持，仅 Safari / SFSafariViewController / Home Screen web app 可用 | `webkit.org/blog/8090` |
| **Web Push 限 iOS 16.4+，且仅限 Home Screen web app** | `webkit.org/blog/13878` |
| iOS 26 起「添加到主屏幕**默认以 web app 打开**」 | `webkit.org/blog/17333`；`support.apple.com` iPhone 使用手册 |
| `inputmode="decimal"` 自 Safari 12.1 / iOS 12.2 支持；`type="number"` **忽略 `pattern`**、`step` 默认 1 | MDN BCD；WHATWG HTML 规范 |
| **WebKit bug 247242（仍 NEW）**：iOS 键盘给 `.` 而输入框可能按区域显示 `,` | `bugs.webkit.org/247242` |
| `crypto.randomUUID()` 自 **Safari / iOS 15.4** 支持，需安全上下文 | MDN BCD `api/Crypto.json`（`"safari": {"version_added": "15.4"}`） |

### 13.2 本机实测（`offline-sync-probe.py`，SQLite 3.53.1，**非 D1**）

九节：结构盘点（15 表 / 18 触发器 / 12 显式索引）· ALTER 的两处限制 + CHECK 对既有行的行为 ·
`client_ref` 语义（NULL 共存 / 非空闸 / 幂等 / 不覆盖）· 全链路重放（含对象不翻倍）·
`INSERT OR IGNORE` 与 `RAISE(ABORT)` 的交互 · 整批重放为何必须预校验（E1 实测整批回滚）·
重放的数据访问路径（三条判据）· 索引用途核对 · D1 侧待复核。

### 13.3 D1 侧待复核（必须在 D1 上复跑）

1. `SELECT sqlite_version()` —— 本机 3.53.1 不是 D1 的版本（#14 / #9 均标注此项未核实）。
2. **`ALTER TABLE … ADD COLUMN` 在 D1 的迁移流程里可用**（D1 用 SQLite 的 ALTER 子集，官方未列白名单）
   ⇒ 若不可用，退路是「建新表 + 拷数据 + 改名」三步迁移。
3. **`json_each()` 表值函数在 D1 可用**（官方只笼统写「支持 JSON 函数」，未逐一点名）
   ⇒ 若不可用，退路是客户端把每个对象标签摊成一条 INSERT，放进同一个 `batch()`。
4. **`batch()` 的原子性与 `ON CONFLICT … DO NOTHING` 的组合** —— #14 已把该项列为待复核，本票沿用。
   探针 §六 用事务模拟了 batch 的原子性，**D1 上必须复跑确认**。

### 13.4 本票自查纠正一处

**探针最初版本误用了 `EXPLAIN QUERY PLAN`** —— 把它用在 `INSERT` 语句上，期望得到数据访问路径。
实测（本机 SQLite 3.53.1）证明它对 `INSERT` 报告的是**该表身上的外键动作程序**，与语句本身无关：

| 语句 | 返回 |
|---|---|
| `INSERT INTO member` | 6 行，全是「引用 member 的那些子表」的索引查找 |
| `INSERT INTO entry` | 1 行：`SEARCH entry_object`（唯一引用 entry 的表） |
| `INSERT INTO entry_object` | **0 行**（没有任何表引用它） |

后果：那条「不得全扫」的断言**是空的**。已改写为三条可靠判据
（删索引即无法编译 / SELECT 形态走索引 / 字节码里的 `OP_IdxInsert` 计数）。
**教训：工具的返回值不等于证据，要看它回答的是不是自己问的问题。**
