# 家庭记账 (Family Ledger)

基于 [Cent](https://github.com/glink25/Cent) 理念的家庭共享**纯支出记账** Web PWA:数据完全自持,以 JSON 纯文本存放在你自己的 GitHub 私有仓库中,部署于 Cloudflare。

## 核心理念

- **数据自持**:账本即一个 GitHub 私有仓库,JSON 纯文本,git 历史即备份与回滚
- **家人友好**:家人无需 GitHub 账号,管理员创建成员账户,打开网页输入用户名密码即用
- **离线优先**:PWA + 本地缓存,离线可记账,联网增量同步
- **只记支出**:不做收入与资产模型,录入路径最短

## 功能

- **记一笔**:金额 + 两级分类两步记完;日期、备注、标签、经手人(可代家人记)可选
- **明细**:按月浏览、按日分组小计、分类/成员/标签/关键词筛选,成员改删自己的、管理员全权
- **统计**:支出趋势、分类占比(父/子级)、成员对比,本月/近三月/近一年
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

- Pages 项目:`family-ledger`,生产地址 <https://family-ledger-7ra.pages.dev>
- 账本数据仓库:`Silencehuliang/family-ledger-data`(私有,JSON 纯文本)
- 本地部署:`pnpm deploy`(需 `wrangler login`)
- CI 自动部署:在 GitHub 仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 后,push 到 main 即自动部署(未配置时该任务自动跳过)
- 运行时环境变量(Cloudflare 项目设置或 `wrangler pages secret put` 配置):
  - `GITHUB_TOKEN`:访问账本仓库的凭据(推荐 fine-grained PAT,仅授权账本仓库 Contents 读写)
  - `GITHUB_REPO`:账本仓库,格式 `owner/repo`
  - `JWT_SECRET`:会话签名密钥

## 状态

✅ v1 完成:全部功能已上线并通过真实环境端到端验收(初始化向导 → 记账 → GitHub 仓库落 JSON → 跨端同步)。工单见 [Issues](https://github.com/Silencehuliang/FamilyAssetManagement/issues)。
