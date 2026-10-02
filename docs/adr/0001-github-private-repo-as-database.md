# GitHub 私有仓库即数据库

Status: accepted

家庭账本需要零成本、数据完全自持、天然版本历史的存储。我们采纳 Cent 项目的核心理念:账本数据以 JSON 纯文本文件存放在用户自己的 GitHub 私有仓库中,git 历史即备份与回滚手段,应用自身不持有任何数据库。

## Considered Options

- **Cloudflare D1 + Workers 作后端**:国内访问更稳,但数据沉淀在 Cloudflare,偏离「数据自持」理念,且引入数据库运维心智。
- **纯本地 IndexedDB 无同步**:实现最简,但无法多设备与家人共享,换设备即丢数据。
- **GitHub 仓库(选定)**:数据可读可导出可回滚,协作与版本免费;代价是依赖 GitHub API 可用性。

## Consequences

- 同步端点做成抽象接口,v1 只实现 GitHub 端点(经 ADR-0002 的代理),未来可加 WebDAV/直连 Token 端点而不动领域层。
- 应用可用性与 GitHub API 可用性绑定;离线缓存是必须品而非增强。
