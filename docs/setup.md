# 安装与配置

[返回项目介绍](../README.md)。本指南包含部署、本地运行、自定义订阅源与设备配置。

**当前实现使用空 D1 库，不迁移旧 DO 数据。** 首次部署必须先按[后端资源配置与建表](backend-architecture.md#首次部署)完成 D1、KV、Queue 和 R2 配置；下列网页构建流程不能替代这一步。

## Fork 部署到 Cloudflare Workers

**推荐使用此流程**。先 Fork 项目，再连接 Cloudflare Workers Builds，后续可以在 GitHub 通过 **Sync fork → Update branch** 更新。连接构建可在网页完成；初始化 D1 需使用 Wrangler。

需要 GitHub 账号，以及可使用 Workers、D1、KV、Queues、Durable Objects 和 R2 的 Cloudflare 账号。

### 1. Fork 仓库

点击 [Fork 本项目](https://github.com/ltaoo/findrss-worker/fork)，将仓库 Fork 到自己的账号，保留默认的 `master` 分支。后续 Cloudflare 应连接你账号下的这个 Fork 仓库。

### 2. 准备 Worker、后台密码和存储

1. 在 Cloudflare 打开 **Workers & Pages → Create application**，通过 Hello World 创建一个 Worker，名称填写 `findrss-worker`，先完成初始部署。
2. 进入该 Worker 的 **Settings → Variables and Secrets → Add**，类型选择 **Secret**，名称填写 `ADMIN_PASSWORD`，值设置为自行生成的随机长密码，保存并部署。这是 FindRSS 后台的登录密码。[Cloudflare Secrets 说明](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)
3. 在 Cloudflare **R2 Object Storage** 中启用 R2，并创建名为 `findrss-storage` 的桶；已有该桶时可直接使用。部署会按 `wrangler.jsonc` 绑定此桶，并创建 WebSocket Durable Object。另按[后端资源步骤](backend-architecture.md#首次部署)创建 D1、KV、Queue，填入 ID 并执行远程建表。

Worker 名称必须与仓库 `wrangler.jsonc` 中的 `name` 和 `APPLICATION_SERVICE.service` 一致，R2 桶名必须与 `r2_buckets` 中的 `bucket_name` 一致。上面的默认名称可以直接使用原配置；若要自定义，请在自己的 Fork 中同步修改配置后再连接构建。旧 DO 版本不能直接无损升级到本实现；此版本不会读取旧 DO 数据。

`ADMIN_PASSWORD` 应配置在 Worker 的 **Variables and Secrets** 中；**Builds** 中的变量只供构建过程使用，不会自动成为 Worker 的运行时密钥。[Cloudflare 构建配置说明](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings)

### 3. 连接 Fork 仓库并部署

打开刚才创建的 Worker，进入 **Settings → Builds → Connect**，授权 GitHub，选择**你账号下的 Fork 仓库**，按以下设置连接：[Cloudflare Git 部署说明](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)

| 设置 | 填写内容 |
| --- | --- |
| Production branch | `master` |
| Root directory | 仓库根目录 `/` |
| Build command | 留空，部署命令已包含构建 |
| Deploy command | `npm run deploy` |
| 构建环境变量 | `NODE_VERSION=22.19.0` |

Cloudflare 会根据锁文件安装依赖，`npm run deploy` 会先构建后台和订阅广场，再部署 Worker。保持自动构建开启；如果连接后尚未启动构建，可在 Builds 中运行一次构建，或在仓库提交一次修改来触发。

**如果部署报错 `assets.directory` 指向的 `dist/assets` 不存在**：这个目录由构建生成，不随 Git 仓库提交。进入 **Settings → Builds** 检查并保存上表中的命令，尤其是将 `npx wrangler deploy` 改为 `npm run deploy`，再重新运行构建。更新 Fork 代码不会修改 Cloudflare 中已保存的构建设置。正常日志会先出现 `node scripts/build.js` 和 `FindRSS frontend assets built`，然后才运行 Wrangler 部署；如果已有这两条日志仍然报错，请检查完整日志中的部署命令和工作目录是否与上表一致。

部署成功后打开 Worker 的站点地址，在地址后加 `/admin/`，使用 `ADMIN_PASSWORD` 登录。数据库初始为空；添加自己的规则详见[创建自己的订阅源](#创建自己的订阅源)。自定义域名可在 Worker 的 **Settings → Domains & Routes** 中添加。

后续按下方 [Fork 仓库更新步骤](#fork-仓库更新)更新即可。

## 一键部署到 Cloudflare Workers

这是可选部署方式；推荐优先使用上方的 [Fork 流程](#fork-部署到-cloudflare-workers)，方便通过 GitHub 原生入口同步更新。

<p align="left">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ltaoo/findrss-worker">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare">
  </a>
</p>

点击上方 **Deploy to Cloudflare**，按引导连接 GitHub / GitLab，选择 Cloudflare 账号，设置 Worker 名称和密钥后部署。Cloudflare 会复制项目、配置 Workers Builds，再按[后端部署步骤](backend-architecture.md#首次部署)完成资源 ID 和建表配置。[官方部署说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

部署时必须填写 `ADMIN_PASSWORD`，作为后台登录密码；该密钥没有默认值，请自行设置随机长密码。无需传入 `DEVICE_TOKEN`、`FINDRSS_HOSTNAME` 或 `FEED_HOSTNAME`，域名默认使用当前访问地址。使用项目定义的构建命令 `npm run build` 和部署命令 `npm run deploy`。完成后打开 Worker 域名的 `/admin/`，输入密码登录后导入、发布脚本并添加订阅源；需要连接设备时，在「设备管理 → Device Token」创建凭证。

## 更新已部署的站点

### Fork 仓库更新

1. 打开你自己的 Fork 仓库，切换到连接 Cloudflare 的 `master` 分支。
2. 点击文件列表上方的 **Sync fork → Update branch**，将原项目最新提交同步到自己的仓库。[GitHub 同步说明](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork)
3. Cloudflare 收到分支更新后自动构建、部署；在 Worker 的 Builds 中查看结果。部署成功后自行打开站点检查后台和订阅。

如果仓库已经是最新版本，无需操作。若你修改过 `wrangler.jsonc` 等文件，同步可能产生冲突，需要保留自己的 Worker 名称、R2 桶名和实例配置后合并；也可以使用下方「更新 FindRSS」工作流，由它保留实例配置并同步应用代码。自行修改应用代码的用户应通过 GitHub Pull Request 合并上游更新。

### 使用更新工作流

一键部署创建的是独立仓库，没有 GitHub 的 `Sync fork` 按钮。本项目提供「更新 FindRSS」工作流，支持独立仓库和 Fork 仓库，在 GitHub 网页中点击运行即可同步代码；Cloudflare Builds 负责后续构建、部署，无需在 GitHub 配置 Cloudflare API Token。

1. 在 Cloudflare 中打开 **Workers & Pages → 你的 Worker → Settings → Builds**，找到绑定的 GitHub 仓库，确认自动构建已开启。
2. 打开这个仓库，选择 **Actions → 更新 FindRSS → Run workflow**，使用默认分支上的工作流并点击运行。首次使用时，如果提示 Actions 未启用，先按提示启用。
3. 等待工作流完成。它会获取原项目 `master` 分支的最新代码，保留部署配置，通过依赖安装与构建、部署产物检查后提交更新；没有代码差异时不提交。
4. 打开 Cloudflare 查看本次构建、部署是否成功。GitHub 工作流成功表示代码已更新，线上版本以 Cloudflare 部署结果为准。部署成功后自行打开站点，检查后台和订阅是否正常。

默认更新仓库的默认分支。**如果 Cloudflare 的 Production branch 与默认分支不同**，在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 中添加变量 `FINDRSS_UPDATE_BRANCH`，值填写 Cloudflare 的生产分支名称。工作流文件仍需放在仓库默认分支，才能显示手动运行入口和执行定时任务。

工作流已声明仓库内容写权限；如果提交时报权限错误，请检查仓库或组织的 Actions 策略，在 **Settings → Actions → General → Workflow permissions** 中允许 **Read and write permissions**。如果生产分支要求通过 Pull Request 才能更新，此工作流的直接推送会被拒绝，需要先调整对应分支规则或自行通过 PR 更新。

更新以原项目代码为准，会替换应用文件并删除上游已经移除的文件，不适用于需要保留自行修改应用代码的部署。同步 `wrangler.jsonc` 时保留 Worker 名称、账号、自定义路由、`workers_dev` / `preview_urls`、已有变量、同名 R2/D1/KV 资源和 Queue 名称；Durable Object 绑定保留对外部 Worker 的引用，其余应用配置（包括静态资源路由、兼容日期、别名及 DO 声明）跟随新版更新。Cloudflare 中的 secrets 不由工作流读取或修改。

已有 `.github/workflows/` 文件会保留，上游的新工作流或工作流修改不会自动覆盖它们；以后更新工作流本身时，按下方步骤重新复制对应文件。

### 旧部署补上更新入口

如果 Actions 中找不到「更新 FindRSS」，只需在**原来的部署仓库**添加一次文件：

1. 打开原项目的 [update-findrss.yml](https://github.com/ltaoo/findrss-worker/blob/master/.github/workflows/update-findrss.yml)，复制完整内容。
2. 在你自己的仓库默认分支点击 **Add file → Create new file**，文件名填写 `.github/workflows/update-findrss.yml`。
3. 粘贴内容并提交，然后按上方「使用更新工作流」运行。更新脚本会自动从原项目加载，无需另外复制脚本或操作本地 Git。

继续使用原来的 Worker、仓库和存储资源；不要再次点击 README 的一键部署按钮来升级，以免创建另一套实例。

### 可选：每天自动更新

定时更新默认关闭。在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 添加 Repository variable：

| Name | Value |
| --- | --- |
| `AUTO_UPDATE_FINDRSS` | `true` |

启用后，工作流每天约北京时间 **04:23** 检查并更新，运行时间可能因 GitHub 排队而延后。删除变量或将其改为 `false` 即可关闭，手动更新仍然可用。它会直接跟随原项目 `master` 最新代码；希望自行决定升级时机时，使用手动更新即可。GitHub 可能暂停长期无活动的公开仓库定时工作流，遇到这种情况需在 Actions 中重新启用。

## 本地运行

需要 **Node.js 22.19+** 和 npm。以下命令在本项目根目录执行，所需共享代码、前端资源和示例均包含在本目录中。

安装依赖并创建本地配置：

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写 ADMIN_PASSWORD 后再启动
npm run dev
```

启动命令先启动本地 API Worker，等待服务就绪后准备前端资源；Discover SSR 从这个 Worker 读取目录。开发时 admin 由浏览器原生 ES modules 加载，启动时仅预打包 npm 依赖；修改 `admin/` 下的 JS、CSS 或 HTML 后直接刷新页面，无需重新构建或重启服务。`npm run build` 和部署仍将 admin 打包为生产资源。

资源准备完成后继续使用同一个 Worker 提供页面与 API，按 Ctrl+C 一起停止。首次启动会自动创建静态资源目录；运行时临时文件放在项目 `.wrangler/tmp/runtime`，避免系统临时目录权限导致启动失败。启动错误会直接显示，等待超过 60 秒会报错退出。默认端口为 8787，可通过 `FINDRSS_WORKER_PORT` 修改。打开：

| 地址 | 用途 |
| --- | --- |
| <http://127.0.0.1:8787/> | 订阅广场 |
| <http://127.0.0.1:8787/admin/> | 管理后台 |
| <http://127.0.0.1:8787/health> | 健康检查 |

本地后台用户名为 `admin`，密码使用你在 `.dev.vars` 中填写的 `ADMIN_PASSWORD`，没有默认值。本地配置只用于开发，生产部署时请设置独立的随机长密码。

本地 D1 初始为空。登录后台后，可在「订阅源」中添加外部 RSS / Atom 地址；需要生成自己的订阅源时，先导入并发布采集脚本，再添加对应订阅地址。

手动或定时生成快照时，会同步 RSS / Atom 中的频道图标到订阅源头像；图标内容未变时保留原头像地址。图标缺失或抓取失败时保留已有头像，不影响文章快照更新。

### 常用命令

以下命令在本项目根目录执行：

```bash
npm run build     # 构建后台、广场和共享静态资源
npm test          # 运行测试
npm run dry-run   # 检查部署产物
npm run deploy    # 部署到 Cloudflare
```

构建默认先启动本地 API Worker，等待就绪，再读取目录接口并用 Timeless SSR 生成带内嵌 CSS 和首屏内容的首页；构建结束后关闭该实例。生产构建请通过 `DISCOVERY_API_ORIGIN=https://你的Worker域名` 指定线上目录，此时直接使用指定接口；`FINDRSS_HOSTNAME` 可另指定订阅域名。接口失败会中止构建并保留上次产物，详见 [构建取数说明](../discover/README.md#部署)。

停止本地服务时，在启动终端按 Ctrl+C。

## 创建自己的订阅源

在后台「脚本」的 RSS Tab 新建脚本，填入下面的最小示例：

```js
import { utils } from "@findrss/util";

export const route = {
  path: "/demo/go-blog",
  name: "Go 官方博客",
  example: "/demo/go-blog",
  async handler(ctx) {
    const fetched = await ctx.fetchText("https://go.dev/blog/feed.atom");
    if (fetched.error) return fetched;
    const parsed = utils.feed_items(fetched.data, "https://go.dev/blog/");
    if (parsed.error) return parsed;
    return Result.Ok({
      title: "Go 官方博客",
      link: "https://go.dev/blog/",
      description: "通过爬虫脚本抓取并转换的订阅源",
      items: parsed.data,
    });
  },
};
```

运行 Debug 检查结果，以 `1.0.0` 发布正式版本并启用脚本，然后在「订阅源」添加 `{{hostname}}/rss/demo/go-blog`。同一路由也可通过 `/atom/demo/go-blog` 获取 Atom。

从 [findrss-scripts](https://github.com/ltaoo/findrss-scripts) 复制的脚本会通过 `import { RSSScript, HotRankScript, ClipScript, DetectScript, Result } from "@findrss/core";` 导入基类和 Result，当前沙箱同样支持；全局 `RSSScript`、`Result` 与模块导入指向同一对象，两种写法可混用。

RSS / Atom 默认需要访问 Token，可通过 `?token=`、`Authorization: Bearer` 或 `X-FindRSS-Token` 提供。在启用中的自有订阅源上关闭「需要 token 访问」后，该路由公开。公开性按路由 pathname 判断，忽略 query，并对 RSS / Atom 两种前缀同时生效。

需要 JavaScript 渲染的页面使用 `ctx.puppeteer.navigate(url, options?, evaluate?)`，返回 `Promise<Result>`。省略 `evaluate` 时返回 `{ html }`；提供函数时返回函数在页面内的执行结果。函数不能引用脚本闭包中的变量，使用 `options.args` 传参：

```js
const rendered = await ctx.puppeteer.navigate("https://example.com", {
  viewport: { width: 1440, height: 900 }, selector: "#weather", wait_ms: 1000,
  args: ["#weather"],
}, selector => {
  const node = document.querySelector(selector);
  return { text: node.textContent, color: getComputedStyle(node).color };
});
if (rendered.error) return rendered;
```

`selector` 等待节点可见，`wait_ms` 额外等待 0–10000 毫秒；每次调用创建匿名页面，结束、失败或取消后关闭浏览器会话。不会自动注入 Cookie 或向函数暴露 Worker 环境。Mock 运行可提供 `({ puppeteer: { navigate: async () => ({ html: "<div>示例</div>" }) } })`；真实调用需要 `BROWSER` 绑定。区域剪藏完整内容与样式提取见 [Clip 平台脚本](https://github.com/ltaoo/findrss-scripts/tree/main/clip)；Clip HTML 及后台剪藏快照上限为 8MB，其余普通脚本输出上限为 10MB，检测脚本沿用独立上限。

更多完整示例见 [RSS 脚本](https://github.com/ltaoo/findrss-scripts/blob/main/rss/)、[热榜脚本](https://github.com/ltaoo/findrss-scripts/blob/main/hot/)和[脚本示例说明](https://github.com/ltaoo/findrss-scripts/blob/main/docs/usage.md)。这些文件不会自动导入后台。

## 手动部署与配置

需要可使用 Workers、D1、KV、Queues、Durable Objects 和 R2 的 Cloudflare 账号。部署使用本项目的 [wrangler.jsonc](../wrangler.jsonc)，后台与广场静态资源随 Worker 一起发布。

在本项目根目录执行：

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create findrss-storage
npx wrangler secret put ADMIN_PASSWORD
npm run dry-run
npm run deploy
```

R2 桶只需创建一次，已有同名桶可跳过。`secret put` 命令会提示输入生产密钥，`ADMIN_PASSWORD` 同时是后台登录密码。

| 配置 | 要求 | 用途 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 必需 secret | 后台登录与管理 API 认证 |
| `BROWSER` | Wrangler 已声明的 Browser 绑定 | 为脚本的 `ctx.puppeteer.navigate` 和区域剪藏提供页面渲染能力 |
| `DEVICE_TOKEN` | 可选旧配置 | 自动导入后台 Device Token 列表，保留原设备接入能力 |
| `READER_SESSION_SECRET` | 可选 secret | 中央账号会话签名；未配置时依次回退旧 `DEVICE_TOKEN`、`ADMIN_PASSWORD` |
| `FINDRSS_HOSTNAME` | 可选变量 | 展开 `{{hostname}}`；留空按请求 origin 展开，可指定公开域名 |
| `COOKIE_PUSH_UUID` / `COOKIE_PUSH_KEY` | 可选旧配置 | 首次启动时自动迁移到后台 Cookie 解密设置；新配置请在后台填写 |
| `API_STORAGE` | Wrangler 已声明的 R2 绑定 | 存储头像、公开目录、文章预览及自有订阅 JSON/RSS/Atom 快照 |

页面渲染由脚本显式调用 `ctx.puppeteer.navigate`，使用 `@cloudflare/puppeteer` 与 `BROWSER` 绑定。项目已声明 `browser.binding = "BROWSER"` 和 `nodejs_compat`，无需设置渲染方式开关或 REST API 凭证。本地需要使用 Cloudflare 远程浏览器时，在 `browser` 配置中加入 `"remote": true` 并登录 Wrangler。

需要固定订阅域名时，可自行在 `wrangler.jsonc` 中添加 `vars.FINDRSS_HOSTNAME`。本地开发可在项目根目录的 `.env` 或 `.dev.vars` 中设置 `FINDRSS_HOSTNAME=http://127.0.0.1:8787`，修改后重启 `npm run dev`；兼容旧名称 `FEED_HOSTNAME`，同时设置时优先使用 `FINDRSS_HOSTNAME`。存在 `.dev.vars` 时 Wrangler 不读取 `.env`。未配置时，订阅地址和手动快照刷新使用当前访问地址，脚本的 `ctx.public_origin` 也使用该地址生成图片代理等绝对链接；通过 workers.dev 或自定义域名访问均可。发现页的定时快照刷新沿用最近一次访问的域名，该域名会持久化保存。模型厂商与 API Key 可在后台「大模型设置」中配置。

### 配置 Cookie 解密

登录后台，打开「设置」→「Cookie 解密」，填写与推送端相同的 UUID 和原始密码，点击「保存 Cookie 解密设置」后立即生效，无需配置环境变量。支持 AES-128-CBC 固定 IV 和 AES-256-CBC 兼容模式，两种模式共用这组凭据。

服务端自动派生解密密钥，并使用 `ADMIN_PASSWORD` 派生的 AES-GCM 密钥加密存储；原始密码不保存、不回显。已配置时密码留空可保留原值，更换 UUID 时需要重新填写密码。更换 `ADMIN_PASSWORD` 后，需要重新填写 Cookie 解密密码。已有有效的 `COOKIE_PUSH_UUID` / `COOKIE_PUSH_KEY` 只会在后台尚无配置时导入，后续以后台设置为准。

### 管理 Device Token

登录后台，打开「设置」中的 **Device Token**，或在「设备管理」点击 **Device Token**：

- 可创建多个凭证，填写名称和备注；有效期可选 7 天、30 天、90 天、1 年或永不过期，默认 30 天。
- 创建成功后自动弹窗展示明文，可直接复制；关闭弹窗或离开设置页会清除弹窗中的明文。
- 列表显示掩码、状态、创建时间、到期时间和最近使用时间，支持编辑备注。
- 点击「查看明文」后可复制；可手动隐藏，30 秒后自动隐藏，收起管理面板也会清除已显示的明文。
- 点击「撤销」立即使凭证失效并断开关联设备，到期也会失效。撤销不可恢复；需要时创建新 Token 并更新设备配置。

设备协议保持不变：将创建的 Token 作为 `Authorization: Bearer <token>`，同时提供 `X-Api-Device-ID` 连接 `/v1/connect`。这与 RSS 用户访问 Token 是两类凭证。

Token 使用随机值，服务端保存 SHA-256 摘要用于鉴权，并用 `ADMIN_PASSWORD` 派生的 AES-GCM 密钥保存加密副本，供管理员按需查看；列表不返回明文。撤销时删除加密副本。**更换 `ADMIN_PASSWORD` 后，已有设备 Token 的明文将无法解密，但摘要鉴权仍有效**，可创建新 Token 替换。

升级时，旧 `DEVICE_TOKEN` 会自动导入为「原部署 Device Token」，可在后台撤销，重启不会重新激活它；已有设备连接需重新连接以绑定凭证。若阅读端仍依赖旧 `DEVICE_TOKEN` 签名，移除该环境变量前先将 `READER_SESSION_SECRET` 设置为原值，并在阅读端使用相同密钥，避免旧会话失效。

已有部署升级时，**保留原 Worker 名，或先安排 DO 数据迁移**：修改 Worker 名会创建新的 DO 命名空间，原数据不会自动迁移。部署也不会自动删除旧 Worker 或旧 Pages 项目。

构建入口为 `scripts/build.js`，其他构建与维护工具也集中在 `scripts/`。`npm run build` 从 `public/` 复制公共资源，从 `admin/`、`discover/` 构建前后台业务文件，原子生成 `dist/assets/`；`npm run dev` 使用独立的 `dist/assets.dev/`，避免生产构建覆盖正在使用的开发资源。开发构建保留静态资源根目录、只替换目录内容，确保 Wrangler 的资源监听在首次构建后继续生效。Wrangler 在 dev、deploy 和 dry-run 时直接从 `index.js` 打包主 Worker 与 QuickJS WASM，避免预先打包同一份服务端代码。静态资源来自对应的产物目录；产物由构建生成，不直接编辑。
