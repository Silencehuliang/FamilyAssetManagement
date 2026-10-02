# 家庭记账 (Family Ledger)

基于 [Cent](https://github.com/glink25/Cent) 理念的家庭共享**纯支出记账** Web PWA:数据完全自持,以 JSON 纯文本存放在你自己的 GitHub 私有仓库中,部署于 Cloudflare。

## 核心理念

- **数据自持**:账本即一个 GitHub 私有仓库,JSON 纯文本,git 历史即备份与回滚
- **家人友好**:家人无需 GitHub 账号,管理员创建成员账户,打开网页输入用户名密码即用
- **离线优先**:PWA + 本地缓存,离线可记账,联网增量同步
- **只记支出**:不做收入与资产模型,录入路径最短

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
- 本地部署:`pnpm deploy`(需 `wrangler login`)
- CI 自动部署:在 GitHub 仓库 Secrets 配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 后,push 到 main 即自动部署(未配置时该任务自动跳过)
- 运行时环境变量(T3 起需要,在 Cloudflare 项目设置或 `wrangler pages secret put` 配置):
  - `GITHUB_TOKEN`:fine-grained PAT,仅授权账本仓库的 Contents 读写
  - `GITHUB_REPO`:账本仓库,格式 `owner/repo`
  - `JWT_SECRET`:会话签名密钥

## 状态

🚧 开发中。当前进度见 [Issues](https://github.com/Silencehuliang/FamilyAssetManagement/issues)。
