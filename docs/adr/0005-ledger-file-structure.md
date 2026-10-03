# 账本仓库文件结构定稿

Status: accepted

承接 ADR-0004 的框架决策,把账本仓库的具体文件结构定下来(首个设备落账后即难变更):

```text
ledger/months/2026-10.json   {"expenses": [...]}        按自然月的支出文件
ledger/meta/members.json     {"members": [...]}         成员即账户;含凭据字段
ledger/meta/categories.json  {"categories": [...]}      两级分类(父分类带颜色)
ledger/meta/tags.json        {"tags": [{"id","name"}]}  标签实体(ADR-0006)
ledger/meta/tagGroups.json   {"groups": [...]}          标签组:颜色与单选/必选规则(ADR-0006)
ledger/meta/budgets.json     {"budgets": {"2026-10": {...}}}  月度预算(总+分类)
ledger/meta/recurring.json   {"recurring": [...]}       周期支出规则
```

- 金额一律为**整数分**(amountCents,正数);日期为 `YYYY-MM-DD`、月份为 `YYYY-MM` 字符串
- 支出记录同时携带 `memberId`(经手人)与 `recordedBy`(记录者),代记场景二者不同,二者皆有编辑权
- JSON 用 2 空格缩进、结尾换行,保持人类可读、git diff 友好
- **标签为实体**(ADR-0006):支出存 `tagIds`,标签与标签组各占一个 meta 文件;`tagNames` 已废弃
- 领域类型的 `Member` 不含凭据;存储层以 `MemberRecord = Member & { passwordHash, passwordSalt }` 表示;凭据格式定为 `pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>`,盐 ≥16 字节,迭代数 ≥100_000(鉴权层实现)
- **members.json 由服务端专属管理(不进入客户端同步文件集)**:凭据永不过代理;客户端经 `GET /api/members` 获取去凭据的成员列表填充本地视图(安全评审决策,防离线爆破)
- 文件路径与内存账本切片( `months[m]`、`meta.*` )的映射在同步层实现;同步仍以文件为增量单位、记录级 LWW(ADR-0004)
