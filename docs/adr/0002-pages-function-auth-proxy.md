# Cloudflare Pages Function 薄代理承载鉴权与 GitHub Token

Status: accepted

家人不该被要求拥有 GitHub 账号,GitHub Token 也不应下发到每台设备。我们决定:所有对账本仓库的读写都经 Cloudflare Pages Function 薄代理完成,`GITHUB_TOKEN`、`GITHUB_REPO`、`JWT_SECRET` 存于 Cloudflare 环境变量,永不下发客户端;客户端持有的是登录后签发的 JWT 会话。

应用内账户体系遵循「成员即账户」:账户由管理员创建,加盐密码哈希作为 JSON 存于账本仓库本身;首次打开应用且仓库中无账户数据时进入初始化流程创建管理员。权限模型为「全家透明 + 自我编辑」:所有成员可查看全部数据并修改/删除自己记录的支出,仅管理员可管理成员、分类、预算及删除任何记录。

## Considered Options

- **纯前端直连 GitHub**:零后端,但每台设备都要管理员手动粘贴 Token,Token 可从任意家庭设备提取。
- **Worker + D1 重后端**:真正的用户系统与数据库,对一个家庭自用应用过重。
- **Pages Function 薄代理(选定)**:Functions 与静态页同仓库一次部署,家人只需用户名密码,Token 只存服务端。

## Consequences

- 部署者需在 Cloudflare 配置三个环境变量,账本 GitHub 仓库需手动预先创建(fine-grained Token 仅授权该仓库 Contents 读写)。
- 服务端成为同步与登录的单点;离线时已登录设备仍可凭本地缓存与持久化 JWT 记账,恢复联网后再同步。
