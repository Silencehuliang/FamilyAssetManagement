# 标签实体化:tagIds 引用 + 确定性迁移

Status: accepted

v1 的标签是支出上的字符串数组(`tagNames`),无法安全地改名、删除或合并(字符串一改,历史数据即失联);而 Cent 的标签精髓是「标签组 + 颜色 + 编辑器内管理」的实体体系。我们决定把标签升级为实体:

- `ledger/meta/tags.json`:`{"tags": [{"id","name"}]}` —— 标签实体,id 为 `tag-<sha256(name) 前 8 字节 hex>`,由名字确定性派生
- `ledger/meta/tagGroups.json`:`{"groups": [{"id","name","color","tagIds","singleSelect?","required?"}]}` —— 标签组,含颜色与单选/必选规则
- 支出改存 `tagIds: string[]`;`tagNames` 字段废弃

**迁移**:首次启动(任一设备)扫描全部支出的 `tagNames`,按名字派生 id 建实体、改写为 `tagIds`,并移除 `tagNames`。确定性 id 保证多设备各自迁移后再经 LWW 合并仍收敛到同一批标签。迁移幂等,可安全重放。

## Considered Options

- **保留字符串关联**:免迁移,但改名=全量改写、删除易漏(PWA 设备离线时的改写会被 LWW 覆盖回旧值),且无法表达组颜色之外的标签元数据。
- **个人标签组(Cent 原样)**:Cent 把组放在个人元数据里;本应用是共享账本,全家应看到同一套组,故组为共享元数据。

## Consequences

- 不受 ADR-0005 旧文件结构约束:新增两个 meta 文件,需在 0005 补记。
- 不做 Cent 的悬挂引用行为:删除标签时由领域层从所有支出与所有组中清理该 id;删除组只解散分组,不删标签。
- 分类颜色(Category.color)同批引入,与标签组颜色共用同一调色板词汇。
