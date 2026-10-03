# 家庭记账 (Family Ledger)

基于 [Cent](https://github.com/glink25/Cent) 理念的家庭共享**纯支出记账** Web PWA:数据完全自持,以 JSON 纯文本存放在你自己的 GitHub 私有仓库中,部署于 Cloudflare。

## 核心理念

- **数据自持**:账本即一个 GitHub 私有仓库,JSON 纯文本,git 历史即备份与回滚
- **家人友好**:家人无需 GitHub 账号,管理员创建成员账户,打开网页输入用户名密码即用
- **离线优先**:PWA + 本地缓存,离线可记账,联网增量同步
- **只记支出**:不做收入与资产模型,录入路径最短

## 功能

- **记一笔**:全屏计算器键盘编辑器(公式、光标、再记连记);金额 + 两级分类,日期、备注、标签组点选、经手人(可代家人记)可选
- **标签**:标签实体 + 标签组(颜色、单选、必选),v1 自由标签自动迁移,删除标签自动清理引用
- **明细**:按月浏览、按日分组小计;标签按组折叠筛选(包含/排除)与分类/成员/关键词自由组合;行内标签 chips 按组色着色
- **统计**:ECharts 平滑折线趋势、55% 环形占比(分类父/子、标签组两个维度,可点选下钻)、成员对比与标签明细表
- **分类**:管理员就地「加子类/改名/删除」、长按拖拽排序、父分类配色(子分类继承),删除有支出的分类行内迁移
- **预算**:月度总预算 + 子分类预算,余量与超支提示,历史达成
- **周期支出**:房租订阅等按月/周/日/年自动补记(确定性 id,删掉不会被复活)
- **家庭**:管理员初始化后创建成员账户;数据全家透明;停用成员立即失效
- **离线优先**:IndexedDB 本地账本 + 持久化离线队列,联网自动增量同步(LWW 合并)
- **PWA**:可安装到主屏,深色模式跟随系统

## 文档

- [领域词汇表](./CONTEXT.md)
- [架构决策记录](./docs/adr/)

## 开发

```bash
pnpm install
pnpm dev        # 前端开发服务器
pnpm preview    # 构建 + wrangler pages dev(含 Pages Functions)
pnpm test       # Vitest
pnpm lint       # Biome 检查
pnpm typecheck  # TypeScript
```

## 部署(Cloudflare Pages)

- Pages 项目:`family-ledger`
- **生产地址(自定义域)**:<https://ledger.silencehl.eu.org>(备用:<https://family-ledger-7ra.pages.dev>)
- 账本数据仓库:`Silencehuliang/family-ledger-data`(私有,JSON 纯文本)
- 本地部署:`pnpm deploy`(需 `wrangler login`)
- CI 自动部署:在 GitHub 仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 后,push 到 main 即自动部署(未配置时该任务自动跳过)
- 运行时环境变量(Cloudflare 项目设置或 `wrangler pages secret put` 配置):
  - `GITHUB_TOKEN`:访问账本仓库的凭据(推荐 fine-grained PAT,仅授权账本仓库 Contents 读写)
  - `GITHUB_REPO`:账本仓库,格式 `owner/repo`
  - `JWT_SECRET`:会话签名密钥

## 版本与发布

- 版本封顶时:在最后一个功能提交上打**注解 tag**(`vX.Y.Z`)并发布 GitHub Release(标题 `家庭记账 vX.Y.Z`,说明含功能清单/部署地址/测试与验收结论)
- 当前版本:[v1.1.0](https://github.com/Silencehuliang/FamilyAssetManagement/releases/tag/v1.1.0)(封顶提交 `45eed3f`)
- 生产部署始终跟随 main 最新构建;Release 只标记版本节点,不含二进制产物

## 状态

✅ v1.1.0 已发布:完整记账应用 + 全面对齐 Cent 的交互与视觉(标签体系/计算器键盘编辑器/分类拖拽/首页/ECharts 统计),生产环境(自有域名)端到端验收通过。工单见 [Issues](https://github.com/Silencehuliang/FamilyAssetManagement/issues)。
