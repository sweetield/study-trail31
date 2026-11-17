# StudyTrail 学习轨迹

面向班级/小组的学习任务管理平台：管理员发布带步骤的学习任务，学员按步骤推进并提交，导师评分点评，全程留痕可追溯。

运行在 [Cloudflare Workers](https://developers.cloudflare.com/workers/) 上，数据存储于 [Cloudflare D1](https://developers.cloudflare.com/d1/)，免费额度即可满足中小规模团队使用。

## 功能概览

**学员端（`/app`）**

- 任务列表：卡片 / 列表视图切换，按状态、技术方向、日期筛选与分组
- 任务详情：逐步勾选步骤、填写进度、提交审核、撤回提交
- 作品附件：上传截图、图片或 7z / tar 压缩包，随任务一起提交审核
- 学习日志：记录每日学习内容与时长，Markdown 工具栏可按需插入图片 / 文件，日志按时间顺序展示，打卡后自动定位到最新一条
- 个人头像：在账号页上传、更换或删除头像，导航栏与列表统一显示
- Markdown 导出：勾选一个或多个任务，导出完整学习进度
- 站内通知：任务发布、审核结果、辅导员答疑等实时提醒

**管理端（`/admin`）**

- 概览看板：完成率、待审核数量、学习时长统计
- 任务管理：创建 / 编辑 / 复制 / 删除任务，可同时发布到多个班级，并按名单搜索、反选，选择排除或只发给勾选学员
- 审核中心：星级评分与点评，查看完整进度与审核历史，可删除不合规作品附件
- 学员与班级：单个或批量导入学员、分班、重置密码、停用账号
- 学习日志管理：查看学员日志与附件，使用内嵌的论坛式编辑面板编辑 / 删除日志，直接回复答疑
- 进度矩阵：学员 × 任务的完成情况一览
- Markdown 导出：按任务、班级或学员导出完整学习进度
- 团队与审计：管理员成员管理，关键操作审计日志
- 数据备份：导出 / 导入文字数据（JSON），或导出包含图片、附件与头像的完整备份（ZIP，仅跳过超过 1 MB 的 7z / tar 压缩包）；重新部署后可按需恢复
- 全体通告：发布后在所有成员界面顶部以滚动横幅展示，更新或关闭后同步生效

**安全与文件存储**

- 密码使用 PBKDF2 加盐哈希，会话令牌仅以哈希形式存储
- HttpOnly + Secure Cookie，CSRF 校验，连续登录失败自动锁定
- 所有上传文件（日志附件、作品文件、头像）统一使用 AES-256-GCM 加密保存
- 文件内容使用部署时绑定的 R2 或 KV：系统自动使用实际绑定的一种，不支持在初始化或后台切换
- 每日定时清理过期会话、旧通知、审计日志与未绑定的草稿附件

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、React Router、SWR、Tailwind CSS 4 |
| 后端 | Hono（运行于 Cloudflare Workers） |
| 数据库 | Cloudflare D1（SQLite） |
| 构建 | Vite + [@cloudflare/vite-plugin](https://developers.cloudflare.com/workers/vite-plugin/) |

## 目录结构

```
├── migrations/        数据库迁移 SQL（按文件名顺序自动执行）
├── src/               前端（页面、组件、hooks）
├── worker/            后端 API
│   ├── routes/        各业务路由
│   └── lib/           会话、加密、校验、自动迁移等
└── wrangler.jsonc     Workers 配置（不含任何账号 ID 或密钥）
```

## 部署

仓库中**没有**任何需要按环境修改的内容（账号 ID、密钥等），资源名称已固定，部署时可以直接复用旧资源：

- **固定 D1 名称**：数据库固定为 `study-trail-db`。首次部署时 Cloudflare 会[自动创建并绑定](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)，之后重新部署或重新创建 Worker 都会优先复用同名的旧数据库。
- **固定 R2 名称**：默认使用 R2，存储桶固定为 `study-trail-files`，用于保存加密后的附件与头像；同名旧存储桶会被复用。
- **文件存储 R2 / KV 二选一**：`wrangler.jsonc` 默认同时声明 R2（`FILES`）与 KV（`FILE_KV`），用于兼容旧部署。系统启动后自动使用实际绑定的一种存储，不会同时写入两种，也不在初始化或后台提供切换。
- **表结构自动迁移**：Worker 收到首个请求时会自动执行 `migrations/` 中尚未执行的 SQL，部署流程中无需任何迁移步骤。
- **无需配置环境变量或密钥**：文件加密密钥会在首次上传时自动生成并保存到 D1；同一数据库的多个实例共享同一密钥。

> Deploy Button 的部署配置页允许修改 D1 / R2 的资源名称，请保持默认的 `study-trail-db`、`study-trail-files` 才能复用旧数据。KV 没有配置文件中的固定名称字段，自动创建时标题为 `study-trail-file-kv`；若要复用旧 KV，可在部署配置页选择已有命名空间，或把旧命名空间的 id 填入 `wrangler.jsonc`。

> 文件存储由部署时实际绑定的资源决定，系统不会在 R2 与 KV 之间做运行时选择。默认模板同时声明两种绑定以兼容旧部署；如果同时存在，会沿用旧部署保存的选择或默认使用 R2，建议在部署配置中只保留实际需要的一种。

### 使用 R2 或 KV

- **默认 / 使用 R2**：保持 `wrangler.jsonc` 中的 `r2_buckets`。需要只保留一种时，删除 `kv_namespaces` 整项。
- **使用 KV**：删除 `r2_buckets` 整项，保留 `kv_namespaces`；如果 KV 命名空间已经存在，把它的 id 填入 `kv_namespaces[0].id`，然后重新部署。
- 系统启动时会自动识别实际绑定的存储，不提供初始化或后台切换。已有附件或头像后不要更换存储绑定，否则旧文件将无法读取。
- 需要强制指定后端时，可在 `wrangler.jsonc` 的 `vars` 中设置 `"FILE_STORAGE": "r2"` 或 `"FILE_STORAGE": "kv"`。
- KV 单个 value 上限为 25 MiB，文件本身仍限制在 20 MB 以内；文件较多或较大时建议使用 R2。

如需固定加密密钥（例如多环境共享），可在 `wrangler.jsonc` 的 `vars` 中设置 `FILE_ENCRYPTION_KEY`，支持 Base64、64 位十六进制或 32 字符原始密钥。更换密钥会导致旧文件无法解密，请谨慎操作。

### 存储配额

管理端「存储用量」页会显示服务器容量、已用与剩余空间，并按学员列出占用情况。默认限制：

- 附件支持 JPG、PNG、GIF、WebP、BMP、AVIF 图片与 7z / tar 压缩包（可上传分卷）。
- 单个附件 **20 MB**；头像 **2 MB**。
- 单条日志 / 任务 / 留言 / 审核的附件合计 **100 MB**。
- 每个学员名下的附件与头像合计 **512 MB**。

可在 `wrangler.jsonc` 的 `vars` 中按需调整（单位 MB）：

```jsonc
"vars": {
  "STORAGE_TOTAL_MB": "10240",
  "STORAGE_SCOPE_MB": "100",
  "STORAGE_STUDENT_MB": "512"
}
```

`STORAGE_TOTAL_MB` 只影响「存储用量」页的容量展示口径（默认 R2 10 GB、KV 1 GB），不会阻止上传；实际用量以 Cloudflare 控制台为准。单作用域与学员配额会在上传或绑定附件时强制校验。

### 准备

1. 注册 Cloudflare 账号：[dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
2. 将本仓库放到你自己的 GitHub / GitLab 账号下（Fork 或推送副本均可）

### 方式一：连接 Git 仓库自动部署（推荐）

推送到主分支即自动部署，不需要在本地安装任何工具。

1. 打开 [Workers 和 Pages → 创建应用](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)，选择 **导入存储库（Import a repository）**
2. 首次使用需授权 GitHub / GitLab 访问，然后选择本仓库
3. 填写构建设置：

   | 设置项 | 值 |
   | --- | --- |
   | 项目名称 | `study-trail`（必须与 `wrangler.jsonc` 中的 `name` 一致） |
   | 构建命令 | `pnpm run build` |
   | 部署命令 | `npx wrangler deploy` |
   | 根目录 | `/`（保持默认） |

4. 点击 **部署**，等待构建完成
5. 部署成功后访问 `https://study-trail.<你的子域>.workers.dev`

之后每次推送到主分支都会自动重新部署。构建记录可在 Worker 的 **部署（Deployments）** 页查看，详见 [Workers Builds 文档](https://developers.cloudflare.com/workers/ci-cd/builds/)。

### 方式二：一键部署按钮

> 仅适用于**公开**仓库；私有仓库请使用方式一。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MyPrivateShare/StudyTrail)

点击后按页面提示登录 Cloudflare 并授权 GitHub，Cloudflare 会把仓库复制到你的账号、按 `wrangler.jsonc` 自动创建（或复用同名的）D1、R2、KV 并完成部署，同时自动配置好后续的推送部署。

- 如果账号中已经存在 `study-trail-db`、`study-trail-files`，会直接沿用旧资源，不会新建空数据库 / 空存储桶。
- 默认模板会创建 R2 与 KV 两种绑定；系统会自动使用实际需要的一种（默认为 R2，旧部署沿用原来的选择）。如果只想使用 KV，请按上方说明删除 `r2_buckets` 后重新部署，并在部署配置页选择原来的 KV 命名空间，或把它的 id 填入 `wrangler.jsonc`。
- 部署完成后直接进入初始化页面创建管理员；文件存储由部署时绑定的 R2 或 KV 自动确定，无需在初始化页面选择。

### 方式三：本地命令行部署

需要 [Node.js 20+](https://nodejs.org/zh-cn/download) 与 [pnpm](https://pnpm.io/zh/installation)。

```bash
pnpm install
npx wrangler login     # 浏览器中授权 Cloudflare 账号
pnpm run deploy        # 构建并部署
```

> 首次通过命令行部署时，Wrangler 可能会把新建数据库的 ID 写回本地 `wrangler.jsonc`。该改动**不需要提交**，执行 `git checkout wrangler.jsonc` 还原即可，后续部署会自动沿用已绑定的数据库。
>
> 在 CI 中使用命令行部署时，可用 [API 令牌](https://dash.cloudflare.com/profile/api-tokens)（模板「编辑 Cloudflare Workers」，并追加 D1 编辑权限）代替 `wrangler login`，通过环境变量 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 提供。

### 首次使用

1. 访问部署后的网址，系统检测到尚无管理员时会自动进入 **初始化** 页面（`/setup`）
2. 创建第一个管理员账号；文件存储由部署时绑定的 R2 或 KV 自动确定，无需在此选择
3. 在管理端创建班级、导入学员、发布任务即可开始使用
4. 如果当前系统没有班级、学员或任务，管理端概览页会提示先导入旧备份（见下一节）

### 绑定自定义域名（可选）

进入 [Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → 选择 `study-trail` → **设置 → 域和路由 → 添加 → 自定义域**，输入已托管在 Cloudflare 的域名即可，证书自动签发。详见 [自定义域文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## 更新

- **方式一 / 方式二**：拉取上游更新并推送到主分支，自动部署。
- **方式三**：`git pull` 后再次执行 `pnpm run deploy`。

新版本若包含数据库变更，部署后会在首个请求时自动迁移，数据完整保留。

### 从旧版本升级 / 数据库结构变化

如果新版本的数据库结构与旧数据不兼容，或部署后系统看起来是空的，请按下面步骤把旧数据迁回来：

1. **升级前**：在旧系统的管理端 **数据备份** 页导出一份文字备份（JSON，v5），或导出完整备份（ZIP，v6，含图片、附件与头像；仅跳过超过 1 MB 的 7z / tar 压缩包）。文字备份包含班级、账号、任务详情、发布范围、任务优先级与发布人、学习进度、步骤打卡、学习日志、留言层级、审核历史、任务督促、站内通知、操作日志与系统设置（含通告）。
2. **部署新版**：正常部署即可，表结构会在首个请求时自动迁移。
3. **恢复数据**：如果初始化后概览页出现「需要恢复旧数据？」提示，或数据为空，进入管理端 **数据备份** 页导入第 1 步的备份。JSON 文字备份和 ZIP 完整备份均可恢复文字数据；ZIP 完整备份还会一起恢复图片、附件与头像（超过 1 MB 的 7z / tar 压缩包除外）；恢复会覆盖当前数据，并要求使用备份中的管理员账号重新登录。
4. **附件与头像**：JSON 文字备份不包含图片 / 文件内容。如果仍使用原来的 R2 或 KV，附件和头像会继续可用；如果换了存储资源，请导入完整备份 ZIP，或另行迁移 R2 / KV 中的对象。恢复附件时会沿用当前部署绑定的存储后端；超过 1 MB 的 7z / tar 压缩包不会打包进完整备份，需重新上传或单独迁移，小于 1 MB 的小压缩包会随备份保留。

导入旧备份后，新增的任务优先级、发布人、留言层级、站内通知、任务督促、操作日志与系统设置会从备份中恢复；旧版本没有的字段会使用数据库默认值。

### 重新部署会丢数据吗？

正常升级代码、重新部署**不会**丢失数据：D1 数据库和 R2 存储桶是独立于 Worker 代码的持久化资源，只要部署仍绑定同一套资源，账号、任务、进度、日志都会保留。`migrations/` 中的迁移也只做新增表 / 字段，不会清空已有数据。

以下操作才可能造成数据丢失，需要特别注意：

- 删除 Worker、D1 数据库或 R2 存储桶后重新创建；
- 换用另一个 Cloudflare 账号 / 另一个项目重新部署，自动创建了新的 D1 / R2；
- 手动改写 `wrangler.jsonc` 中的 `database_id` / `bucket_name`，指向了空数据库或空存储桶；
- 直接在数据库中执行 `DROP TABLE`、`DELETE` 等破坏性操作。

升级或大改数据库结构前，建议先在管理端 **数据备份** 页导出一份 JSON 备份或完整备份 ZIP。JSON 备份覆盖账号、班级、任务详情、发布范围、任务优先级与发布人、学习进度、步骤打卡、学习日志、留言层级、审核历史、任务督促、站内通知、操作日志与系统设置（含通告、文件加密密钥等）；**附件与头像的二进制内容不在 JSON 中**，如需保留图片 / 文件与头像，请导出完整备份 ZIP（仅跳过超过 1 MB 的 7z / tar 压缩包），或另外备份 R2 / KV，或使用 D1 的 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 配合 R2 数据保留策略。

## 运维

| 事项 | 入口 |
| --- | --- |
| 实时日志 | [Workers 和 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → `study-trail` → **日志** |
| 数据库查询 | [D1 控制台](https://dash.cloudflare.com/?to=/:account/workers/d1) → 选择数据库 → **控制台** |
| 数据备份 | 管理端 **数据备份** 页导出文字备份（JSON），或导出完整备份（ZIP，含图片、附件与头像，仅跳过超过 1 MB 的 7z / tar 压缩包）。D1 还可使用 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 恢复到 30 天内任意时间点 |
| 定时任务 | 每天北京时间 03:00 清理过期数据，可在 `wrangler.jsonc` 的 `triggers` 中调整 |

## 本地开发

```bash
pnpm install
pnpm dev               # http://localhost:3000
```

本地开发使用 Wrangler 模拟的 D1 数据库（存放于 `.wrangler/`），首次启动自动建表，无需登录 Cloudflare。

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 构建前端与 Worker |
| `pnpm preview` | 本地预览构建产物 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm cf-typegen` | 根据配置生成 Workers 类型 |

### 修改数据库结构

在 `migrations/` 中新增按序号命名的 SQL 文件（如 `0004_xxx.sql`），本地重启开发服务器、线上部署后都会自动执行。已发布的迁移文件不要再修改。
