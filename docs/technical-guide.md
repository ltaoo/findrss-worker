# FindRSS Worker 技术指南

**当前版本使用空 D1 库，不迁移旧 DO 数据。** 部署前请完成[资源创建与建表](backend-architecture.md#首次部署)。

项目介绍、截图与快速开始见 [Worker README](../README.md)。

一个 Cloudflare Worker 提供共享 API，admin、discover 和 rank 各自保留独立前端入口与页面，由统一前端构建处理。

`/rank/` 的页面与静态资源由 `rank.js` 分发。Worker `scheduled` 每 5 分钟将 Hot 后台任务写入 D1 并投递 Queue，由现有 `ServiceBackgroundTasks` 异步调用 `rank/loader.js`，在 QuickJS 沙箱中并发运行仓库 Hot 示例的第一条路由 example，逐脚本写入 R2 `rank/scripts/<脚本名>.json`。JSON 保存完成后，`rank/home.js` 读取并校验这些快照，重新生成 gzip 完整 SSR HTML，连同页面版本及样式哈希原子发布到 `rank/index.html`。JSON 读写或 HTML 发布失败时保留旧完整页面，任务记录失败；脚本采集错误仍参与 HTML 生成并显示错误原因。默认访问只读一份 HTML，带筛选条件时只根据页面内嵌数据渲染首屏。缓存按页面版本隔离，新 HTML 发布后不再命中旧版本响应；不执行脚本、不等待上游。浏览器使用相同 Model/View hydration，不提供用户 Cookie 或设备权限。源码清单由 `scripts/sync_hot_scripts.js` 生成，浏览器产物不含采集源码。完整行为与验证见 [rank/README.md](../rank/README.md)。

- admin：`admin/`，后台入口 `/admin/`，使用自己的 HTML、脚本、样式和管理员登录。
- discover：`discover/`，广场入口 `/`，使用自己的 HTML、脚本、样式和 SSR。
- rank：`rank/`，排行榜入口 `/rank/`，使用独立 Model/View、HTML 与样式，后台提前生成 SSR 快照。

`POST /admin/api/hot/snapshot` 支持管理员异步提交 Hot 快照任务，复用后台会话或管理员 Bearer/Basic 鉴权，带 Origin 时拒绝跨站请求。接口经 `/_admin/hot/snapshot` 提交到 应用 Worker 的 `ServiceHotSnapshots`，立即返回 HTTP 202 和 `{ task_id, task }`。同一任务先更新脚本 JSON，再重新生成并发布 rank HTML，第二步完成前保持进行中。手动与定时触发复用同一任务键，进行中时返回同一 ID。任务在 `/admin/tasks` 和 `GET /admin/api/background-tasks` 中展示，复用实时通知、失败记录、租约恢复与取消能力；取消信号传入 QuickJS 以及 JSON、HTML 写入前检查。采集错误、JSON 持久化或 HTML 发布错误均记为任务失败，已保存的快照保留。详情及调用示例见 [排行榜说明](../rank/README.md)。

脚本模块的 `kind` 决定专属访问前缀：`/rss/<path>`、`/atom/<path>` 仅匹配 RSS 脚本；`GET/HEAD /api/hot/<path>` 仅匹配 Hot 脚本并返回 JSON，路径参数与查询参数透传。类型由显式 `export const kind = "rss"` / `"hot"` 声明，兼容顶部标记和基类推断。两类均保留原路径直达和 Debug。Hot 请求复用当前正式版本、配置、访问凭证和 Cookie 授权校验，并使用独立临时缓存；RSS 目录对同路径源的公开设置与积分计费不套用到 Hot 接口，Hot 的匿名访问由自身 `route.public` 决定。

rank 后台采集以示例地址匹配已发布、启用的 Hot 脚本，命中后由 `ServiceScript.execute_hot_snapshot` 调用同一 Hot 执行流程，读取正式源码及配置，验证对应版本 Cookie 授权并强制重新采集；没有匹配时才匿名执行内置示例。草稿和停用版本不参与匹配，授权失败不回退其他源码或授权。管理员确认并发布抖音等脚本后，重新提交 Hot 快照任务或等待定时任务即可更新 JSON 与 HTML 中的旧权限错误。

三套前端分别使用自己的页面外壳和业务状态；admin 与 discover 调用共享 API，rank 在定时任务中调用内置 Hot 示例沙箱，页面请求只读快照。

订阅广场构建时请求公开目录接口并复用 Timeless SSR 生成含首屏内容、内嵌 CSS 和完整目录的 HTML。默认先启动本地 API Worker，等待就绪后再构建，结束后关闭该实例；`DISCOVERY_API_ORIGIN` 指定接口来源时直接使用指定接口，生产构建应指定线上接口，取数失败不覆盖已有产物。运行时继续将目录和文章快照写入 R2。自动抓取引起的目录更新按一分钟窗口合并发布；手动刷新、目录编辑、权限和头像修改立即发布。待发布标记与截止时间持久化，重启后由 Cron 继续处理；首页边缘缓存 60 秒；缺少产物时读取 D1，发布失败持久化标记并由 Cron 重试。搜索/筛选/分页在浏览器完成，客户端通过 hydrate 接管首屏。详见 [广场构建说明](../discover/README.md#部署)与[静态发布说明](../discover/README.md#静态发布与更新)。

自有私密订阅源通过 `discovery_sources.credit_cost` 配置每次成功访问的积分，默认 1，取值为 0 到 1000000000 的整数；新库默认 1。读取 RSS/Atom XML（含缓存命中）在返回前以D1 原子提交更新 token 余额、累计用量并写入账本，余额不足返回 402；账本写入失败会回滚余额。后台生成、管理预览与该源脚本内的设备调用不再重复扣费。公开源免费，外部源不在本 Worker 计费。计价优先匹配路由与归一化 query，忽略域名和 RSS/Atom 格式；未匹配 query 时沿用同路径私密源的配置。

订阅广场卡片直接读取 `discovery_source_snapshots` 中的文章快照，与目录一起返回，不逐源请求 `/api/preview`。Cron + Queue 按源规则更新启用的公开源及私密自有源，最大并发默认 4 个，可在设置中调整为 1 至 16，默认每 1 小时抓取。后台「设置 → 订阅源抓取」配置默认规则，新增或编辑订阅源时可继承默认，或单独选择按间隔、智能刷新、每天指定时间、多个时间点、分时段、自定义五段 Cron、仅手动；定时规则支持 IANA 时区和星期，分时段支持跨午夜，时段外可停止抓取。间隔范围为 5 分钟至 24 小时。智能刷新在有新文章时缩短间隔、无新文章时延长，首次和手动抓取不调整学习结果。规则与上次尝试时间持久化，重启后恢复；错过多个时刻只补抓一次，再计算后续时间。已登记自有源的 XML 与广场预览共用抓取规则，固定 XML 后台调度会跳过这些源。未登记的公开 query 组合沿用 10 分钟后台调度；私密自有源也按规则自动生成 XML，订阅读取仍要求有效凭证；选择仅手动可停止自动抓取。XML 由后台按抓取规则或由管理员手动生成，永久持久化，无过期时间，也不参与普通缓存的容量淘汰。公开及私密订阅的 `/rss`、`/atom` 请求在已有 XML 时直接读取；尚未生成时，首次访问创建后台生成任务，并立即返回 503「订阅源 XML 正在生成，请稍后重试」（`FEED_GENERATING`，`Retry-After: 5`）。相同地址及归一化 query 的 RSS/Atom 并发访问共用一个任务，生成期间均返回正在生成；成功后直接返回 XML，失败后释放任务，下次访问可重试。私密源创建任务前仍需通过鉴权。后台更新失败时继续提供上次成功生成的 XML。下次抓取时间只用于调度，不影响当前 XML 是否可读。私密源仅保存抓取状态与内容指纹，不保存或发布文章预览，外部私密源的快照由上游管理。后台「强制刷新快照」可立即更新单个源，包括仅手动模式。每份快照保存最近 3 篇文章、封面地址及实际宽高，前端按比例占位；图片尺寸读取失败仍保留文章和封面。抓取失败保留上次成功快照，到下一次规则时间再试；编辑源地址、切换 token 访问要求或删除源时清理旧快照。封面尺寸支持 PNG、JPEG、WebP、GIF，其他格式使用默认比例。

XML 快照生成时复用封面处理逻辑，为条目封面、图集图片、Live Photo 静态图及引用图片计算元数据，按 URL 去重、每份快照最多同时下载 4 张。RSS/Atom 共用结果，并将 `width`、`height`、`blurhash` 写入 `media:thumbnail` 和图片 `media:content` 属性；普通订阅读取直接返回保存的 XML，目录预览优先读取这些属性。仅获取尺寸时最多读 64 KiB；计算 BlurHash 时最多读 2 MiB，完整图片不超过 400 万像素才解码，GIF 只读取尺寸。下载或解码失败、格式不支持时省略缺失属性，仍保留图片与订阅内容；已有 XML 在下次成功刷新后补齐这些属性。

自动抓取由每分钟 Cron 查询 D1 调度索引，再向 Queue 投递任务。消费者通过 D1 租约和全局并发数领取任务；失效租约和投递中断由 Cron 恢复，不依赖普通请求触发，也不使用 DO Alarm。错过多个周期只补抓一次，未来计划和仅手动模式保持不变。调低并发不会终止已开始的任务；只修改并发数不推迟已有计划。

XML 在脚本、Cookie、授权或订阅源配置变更后仍保留，配置变更只使普通临时缓存失效；后台移除定时任务也不删除 XML。已有 XML 只在下一次成功刷新时覆盖，访问继续按当前路由状态和权限校验。

自有订阅的快照按格式保存在 `API_STORAGE` 的 `rss/snapshots/<UUID>/` 中：`feed.json`、`feed.xml`、`feed.atom` 保存实际正文。D1 保存指针，R2 `rss/manifests/` 保存分发清单；请求先检查 D1 权限，再从响应缓存/R2 读取正文。响应缓存按公开 origin 隔离，缓存 60 秒，缺少清单时回源 D1。刷新先上传全部文件，再提交带当前版本校验的 D1 指针并发布清单；失败时保留旧快照，未提交的新对象会尝试清理。文件与 D1 不构成跨资源事务，清单发布失败由后台任务重试。

| 路径 | 功能 |
| --- | --- |
| `/` | 订阅广场 |
| `/admin/`、`/admin/discovery`、`/admin/scripts` | 管理后台与 SPA 子页面 |
| `/admin/auth/*`、`/admin/api/*` | 管理员会话与管理 API |
| `/rss/*`、`/atom/*`、`/mcp` | 订阅输出与 MCP 接口 |
| `/api/catalog`、`/api/sources`、`/api/search`、`/api/preview`、`/api/avatar/*` | 广场 API |
| `/public/avatar/<源 ID>/<对象 ID>`、`/public/scripts/<脚本 ID>/<版本>.js` | 公开 R2 头像与脚本源码，仅允许 GET / HEAD |

`server/` 保留共享 API 的领域、仓储、服务和 HTTP 分层。项目使用一份 `package.json`、lockfile 和 Wrangler 配置；`index.js` 分发 admin、discover 和 API 请求，HTTP/API 模块直接放项目根目录，通过函数调用 `server/` 内的业务服务；管理会话、Bearer Token 与 WebSocket Origin 校验继续保留。

数据库由 `migrations/` 中的 SQL 在部署前初始化，Worker 启动和请求不执行 DDL、旧数据回填或 schema 版本检查。设备调用状态计数由 D1 触发器维护，队列背压读取计数表。后台生成任务保存在 `jobs`，调度索引保存在 `schedules`。

设备连接心跳仅更新可休眠恢复的 WebSocket 附件；需要业务校验的任务消息交由 Worker 读取 D1。任务心跳按租约 token 更新到期时间；重复确认已运行任务只续租。过期凭证连接、设备任务租约由 Cron 检查和回收。

D1 保留最近调用、按发布者查询、订阅源分页及路径权限查询索引；订阅源先分页再关联快照和头像，路由公开性使用路径索引查询。KV 缓存脚本候选、来源与标签，最终权限仍查询 D1。

公开 RSS 在新 Worker 请求中按主键确认是否已登记。已有地址只读，不重写调度表；新地址登记通过 SQL 检查数量上限，由触发器创建待计算的调度记录。真实本地 D1 测试验证已有公开 XML 的读取写入为零，不包含私密源计费。

原 DO SQLite 的读写预算不能用于估算本实现。D1 计费读取、写入及索引更新，KV 另计读写，R2 与 Queue 各有操作计费；普通订阅读取仍需进行 D1 权限检查，私密源还需原子扣费。评估实际流量时应分别观察各资源的用量。[后端架构](backend-architecture.md)列出了缓存和调度边界。

写入检查覆盖 D1 事务回滚、任务领取与租约、KV 失败回源、R2 发布和 WebSocket 连接；旧 DO 的行数预算及 schema 升级过程已停用。

| 写入范围 | 检查结果与写入约束 |
| --- | --- |
| 初始化和迁移 | Schema、默认数据、脚本对象迁移均有持久化完成标记；重建实例不会重复导入。 |
| 设备状态和连接 | 活跃时间五分钟保存一次检查点，断开立即保存；重复断开不重复写，连接 ID 防止旧连接覆盖新连接。 |
| 访问、设备和 MCP Token | `last_used_at` 五分钟最多更新一次，SQL 条件在实例重建后仍有效；每 20 秒使用一次，一小时从 180 行降至 12 行。展示时间最多落后五分钟，撤销和有效期仍逐次验证。OAuth 一次性凭证消费、刷新轮换和重放撤销实时持久化。 |
| 设备调用及后台任务 | 租约续期、结果、重试和状态计数实时落库；重复后台任务共用进行中的任务，结束只更新 running 行。保留索引和触发器的真实写入成本，后台记录按保留边界裁剪。 |
| 订阅源和剪藏快照 | 每次尝试保存调度时间，成功保存最新采集时间和结果；重复错误和未变化的学习间隔不写。RSS 自动刷新已登记尝试时间后，内部执行不再重复登记；失败仍保留旧快照并等待下一周期。 |
| XML、普通缓存及分块 | XML 指针首次保存由 3 行降至 2 行，覆盖由 2 行降至 1 行；普通缓存仍保留过期和容量索引。分块仅按对应键回收，普通缓存清理不删除永久 XML。 |
| 目录发布及域名 | 自动更新按一分钟窗口合并；五项升级标记只补缺失项，相同域名在实例重建后不重写。权限变化仍立即发布，失败仍持久化重试状态并撤回旧产物。 |
| 访问计数及概览 | 每个命中的启用源每次订阅访问写一行计数，保持准确；命中 XML 缓存也会计数。同一路由命中多个登记源时分别计数。概览快照每五分钟保存一次，读取概览不重新生成。 |
| Cookie、脚本和设置 | Cookie 同步内容相同时跳过保存和缓存失效；值或属性变化、显式清空仍立即保存。脚本、平台、标签、权限授予和设置的变更来自业务操作，批量输入有现有数量/大小限制。 |
| 用户、积分、兑换和操作事件 | 注册、验证码尝试、限流、余额和账本按业务事务保存，避免丢失安全状态或记账；不通过延迟落库减少这些写入。 |
| 日志和 R2 | 设备及脚本日志使用 Workers Logs，不写旧 SQLite 日志表；R2 日志状态按一万条预留编号。脚本源码对象不可变并按对象去重；成功刷新 XML、剪藏和头像时才发布新对象并回收旧对象，R2 操作单独计费。 |
| 清理和 Alarm | 无过期记录的清理不产生行写入；1000 次空闲租约、历史调用及缓存清理的 SQL 写入为 0。Alarm 只在丢失、严重过期或需要提前时重新登记；每次 `setAlarm` 另计一行写入。 |

快照批量预算用仓储操作模拟已有自有 RSS 源刷新：后台任务插入、结束及裁剪 8 行，源尝试与结果 2 行，RSS 尝试时间及其索引 2 行，XML 指针覆盖 1 行，共 13 行/源。100 和 1000 源分别写 1300 和 13000 行；不包含首次登记、旧分块迁移、变化的学习间隔、头像、目录 KV、Alarm、脚本内设备调用、访问计数及积分操作。仅按这一场景计算，1000 个源每小时刷新已需约 31.2 万行/天，仍超过 [Workers Free 的 10 万行/天写入额度](https://developers.cloudflare.com/durable-objects/platform/pricing/)。去掉重复写入不会消除正常业务成本，不能承诺任意规模或抓取频率均处于免费额度内。

设备日志和脚本执行日志通过结构化 `console` 对象交给 [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 采集、存储和索引，业务执行不读写 `device_logs`、`script_logs` 表，也不在 R2 保存日志正文或索引。日志包含设备、连接、任务、分类、脚本、来源、完整错误堆栈及执行输出；敏感参数先脱敏，整条按 UTF-8 控制在 240 KiB 以内，超大元数据保留截断预览。配置保持 `head_sampling_rate: 1`，关闭额外的 `invocation_logs`，避免每个心跳再产生一条请求日志；实际采集仍受 Cloudflare 套餐额度及保留策略限制。

后台日志查询、分类筛选和 `before_id` 数字分页接口保持不变，服务端通过 [Workers Observability 查询 API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) 获取最近 3 天日志，对应当前 Workers Free 的保留期。官方事件游标用于内部翻页，同毫秒内的日志完整取回后再按业务 ID 排序。最近两分钟的日志在内存合并去重，最多 500 条 / 2 MiB，补齐索引延迟；实例重建后依赖 Cloudflare 索引。Webhook 直接使用本次错误发送，不依赖日志查询授权或索引就绪。

现有 R2 桶仅在 `logs/workers/state.json` 保存编号预留、已读删除边界和设备/脚本删除边界；每次预留 10000 个编号，重启后跳过旧编号段，不按条写入状态。该文件不含日志正文，不应单独删除或修改。删除已读消息或设备/脚本会在应用查询中立即隐藏对应历史日志，Cloudflare 的原始日志仍保留至平台保留期结束。状态存储故障仍输出完整 console 日志并发送 Webhook，但编号分配失败的记录只能在 Cloudflare 控制台查看；后台接口需要状态存储恢复。旧 SQLite 日志和此前的 R2 日志不自动搬运、扫描或删除，保留原数据供离线备份；新日志不会复制回旧表。

配置后台查询时，在 `.dev.vars` 填写以下三项；生产环境可逐项用 `npx wrangler secret put <变量名>` 交互设置，配置中的 Worker 名称与实际部署不同时，添加 `--name <实际 Worker 名称>`：

| 变量 | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Worker 所属账户的 32 位 ID |
| `CLOUDFLARE_WORKER_NAME` | 实际部署的 Worker 名称，必须与 Cloudflare 一致 |
| `CLOUDFLARE_API_TOKEN` | 仅授权该账户、具有 **Workers Observability Write** 权限的 API Token |

Wrangler OAuth 登录不等于给 Worker 提供运行时查询凭据。Token 仅在服务端使用，不发送给前端；缺配置、无权限、限流、超时或无效响应时，后台返回明确的 503，不回退扫描 DO。未配置查询凭据时，console 日志采集和业务 Webhook 仍可运行。后台查询继续要求管理员鉴权。可用 `node --test scripts/log_storage_smoke.test.mjs` 在隔离的真实本地 Worker 验证零日志 SQL 写入、仅保存小状态文件、官方 API 协议适配和重建后的查询；该测试模拟官方查询响应，不访问线上日志。

```bash
# 本项目根目录，Node.js 22.19+
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填写必需的 ADMIN_PASSWORD（无默认值）
npm run dev
npm run build
npm test
npm run dry-run
npm run deploy
```

也可以在本目录执行 `npm ci` 后使用 `npm run build|dev|test|dry-run|deploy`。`npm run build` 构建两个页面模块和共享静态资源，输出 `dist/assets/`；Wrangler 从 `index.js` 打包服务端与 QuickJS WASM。只将 `dist/assets/` 提供给 ASSETS；后端 bundle、WASM 和源码不作为静态文件公开。

## 后端资源与初始化

当前使用 Worker + D1 + KV + R2 + Cron/Queue，DO 仅维护 WebSocket。部署前创建资源并执行空库建表；不读取或迁移旧 DO 数据，也不使用旧 DO 备份格式导入。配置、事务边界、缓存一致性和任务恢复见[后端架构与部署](backend-architecture.md)。

## 网站与构建结构

- `index.js` 是唯一 Worker 入口，导出 `RealtimeHubDO`、`ApplicationEntrypoint` 并接入 `router.js`。
- `router.js` 分发前台、后台和现有 API；内部业务路径不对公网开放，自定义脚本图片路径保留回退。
- `api.js` 负责设备、RSS/Atom、MCP 和管理业务接口。
- `application_router.js` 处理 Worker 内部请求；`server/infra/realtime_do.js` 处理 WebSocket 并通过 RPC 调用 Worker。
- `admin.js` 负责管理员登录、Cookie 会话、后台 API 入口和后台页面映射。
- `discover.js` 负责前台页面和目录、搜索、预览、头像接口。
- `server/infra/discovery_home.js` 负责首页 SSR，复用 `discover/index.js` 的视图与页面模板。
- `public/` 只保存公共资源：品牌、来源图标和通用样式。前台业务源码在 `discover/`，后台业务源码在 `admin/`；HTML、业务 JavaScript、业务样式与页面 manifest 均不放入 `public/`。
- 前台仅保留首页，路由声明、首页模型、全部视图和浏览器挂载集中在 `discover/index.js`，Model 与 View 在文件内分别维护。后台用 `admin/store.js` 集中声明路由。后台 `pages/` 按 `xx.js`（视图）与 `xx.model.js`（状态、请求及业务行为）配对，`components/` 保存共用视图；菜单从路由声明生成。
- `scripts/` 集中保存统一构建、前后台 bundle 构建、Timeless 插件及 内置脚本快照同步工具；npm 命令从这里启动。
- `public/assets/` 保存共享依赖和 Timeless 浏览器适配模块；`public/brand/` 保存唯一品牌源文件。

`scripts/build.js` 负责启动构建所需的 API 并等待就绪，再异步执行 `scripts/build_frontend.js`；开发与构建通过 `scripts/local_worker.js` 共用 Worker 启动和清理逻辑。前端构建复制 `public/` 的公共资源，前后台脚本分别从 `discover/`、`admin/` 构建业务文件并写入同一临时输出，全部成功后原子切换为 `dist/assets/`；主 Worker 由 Wrangler 直接打包，不预生成 Go 嵌入用的服务端 bundle。前台静态文件在资源根路径，后台静态文件在 `/admin/`，依赖在 `/assets/`，品牌在 `/brand/`；旧图片地址保留构建别名，兼容已发布 R2 首页和 manifest。前台引用 `/base.css`；后台 `admin/style.css` 只维护单属性原子类，具体尺寸在页面 `style` 中声明，组件内部样式通过参数传入；后台 manifest 从同一份 `discover/site.webmanifest` 生成，只覆盖展示名称。

`wrangler.jsonc` 是唯一部署配置。静态资源由 Workers Static Assets 分发，动态页面和 API 使用 `run_worker_first`；不启用全站 SPA 回退，后台已登记页面才映射到 `/admin/index.html`。`server/lib/site_security.js` 同时定义动态响应和构建生成的静态 `_headers` 策略，保留 `manifest-src 'self'`。

本项目不使用 Go CLI、Go 嵌入产物或 Pages 部署。Go API 服务、设备客户端是仓库中的独立实现，不参与本项目构建。

生产 secret 使用 Wrangler secret，真实值不写入源码。必需值为 `ADMIN_PASSWORD`；Device Token 在后台「设备管理」创建，可设置备注、有效期、撤销和按需查看明文，凭证保存在 D1，不自动导入旧 DO 中的设备 Token。中央账号会话签名优先用 `READER_SESSION_SECRET`，未配置时依次回退旧 `DEVICE_TOKEN`、`ADMIN_PASSWORD`。Cookie 推送凭据按所用功能配置。首次部署需创建配置中的 R2 桶 `findrss-storage`。

`/admin/discovery` 新增或编辑订阅源时，`/rss/`、`/atom/` 地址必须匹配 `kind: rss` 的脚本路由，地址智能提示也只列出这类脚本的路由。普通外部订阅地址沿用原校验。

列表右上角“导出 JSON”下载所有订阅源（包括停用源），不受分页、关键词、来源或状态筛选影响，格式为 `{ "sources": [...] }`。源地址保留 `{{hostname}}` 模板；文件包含源配置与元数据，不含缓存状态或文章快照。

添加订阅源时，自动读取的头像和手动上传的头像都会在保存时持久化到 `API_STORAGE` R2 桶（`discovery/avatars/` 前缀），展示使用本站 `/public/avatar/<源 ID>/<对象 ID>` 地址，由 Worker 直接读取 R2，不依赖上游图片链接或 DO 查询。旧 SQLite 头像使用 `/public/avatar/<源 ID>?v=<更新时间>` 兼容入口，旧 `/api/avatar/` 地址继续可用；重新上传后改存 R2，没有 R2 绑定的环境沿用 SQLite。替换、移除头像或删除源会清理旧对象；清理失败记录日志，不回滚已提交的操作。上游拒绝下载时可手动上传头像。

脚本源码通过 `/public/scripts/<脚本 ID>/<版本>.js` 公开读取，例如 `/public/scripts/<脚本 ID>/1.2.3.js`；旧版本及草稿的内容哈希对象使用 `/public/scripts/<脚本 ID>/objects/<SHA-256>.js`。该入口只返回源码，不执行脚本。不可变头像、脚本及带版本号的旧头像均设置 `Cache-Control: public, max-age=31536000, immutable`，并使用 Worker 边缘缓存；不带版本号的旧头像入口缓存 60 秒。旧对象清理后，已缓存的副本仍可能保留至缓存到期，替换头像通过新对象 URL 生效。

`/public/` 仅按上述路径映射 `discovery/avatars/` 和 `scripts/`，不提供目录列表或任意对象 key 读取。`rss/snapshots/` 中的 RSS / Atom / JSON 正文不通过该入口公开，继续由原订阅路由按权限读取；R2 桶本身无需开启公开访问。

`FINDRSS_HOSTNAME` 是订阅地址中 `{{hostname}}` 的实际 origin。留空时使用当前请求的 origin，可同时通过 workers.dev 域名和自定义域名访问；需要固定订阅域名时再配置此变量。Worker 会将访问 origin 传递给内部业务路由，手动刷新快照使用本次请求的 origin，发现页定时快照刷新使用持久化保存的最近一次访问 origin。

`/admin/scripts` 的新增与编辑表单使用全屏三栏：左侧代码，中间对话，右侧调试。Debug 为每条路由显示一行路径输入框和「运行调试」按钮，默认填入该路由的 example，可编辑路径及 query；`/debug` 是固定前缀，不出现在输入框中，调试和脚本助手提交请求时统一添加。修改草稿后通过管理员端点 `POST /admin/api/scripts/routes` 编译读取路由元数据，不调用 handler，已有路由保留各自输入。点击对应按钮按地址匹配当前草稿的路由和 params/query；⌘/Ctrl + Enter 与实时调试使用当前选中的路由。首次运行后，「实时调试」会在停止编辑 800ms 后重新执行；执行期间的修改只补跑最后一份草稿。`POST /admin/api/scripts/debug` 仅允许管理员访问，使用真实抓取与授权 Cookie，不保存草稿、不读写公开响应缓存，返回与 `/debug` 相同的上下文、上游请求、日志、完整输出和错误堆栈。链接主机不作为抓取目标，query 中的 token 不传入脚本。原「Mock 测试」仍走独立的 `/scripts/test`；表单不再显示 Mock 路由序号；「保存后开放 /debug」只控制保存后公开路由的 Debug 配置。

新增脚本默认「保存草稿」，允许保存未完成代码；「发布正式」会重新校验模块及全部路由冲突，再开放启用中的路由。发布必须指定 `version`（可使用已保存草稿的版本号），格式严格为 `1.0.0` 三段数字，不允许前导零或预发布后缀，每次发布都须高于该脚本上次正式版本；直接修改正式脚本的源码或版本号也按发布校验。列表展示版本号，旧脚本显示「未编号」，下次发布需填写版本；列表「发布正式」会打开编辑器填写版本号。草稿版本可以留空，退回草稿仍保留上次正式版本作为递增基准。启停和 Debug 开关不升级版本。`metadata_json` 保存 `version`、`published_version` 和当前源码的 SHA-256 `script_hash`，无需新增数据库列。Cookie 授权同时绑定版本号、精确源码哈希及权限范围，改代码或升级版本都要重新确认；确认下一版的授权不会提前替换在线版本的授权。`POST|PATCH /admin/api/scripts` 接受 `status: "draft" | "published"`；PATCH 未传状态时保留当前状态，POST 未传状态时按正式处理并要求版本号。对已发布脚本提交 `status: "draft"` 和 `script` 时，将工作副本单独写入 `metadata_json.draft`，保留正式行的源码、路由、版本、启停状态和 Cookie 授权，不使正式缓存或公开目录失效。管理 API 在正式字段之外返回 `draft`，编辑器优先读取其中的源码、版本、类型和调试设置；重新发布才校验并替换正式行，成功后移除工作副本。仅提交 `status: "draft"`（不含 `script`）表示明确退回草稿，以当前正式源码覆盖工作副本并立即撤下路由；已有独立草稿时，界面先确认覆盖，API 必须同时提交 `overwrite_draft: true`，否则返回 409 并保留原状态；独立草稿不占用数据库的 `path` 唯一索引，已有正式路由继续占用自己的路径。

脚本统一使用 `script` 命名，管理 API 为 `/admin/api/scripts`，旧 `/admin/api/rss-scripts` 前缀仍兼容相同鉴权与行为。D1 空库直接创建 `scripts`、`script_logs`、`script_agent_settings` 等表，不执行旧表改名。结构化日志事件为 `script.exec`，`RSSScript`、`HotRankScript` 与订阅地址继续沿用。

当前 DO 类为 `RealtimeHubDO`，只维护连接，无业务表。Worker 改名时同步修改 `APPLICATION_SERVICE.service`；业务数据由显式绑定的 D1 和 R2 决定。旧 DO 版本的数据不会自动出现在本实现中。

脚本卡片的 Cookie 状态使用与实际 RSS 请求相同的校验：存在授权 ID 不等于当前版本、源码与脚本权限仍获授权。公开订阅源列表不参与授权校验，新增、删除、启停或调整订阅源公开性不影响脚本授权；兼容旧授权记录中的 `visibility.public_sources`，读取时忽略该字段。脚本版本、源码、Cookie 权限声明或脚本路由访问范围改变，以及撤销授权后，卡片会显示「Cookie 需要重新确认」。点击「重新确认 Cookie 权限」可在当前版本上重新确认，无需升级版本或运行脚本。管理员检查端点为 `POST /admin/api/scripts/<id>/cookie-permissions`，只校验并返回确认信息，不执行 handler、不自动授权。

脚本工作区现在是「代码 / 脚本助手 / Debug」三栏。脚本助手 `XiaoxunScriptAgent` 只注册当前草稿的 `get_script_draft`、`edit_script_draft`、`debug_script_draft` 三个工具。点击中栏「大模型设置」，可管理厂商列表、API Key、模型配置、参数、启用开关和连接测试页面。可配置最多 16 个厂商、每厂商 32 个模型，并保留相同的内置厂商预设和自定义入口。中栏对话提供 ProseMirror 输入框与模型选择，左下角按厂商分组、搜索和切换模型；每轮请求携带准确的厂商与模型标识，所选项删除或停用时不会自动换到其他厂商。设置经管理员接口保存到 应用 Worker 的 `script_agent_settings`，各厂商密钥分别使用 `ADMIN_PASSWORD` 派生的 AES-GCM 密钥加密，GET 不返回密钥；支持删除密钥，移除厂商会清理对应凭证；更新设置时 API Key 留空保留原密钥，轮换 `ADMIN_PASSWORD` 后需重新输入模型 API Key。

`GET|PUT /admin/api/scripts/agent/settings` 管理模型目录与密钥；`POST /admin/api/scripts/agent/test` 可在保存前使用草稿地址、参数和临时密钥测试连接；旧单模型配置自动转为默认厂商，保存目录时保留加密密钥。Workers AI 仅在部署注入 `AI` 绑定时可用；`GET /admin/api/scripts/agent/ws` 在当前管理员会话下传送流式回答、草稿修改和 Debug 结果。模型修改通过沙箱编译校验后立即更新左侧草稿，按版本拒绝过期结果；手动改代码或调试链接、停止对话或关闭表单都会取消当前运行。对话仅修改当前未保存草稿，不自动保存、发布或切换其他脚本。会话历史仅保留在当前编辑工作区，重新打开表单或刷新页面后开始新对话。单次运行最多 8 轮工具调用、3 分钟，WebSocket Hub 最多同时转发 4 轮对话。

全局 XiaoxunAgent 与脚本助手 XiaoxunScriptAgent 每轮模型调用均注入同一份 [脚本 SDK 知识](../server/lib/script_agent_runtime_knowledge.js) 和 [feed JSON → XML 知识](../server/lib/script_agent_feed_knowledge.js)。SDK 知识覆盖 `@findrss/util` 各工具的签名和返回值、`@findrss/core` 的基类/Result 导入、Result/parseJSON、显式 Cookie 授权、日志与草稿发布约定，并包含经过真实 QuickJS 执行验证的 RSS、热榜和 Cookie 示例；共享知识不增加助手的操作权限。feed 知识说明顶层字段对应 RSS `channel`、`items` 数组对应 `item`，并列出 Atom 映射、字段类型、时间回退、HTML 转义、图片/多图/附件/动态照片格式及完整示例。RSS/Atom 订阅脚本必须直接返回含 `items` 数组的 feed 对象，不能再包 `channel` 或预先转为 XML/JSON 字符串；不支持的原生 RSS 字段名不会自动映射。`HotRankScript` 的普通路由返回榜单快照，不适用这份 XML 输出规则。示例由测试交给真实 `FeedModel` 渲染并解析验证，助手运行测试同时检查每轮请求携带这份知识。

管理后台所有页面右下角提供「小讯」全局对话入口，提供对话框、输入框和左下模型选择，与脚本助手共用大模型配置和加密密钥。`GET /admin/api/agent/ws` 仍需管理员会话，并拒绝跨站 Origin。每次发送携带当前管理路由和页面上下文；切换路由取消当前运行并清空上一页历史，对话窗口保持打开。上下文包含页面用途；Cookie 页只提供域名和数量，不提供密钥值。脚本页仍使用三栏编辑器中的助手实时改草稿和 Debug。

`/admin/discovery` 的全局助手可查询、新增、编辑和删除订阅源，使用现有 `ServiceDiscovery` 校验、重复地址限制、模板保存和头像清理。编辑/删除必须先读取真实记录，写入点检查读取后记录是否变更，冲突时要求重新读取；只修改用户指定字段，不覆盖缺省字段。成功操作经 `resource_changed` 事件刷新列表，保留其它未保存表单；删除正在编辑的源会关闭该表单。当前筛选、选中源和未保存表单通过页面适配器注入；其它页面不提供订阅源写工具，不允许模型伪造跨页面操作。
脚本模块可声明 `export const version = "1.0.0"`，格式沿用发布版本的三段数字规则。安装预览返回声明的版本并默认填入版本输入框，管理员仍可修改；未声明时版本输入框为空。保存和发布以请求中的 `version` 为准，不自动用源码声明覆盖管理员填写或已保存的版本。

## 脚本源码存储与版本回退

配置 `API_STORAGE` 时，新正式版本源码存入 R2 的 `scripts/<脚本 UUID>/<版本号>.js`（例如 `1.0.0.js`），草稿继续存入 `scripts/<脚本 UUID>/objects/<SHA-256>.js`。正式版本对象不可覆盖：同版本相同源码复用，已存在同版本但源码不同则拒绝写入；源码指针仍保存 SHA-256 和字节数，用于完整性校验与 Cookie 授权。已有 hash 路径的正式版、历史版本及尚无合法版本号的旧脚本保持可读，不强制搬迁。D1 的 `scripts` 只保留源码指针和元数据，不再重复写入 `published_script` 正文；`script_releases` 保存不可变的正式版本索引，`script_release_events` 记录发布、迁移和回退操作。版本元数据过大时拒绝保存，避免超出 D1 的单行限制。没有 R2 绑定时兼容小脚本内联存储，大脚本明确报错；已经引用 R2 的源码不能降级成空源码。

保存先上传 R2，再在 D1 乐观事务中重新检查脚本是否被并发修改、路由是否冲突，以及 Cookie 授权是否仍有效，最后原子写入版本记录并切换指针。冲突返回 409，上传或事务失败保留原正式版本。本实现不在启动或 Cron 中搬迁旧 DO 脚本。

脚本列表默认返回元数据、源码大小、当前版本和授权状态，不下载 R2 源码。编辑时通过详情接口读取正式源码和独立草稿。路由匹配与已有 RSS/Atom 快照访问只读元数据和授权记录；真正执行时才读取源码并校验 SHA-256。源码缓存按估计字符串内存限制为 24MB，同一对象的并发冷读合并，Cookie 撤销仍实时检查。当前、历史及草稿引用的对象均保留，未引用对象经过至少 24 小时后按脚本分批回收；删除脚本后清理该脚本的版本记录和对象。

点击后台脚本卡片右上角的版本号按钮打开「版本历史」，可查看历史源码并回退。回退切换正式版本指针并写审计记录，保留未发布草稿和启停状态；重新编译历史源码，检查路由冲突、当前配置对旧版 schema 的兼容性和对应版本的 Cookie 授权。仍有效的历史授权可以复用，已撤销或缺失的授权必须重新确认。`max_published_version` 单独记录历史最高发布版本，回退不会降低下一次发布的版本基准。发布和回退后刷新关联公开及私密订阅源快照，刷新期间保留上次成功的 XML；版本切换后旧执行及迟到的 R2 上传不能覆盖新快照。

管理员接口：

- `GET /admin/api/scripts/<id>`：按需读取源码与草稿。
- `GET /admin/api/scripts/<id>/versions`：历史版本和最近操作记录。
- `GET /admin/api/scripts/<id>/versions/<release_id>`：历史源码。
- `POST /admin/api/scripts/<id>/rollback`：提交 `{ release_id, expected_release_id?, cookie_grant_id? }`，检查并发版本并回退。

非浏览器验证使用 `node --test test/script_storage.test.js`；执行 `npm run build` 后可用 `node --test scripts/script_storage_smoke.test.mjs` 启动隔离的本地 Worker，通过 HTTP 验证真实 R2 绑定下的 10MB 发布、独立草稿及回退。

## 脚本来源、标签与维护者

来源使用 `{ name, icon }`，`icon` 支持完整 SVG 源码、无凭据的 HTTP(S) 图片地址或站内图片路径，可省略或留空。默认值为 `{ name: "网页", icon: "" }`，兼容旧字符串。可 `export const platform = { name, icon }` 供全部路由共用，或通过 `route.platform` 逐条覆盖。未提供图标时沿用内置来源图标，自定义来源默认显示地球 SVG，无需在脚本中重复内嵌。品牌示例脚本直接内嵌 `public/platform-icons/` 中对应的 SVG，无需额外导入图标文件。

正式版本通过版本号、路由及 Cookie 授权校验后，脚本与来源在同一数据库事务中保存。来源按名称去重，同名新图标更新旧图标；草稿和调试不注册来源。`platforms` 表为订阅广场、后台来源筛选 Select 和订阅源表单提供统一列表，不需要先添加订阅源。升级时回填已发布脚本，草稿不参与；删除脚本或退回草稿不会清除已经收集的来源。已有订阅源的来源继续保留，新增自有源按匹配的已发布脚本路由预填来源。

`maintainers` 支持多个 `{ nickname, url, avatar }` 对象，也可用 `name` 代替 `nickname`（如 `{ name: '作者', avatar: 'https://example.com/avatar.png' }），后台展示昵称、头像和个人链接。昵称必填，`url`、`avatar` 可留空，非空时必须是无用户名密码的 HTTP(S) 地址；旧字符串数组继续支持。

标签使用 `export const tags = ['科技', '文章']` 为所有路由设置默认值，`route.tags` 或 `routes` 中的 `tags` 可逐条覆盖，空数组表示不带标签。每条路由最多 13 个不同标签，每个标签去除首尾空白后为 1–32 字符，不含控制字符，按名称精确去重。标签保存在路由元数据中，不是 handler 返回值或 RSS 条目分类。

与来源一样，正式发布成功后在同一事务中聚合脚本标签到 `tags` 表，草稿、调试和失败发布不收集；重启时回填已发布脚本，删除或退回草稿不清除已收集标签。discover 和管理后台共用这份可选标签列表，不再补固定默认标签或从订阅源、旧分类聚合。新增自有源按匹配路由预填标签，可手动修改，修改源不会注册新标签。XiaoxunAgent 的共享知识和订阅源上下文包含这套来源、标签声明与选择规则；全局助手只能修改订阅源配置，脚本声明由脚本编辑器助手协助修改草稿，管理员发布后生效。

```js
export const route = {
  name: "知乎用户作品",
  path: "/zhihu/people/:id/:kind?",
  tags: ["文章"],
  platform: { name: "知乎", icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>' },
  maintainers: [
    { nickname: "findrss", url: "https://example.com/", avatar: "https://example.com/avatar.png" },
    { nickname: "另一位维护者", url: "", avatar: "" },
  ],
  handler: ctx => script.run(ctx),
};
```

## 声明和填写脚本配置

在模块中导出 `config_schema`，脚本卡片会显示「配置」按钮，点击后按 Schema 生成表单，保存的值在 handler 中通过 `ctx.config` 读取。配置按脚本 ID 保存，多条路由共用，正式执行、草稿 Debug、媒体预览和 Mock 测试均读取同一份值；新脚本调试使用默认值。示例：

```js
export const config_schema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", title: "订阅源名称", minLength: 1, default: "我的订阅" },
    limit: { type: "integer", title: "条目数量", minimum: 1, maximum: 100, default: 20 },
    full_text: { type: "boolean", title: "抓取全文", default: false },
    language: { type: "string", title: "语言", enum: ["zh-CN", "en"],
      enumDescriptions: ["中文", "英文"], default: "zh-CN" },
    api_key: { type: "string", title: "API Key", writeOnly: true, description: "可选的接口凭据" },
  },
};
export const route = {
  path: "/configured-feed", name: "可配置订阅源",
  handler(ctx) {
    return { title: ctx.config.title, link: "https://example.com/", language: ctx.config.language,
      items: [] };
  },
};
```

支持 `string`、`number`、`integer`、`boolean`、嵌套 `object` 和 `array`；枚举生成选择框，布尔值生成开关，数组使用 JSON 文本框。字段可设置 `title`、`description`、`default`、`enum`、`enumDescriptions`、`writeOnly`；校验支持 `required`、`additionalProperties`（布尔值）、`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`minItems`、`maxItems` 和 `items`。根类型必须为 object，各对象需声明 properties，数组需声明 items，最多嵌套 8 层。暂不支持 `$ref`、组合和条件 Schema；不支持的关键字会在编译时报错。

`PATCH /admin/api/scripts/<id>` 接受 `{ "config": { ... } }`，替换配置并填入缺省值，服务端校验失败返回 400，不覆盖已保存值。配置保存不升级脚本版本，更新代码、启停、草稿状态切换保留配置；保存后清空脚本响应缓存。新增必填字段而无默认值时，可先保存代码，再从卡片补填；未补填时执行会报告配置错误。

配置上限 32KB，保存在现有 `metadata_json` 中，无需数据库迁移。`writeOnly` 仅遮挡输入，不加密存储，也不阻止管理员重新读取；不要把凭据写入 Schema 默认值、脚本输出或日志。

## 脚本 Result 与 JSON 解析

QuickJS 全局注入 `Result`、`BizError` 和 `parseJSON`，结构参考 Timeless `packages/base/src/result`：`Result.Ok(data)` 返回 `{ data, error: null }`；`Result.Err(message, code?, data?)` 返回 `{ data, code, error }`，其中 `error` 是包含 `message`、`messages`、`code`、`data` 的 `BizError`。判断成功使用 `result.error === null`，不能用 `data` 的真值判断（JSON 的 `null`、`false`、`0` 都可成功）。

`parseJSON(text, reviver?)` 捕获 JSON 语法和 reviver 错误并返回 Result。原生 `JSON.parse` 保留 JavaScript 原有语义，脚本应使用 `parseJSON`。`ctx.fetchText`、`ctx.invoke`、`ctx.cookies.get` 返回 `Promise<Result>`；`ctx.fail` 返回失败 Result，调用后应 `return`。基类的 `fetch`、`run` 和 `RSSScript.timestamp` 也使用 Result；子类捕获自身可能发生的异常并转成 `Result.Err`。

```js
export const route = {
  path: "/demo/json", name: "JSON 示例",
  async handler(ctx) {
    const fetched = await ctx.fetchText("https://example.com/data.json");
    if (fetched.error) return fetched;
    const parsed = parseJSON(fetched.data);
    if (parsed.error) return parsed;
    return Result.Ok(parsed.data);
  },
};
```

宿主只在路由出口展开一层成功 Result，再执行正文或 RSS/Atom 校验；失败 Result 保留错误代码、日志及堆栈并映射到原有 HTTP 错误响应。脚本可处理错误并返回回退结果。直接返回普通路由内容仍受支持。旧脚本文件没有自动改写：旧的接口调用需迁移为先检查 `.error`、再读取 `.data`；迁移 Cookie 脚本后需对新的源码版本重新授权。

## 内置工具模块

脚本通过 `import { utils } from '@findrss/util';` 使用公共工具，源码集中在 [script_util.js](../server/infra/script_util.js)。该虚拟 ES 模块在 QuickJS 编译、后台调试和正式执行时可用，无需安装 npm 包；模块加载只允许 `@findrss/util` 和 `@findrss/core` 两个名称，不读取宿主文件或下载代码。`utils` 是冻结的无状态对象，不提供原示例中的 `source`、`main`。

```js
import { utils } from '@findrss/util';

export const route = {
  path: '/demo/util', name: '工具示例',
  async handler(ctx) {
    const fetched = await utils.request_json(ctx, 'https://example.com/data.json', {
      headers: { Referer: 'https://example.com/' },
    });
    if (fetched.error) return fetched;
    const list = utils.array_at(fetched.data, 'data.items');
    if (list.error) return list;
    return Result.Ok(list.data);
  },
};
```

| 工具 | 返回值与用途 |
| --- | --- |
| `decode_entities(value)` / `decode_html(value)` | 字符串；解码常见 HTML 实体和数字实体，非法码点保留原文 |
| `plain_text(value)` / `escape_html(value)` | 字符串；提取文本或转义 HTML，不用于清洗可执行 HTML |
| `absolute_url(value, base)` | `Result<string>`；拼接 HTTP(S) 相对地址，拒绝其它协议、用户凭据与非法字符；相对地址必须显式传 base，空值返回空串 |
| `timestamp(value)` | `Result<number \| undefined>`；秒、毫秒或日期转为毫秒，缺失返回 undefined，无时区的年月日格式按北京时间处理 |
| `identity(value)` / `array_at(value, path = '')` | `Result<string>` / `Result<Array>`；校验稳定 ID 或按点分路径取得数组；数字 ID 必须是安全整数 |
| `request_text(ctx, url, options)` / `request_json(ctx, url, options)` | `Promise<Result>`；复用 `ctx.fetchText`，后者再调用 `parseJSON`，透传请求和解析错误 |
| `embedded_json(text, marker)` | `Result`；在正则 marker 后扫描 JSON 对象或数组，不执行页面代码 |
| `document_nodes(text, xml = false)` / `rows(root, selector)` | `Result`；轻量 HTML/XML 节点解析或取得非空列表；XML 拒绝 DOCTYPE |
| `descendants(root)` / `matches(node, selector)` / `select(root, selector)` | 数组 / boolean / 数组；遍历及匹配节点，未命中 select 返回空数组 |
| `text_of(node)` / `first(root, selector)` / `field(root, selector)` / `attribute(root, selector, name)` | 文本 / 节点或 undefined / 文本 / 属性字符串；文本或属性未命中返回空串 |
| `feed_items(xml, base)` | `Result<Array>`；读取常见 RSS/Atom 条目的稳定 ID、链接、正文、原始日期和缩略图，不补日期 |
| `map_results(array, mapper)` / `replace_results(text, pattern, mapper)` | `Result<Array>` / `Result<string>`；同步回调返回 Result，提取 data 并传播失败，避免 Result 混入条目或 HTML |
| `parseJSON(text, reviver?)` | `Result`；与全局 parseJSON 相同 |

节点选择器沿用旧示例的轻量实现，只支持标签、ID、class、属性存在/等于/前缀/后缀、后代与直接子节点，属性值不支持空白；不是完整 DOM/CSS 或严格 XML 校验器。请求工具提供基础 Accept、Accept-Language、User-Agent，允许 headers 覆盖，Referer 和 Cookie 句柄需脚本显式提供，Cookie 授权仍由宿主验证。JSON 请求不猜测各网站业务错误字段，脚本需自行校验接口回包。

`ctx.fetchText(url, { transport: "tcp" })` 使用宿主通用 TCP 传输，`utils.request_text/request_json` 同样透传此选项。默认 `transport: "fetch"` 仍使用 Workers Fetch。TCP 模式支持公网 HTTP（80）和 HTTPS（443）的 GET/POST；HTTPS 使用 Workers 原生 TLS 和证书校验，发送 HTTP/1.1，不模拟浏览器 TLS 指纹。脚本不能导入 socket 或读取 Cookie 明文；Cookie 授权、重定向检查、跨 origin 凭证移除和 HTTP 错误仍由宿主处理。连接、读取及解压共用 `timeout_ms`（默认且最大 10000），响应及解压后正文均不超过 10MB。请求声明 `Accept-Encoding: identity`，兼容 gzip/deflate 响应。每一跳都校验公网地址及标准端口，TCP 连接受 Cloudflare 出站限制，不保证改善目标网站风控。Debug 上游记录中的 `transport` 可区分实际传输方式。

Bilibili RSS 示例已显式选用 TCP，网页 API、Cookie、WBI 签名及分页保持原样。已保存的后台脚本不会自动更新，需要更新并发布脚本；源码变化后仍按现有规则确认 Cookie 权限。

采集脚本统一在独立仓库 [findrss-scripts](https://github.com/ltaoo/findrss-scripts) 维护，共有 84 个 Hot、18 个 RSS、2 个 Clip 剪藏脚本和 2 个 Detect 内容检测脚本。主项目通过 `node scripts/sync_hot_scripts.js /path/to/findrss-scripts` 更新 `server/infra/builtin_script_sources.js` 内置快照；正常构建只使用已提交的快照，不依赖本机外部目录。完整脚本目录与使用要求见独立仓库 README，脚本不会因源码同步而自动导入后台。

## 内置脚本基类

QuickJS 在编译、调试、Mock 测试和正式执行前将 `RSSScript`、`HotRankScript`、`ClipScript`、`DetectScript` 和 `Result` 注入全局，脚本可直接通过 `class WechatChannelsRSS extends RSSScript {}` 或 `class BaiduHotRank extends HotRankScript {}` 继承，无需 import 或复制基类。也可以从虚拟模块 `@findrss/core` 命名导入：`import { RSSScript, HotRankScript, ClipScript, DetectScript, Result } from '@findrss/core';`，导入对象与全局绑定相同，适合沿用 [findrss-scripts](https://github.com/ltaoo/findrss-scripts) 的脚本写法。子类实现 `async fetch(ctx)` 返回 Result，路由的 `handler` 返回实例的 `run(ctx)` 结果；每次执行使用独立沙箱，修改基类不会影响其它脚本。

`RSSScript` 校验 feed 和条目，归一化真实发布时间、按发布时间倒序排列并按稳定 ID 去重，返回可用于 `/rss`、`/atom` 的 feed JSON。缺失发布时间不使用采集时间补齐。条目的多图、动态照片、附件、媒体类型和 `extra` 字段会保留，源的 `id`、`extra` 与真实 `updated` 也会保留。

`HotRankScript` 校验榜单和热度，置顶项在前。非置顶排名为上游正整数，未知时使用 `null`；全部排名已知时按排名排列，有未知排名时保留上游次序。热度缺失为 `null`，不从列表下标或采集时间伪造数据。返回 `{ kind: "hot_rank", observed_at, entries, ... }` 榜单 JSON；此结果不含 `items`，使用普通路由访问，不通过 RSS/Atom 包装器。

热榜条目支持可选 `thumbnail` URL 字符串（如小说封面），有值时必须是无凭据的 HTTP(S) 绝对地址；相对地址由脚本先用 `utils.absolute_url` 转换。省略、`null` 或空字符串不会输出字段，兼容已有热榜。普通路由、缓存与 Debug JSON 保留此地址，不主动抓取缩略图。

热榜快照支持可选 `category` 分类字符串，去除首尾空格后最多 32 字符、不含控制字符；空值不输出。Hot 模块可导出同名 `category` 作为 `/rank/` 默认分类，供失败卡片归类，成功快照的分类优先；来源筛选使用 `platform.name`。模块可导出安全整数 `order` 控制页面卡片顺序，数值越小越靠前，缺失为 `0`，同值保持原顺序，不影响条目排名。分类、来源、搜索共同筛选；SSR 和客户端共用相同规则，HTML 缓存按全部筛选参数隔离。

管理页 `/admin/scripts` 用 Hot / RSS Tabs 作为标题，筛选、数量和列表按 `kind` 展示对应类型。列表接口支持 `GET /admin/api/scripts?kind=hot|rss|clip`，省略时返回全部。新增 Hot 使用百度热榜 HTML 示例，新增 RSS 使用 Solidot RSS 示例。模块可导出 `kind = "hot" | "rss"`，兼容旧 `script_type`；未声明时优先读取顶部 `/** HOT */` / `/** RSS */` 标记，再识别基类。迁移前无标记的 NewsNow 示例兼容归为 Hot，其余旧脚本默认 RSS。类型随草稿保存、发布、回退和列表响应保留；Hot 卡片提供普通路由地址。

示例见 [百度热榜](https://github.com/ltaoo/findrss-scripts/blob/main/hot/baidu_hot.js) 和 [微信视频号](https://github.com/ltaoo/findrss-scripts/blob/main/rss/wxchannels.js)。旧脚本仍可声明自己的同名局部类。

管理端订阅源、脚本和 Token 列表使用 Timeless `kit.ListCore` 配合 `kit.RequestCore` 请求后端分页，接口以 `limit/offset` 入参返回当前页和 `total_count`。订阅源支持 `visibility=all|public|private` 与 `status`、`source_type`、`q` 组合筛选；脚本支持 `kind`、`status`、`q`，关键词涵盖附加路由。无分页参数的列表调用继续用于内部逻辑和全量导出。

## 脚本 Cookie 授权

`ctx.fetchText()` 默认匿名，宿主不再按 URL 自动注入 Cookie，也不接受脚本直接填写 `headers.Cookie`。现有脚本文件不会自动改写或获得授权；依赖登录的旧脚本需逐个迁移。Cookie 同步和管理页面仍是管理员共享的凭据库，订阅者不能代替管理员授权。

模块显式声明权限，然后取得仅本次执行有效的句柄：

```js
export const permissions = {
  cookies: [{
    id: "weibo_session",
    origin: "https://weibo.com",
    path_prefix: "/ajax/",
    names: ["SUB", "XSRF-TOKEN"],
    purpose: "读取登录后可见的微博列表，并完成 CSRF 校验",
  }],
};

export const route = {
  path: "/demo/weibo/:uid", name: "微博列表", example: "/demo/weibo/123",
  async handler(ctx) {
    const session = await ctx.cookies.get("weibo_session");
    if (session.error) return session;
    ctx.log("使用的 Cookie 名称", session.data.names);
    const text = await ctx.fetchText("https://weibo.com/ajax/statuses/mymblog?uid=" + encodeURIComponent(ctx.params.uid), {
      cookies: session.data,
      cookie_headers: { "x-xsrf-token": "XSRF-TOKEN" },
    });
    if (text.error) return text;
    const parsed = parseJSON(text.data);
    if (parsed.error) return parsed;
    const body = parsed.data;
    if (!Array.isArray(body?.data?.list)) return ctx.fail("UPSTREAM_FETCH_FAILED", "微博没有返回列表，请检查登录状态");
    return Result.Ok({ title: "微博 · " + ctx.params.uid, link: "https://weibo.com/u/" + ctx.params.uid,
      items: body.data.list.map(item => ({ id: String(item.idstr || item.id),
        title: item.text_raw || "微博", content: item.text || "", published: item.created_at,
        link: "https://weibo.com/" + ctx.params.uid + "/" + item.bid })) });
  },
};
```

首次调试或发布弹出管理员确认窗口，显示名称、用途、origin、路径、源码 SHA-256 和脚本路由访问范围，并说明公开订阅源可被匿名访问且新增公开源无需重新授权。仅填写或修改版本号不会自动调试或弹出确认窗口，并取消等待中及进行中的调试；点击「发布正式」时检查新版本授权并按需确认，主动运行调试仍按当前版本检查。草稿无需授权即可保存。授权绑定脚本 ID、版本号、完整源码、规范化 Cookie 权限和脚本路由访问范围；这些内容变化需重新确认，公开订阅源目录变化不影响授权。未保存的授权有效期为 15 分钟，保存后绑定到新脚本。Cookie 值轮换不要求重新授权。沙箱只能看到句柄和声明的名称，不能读取值；派生请求头也由宿主生成，必须引用已授权名称。

宿主继续检查 Cookie 的 domain、hostOnly、path、Secure 和有效期；请求还必须命中授权的 HTTPS origin 和路径范围。为避免路径解释差异，带百分号编码的 pathname 不发送授权 Cookie。跨 origin 或离开授权路径的重定向移除凭据，后续返回原地址也不会恢复。Mock 测试不提供真实 Cookie 句柄。Debug 的「上下文」Tab 展示获取及发送的权限 ID、名称和不带 query 的地址，均不含值。

脚本卡片可「撤销 Cookie 授权」，立即清空响应缓存。每次路由请求在缓存读取前校验授权，每次 Cookie 使用及执行结束也重新校验；撤销阻止后续访问和结果入缓存，已发送的上游请求无法撤回。已被订阅者下载或缓存的内容不能收回。

此授权接口当前由 `findrss-worker` 提供。

## 内容检测脚本

`kind="detect"` 是网站内容检测，脚本代码修改本身不产生变化事件。`DetectScript.fetch(ctx)` 抓取，`normalize(data,ctx)` 返回 `Result<{title,link,snapshot}>`，`compare(previous,current,ctx)` 返回 `Result<{changes,matches?}>`，业务无法可靠判断时也可返回 `{status:"inconclusive",changes:[],issues:[{reason:"原因"}]}`；默认比较通过 `ctx.detect.compare` 提供，宿主核对事件与真实快照。`ctx.previous` 只读，包含旧快照 id 和 snapshot。

snapshot 包含以稳定名称为键的 content、record、list 检测对象。正文比较归一化后的字符串，字段递归比较并使用 JSON Pointer，列表使用稳定 ID 匹配条目；ordered 列表通过共同成员的相对顺序识别移动，新增或移除造成的位置偏移不会批量误报。列表 coverage 为 complete/window/partial，窗口须有稳定 scope；partial、incomplete、目标集合或结构变化返回 inconclusive，不推进基线。明确业务对象不存在时用 present=false，抓取失败和选择器失效返回 Result.Err。

`ServiceDetection` 复用后台任务、全局/单任务刷新策略与 Cron/Queue 调度。检测表保存基线及最近执行 ID，历史表保存摘要和 R2 对象键。每条任务保留最近 20 次执行及当前基线，64KB 以上的历史结果要求 API_STORAGE；快照上限 1MB，结果上限 8MB。R2 写入后在事务中再次检查来源、授权、记录版本及基线，失败时清理新对象，保留旧基线。

管理员接口 `/admin/api/detections` 支持 GET/POST；`/<id>` 支持 PATCH/DELETE；`/<id>/run` 和 `/<id>/reset` 支持 POST；`/<id>/runs` 与 `/<id>/runs/<run_id>` 支持 GET。历史不公开。`GET/HEAD /api/detect/<脚本路由>` 按原路由权限无状态试采样，不读取或推进正式任务基线，不复用采集内容缓存。Debug 和 AI 脚本助手可传 previous 旧快照复测，结果不会写入正式任务。

检测结构和完整示例见 [findrss-scripts/detect](https://github.com/ltaoo/findrss-scripts/tree/main/detect)。非浏览器验证：`node --test test/detect.test.js test/detection_scripts.test.js admin/__tests__/detections.test.mjs`。
