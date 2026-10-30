# 后端存储与任务执行

本实现使用全新的 D1 数据库，不读取、迁移或恢复旧 DO 数据。部署前必须创建 D1、KV、Queue 和 R2，并完成数据库初始化；不能直接用旧 DO 绑定启动新版。已有线上资源不会被初始化命令清空。

已有部署的 `APIDurableObject` 类和命名空间继续保留，避免升级时删除旧数据；该类不再执行业务，待执行的 Alarm 直接结束。新连接使用独立的 `RealtimeHubDO`。

## 资源分工

| 资源 | 保存或执行的内容 | 一致性要求 |
| --- | --- | --- |
| Worker | HTTP API、鉴权、抓取、QuickJS、Agent、内容生成 | 权限与计费查询 D1 |
| D1 `DB` | 用户、凭证摘要、积分与账本、配置、授权、脚本索引、设备任务、后台任务和调度索引 | 权威数据；多表写入原子提交 |
| KV `CACHE` | 脚本路由候选、来源列表、标签列表 | 可重建的查询缓存；不作授权依据 |
| R2 `API_STORAGE` | 源码、RSS/Atom、头像、剪藏、检测历史、私有草稿预览、目录与热榜页面 | 数据库保存指针，文件按版本保存 |
| Queue `JOBS` | 后台任务 ID 的投递 | 允许重复投递，D1 租约防止重复执行 |
| Cron | 每分钟扫描到期调度、补投任务、回收租约和清理历史 | 分钟级调度，不保证秒级启动 |
| DO `REALTIME` | 设备和管理端 WebSocket、消息转发、设备调用等待器 | 使用连接附件和内存，不调用 DO storage 或 Alarm |

HTTP 入口在 `index.js`，`server/application.js` 组装业务服务，`application_router.js` 分派内部请求，业务代码位于 `server/service/application/`。WebSocket DO 通过 `APPLICATION_SERVICE` 调用同一 Worker 的 `ApplicationEntrypoint`，把业务执行交回 Worker。内部请求路径不对公网开放。

## 首次部署

需要 Node.js 22.19.0 或更新版本，以及已登录的 Wrangler。以下命令在项目根目录执行，创建账号中的新资源：

```bash
npm ci
npx wrangler login
npx wrangler d1 create findrss-db
npx wrangler kv namespace create CACHE
npx wrangler queues create findrss-jobs
npx wrangler r2 bucket create findrss-storage
```

已有资源可跳过对应创建命令。在 `wrangler.jsonc` 中填入创建结果：

- `d1_databases[0].database_id`：D1 的真实 UUID，`database_name` 对应创建的数据库名称。
- `kv_namespaces[0].id`：KV 的真实 namespace ID。
- Queue 生产者与消费者使用同一队列名称，R2 桶名对应实际桶。
- 自定义 Worker 名称时，同时修改 `name` 和 `services` 中 `APPLICATION_SERVICE.service`，二者必须一致；保留 `entrypoint: "ApplicationEntrypoint"`。

然后初始化业务表、配置密钥并部署：

```bash
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

`migrations/0001_application.sql` 是空库的建表文件，包含索引和调度触发器；它不导入旧 DO 数据。这里使用 Wrangler 的标准 schema 管理命令，后续新增 schema 文件也需在部署前应用。KV 无需初始化，可以随时清空后重新填充。不要删除旧 DO 命名空间来尝试初始化新库。

Cloudflare Builds 部署前也需完成资源创建、填入 ID 和远程建表。配置文件里的全零 ID 只供本地开发，不能用于生产。改名或使用独立环境时，还需同步所有资源绑定和自调用服务名称。

## 查询与缓存

路由候选、来源与标签优先使用进程内缓存，再读 KV，最后回源 D1。进程内缓存为 15 秒、最多 128 项；KV TTL 为 300 秒。配置写入成功后刷新对应缓存；KV 读写故障不会回滚业务提交，读取可以回源 D1。

KV 是最终一致缓存，因此新增路由或列表变更可能延迟显示。脚本是否启用、当前版本、源的公开性、Cookie 授权、用户状态和余额始终通过 D1 校验，缓存不能恢复已撤销的权限。Cookie 与凭证明文、余额、租约不写 KV。

RSS/Atom 请求先完成权限和计费检查，再从响应缓存或 R2 读取快照。R2 的 `rss/manifests/` 保存当前快照的文件清单，正文在 `rss/snapshots/<UUID>/`；响应缓存按公开 origin 隔离，缓存 60 秒。缺少清单时回源 D1 指针。已有快照继续可读，首次缺少快照时创建 Queue 任务并返回 `503 FEED_GENERATING` 与 `Retry-After: 5`。

这里缓存的是正文；鉴权、私密源扣费仍会访问 D1。公开目录和头像、公开版本源码等静态文件直接由 Worker/R2 分发。

草稿媒体预览存入 R2 的私有 `previews/scripts/` 前缀，最多保留 16 份、有效期 15 分钟，跨 Worker 请求仍可读取；每次访问仍要求管理员身份及当前 Cookie 授权。过期文件由维护任务清理。剪藏和检测的执行状态从 D1 活跃任务读取，不依赖当前 Worker 的内存。

## 事务与并发

D1 不提供原来的 DO 同步事务回调。`server/infra/d1.js` 采用乐观校验：回调中的查询记录所见结果，写入暂存，最终在一个 D1 `batch()` 中重新验证查询结果并提交全部写入。查询结果变化会令整个 batch 回滚，接口返回 409，客户端需重新读取后重试。

积分扣减与账本、兑换记录与入账、授权码消费与凭据签发、脚本与发布记录等共用这个提交边界。回调内的读取看到数据库已提交状态，不能依赖本回调尚未提交的写入；需要读取写入结果时在事务成功后查询。网络抓取和 R2 上传放在提交前，R2 不属于 SQL 事务；上传失败不切换指针，数据库提交失败会尝试清理新对象。

业务提交后的缓存刷新、通知与调度计算失败只记录日志。调度表同时由 SQL 触发器标记待计算，Cron 会从权威配置重新计算，避免请求中断后丢失刷新计划。

## 后台执行与恢复

每条任务先落 D1 `jobs`，再向 Queue 投递 ID。同一任务键仅允许一条排队或执行中的记录。消费者用一条条件 UPDATE 领取任务，同时检查全局运行数；并发上限沿用后台设置，范围 1–16，默认 4。

任务租约为 15 分钟，执行信号最长 14 分钟。Queue 重复投递不会再次执行已领取或完成的任务。Cron 会回收失效租约、重投未发送或超过 5 分钟未确认的待办。任务最多执行三次，失败按次数退避，终态记录保留七天；最近任务接口返回 100 条，按源 ID 查询执行中任务不受此上限影响。

自动任务开始前重新校验启停和仅手动规则。取消保存为 D1 状态，运行者每 5 秒检查一次，向采集链路传播取消信号；D1 写入同时校验租约，R2 发布前也重新检查任务状态。取消不会撤销已提交的结果，已经发往上游的网络请求可能稍后才停止。

设备调用使用单独的 D1 `calls` 队列：领取时原子校验设备容量，结果与心跳按租约 token 更新。DO 只保管在线连接和同步等待器，连接心跳不会写 D1；业务消息仍需验证设备凭证。过期调用由 Cron 回收。DO 重启时临时等待器可能丢失，调用者可按任务 ID 查询结果。

## 本地验证

`npm run dev` 和默认的 `npm run build` 会先初始化本地 D1，再启动 Worker；数据位于本地 Wrangler 持久化目录，不使用远程数据库。指定 `DISCOVERY_API_ORIGIN` 时构建直接向该接口取公开目录。

```bash
npm test
node --test scripts/d1_smoke.test.mjs
node --test scripts/script_storage_smoke.test.mjs
```

后两项启动隔离的本地 Workers 运行时，通过 HTTP/WebSocket 验证 D1/KV/R2/Queue、RPC、公开快照权限和大脚本发布回退，不调用浏览器，也不部署线上资源。

平台语义见 [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[KV 一致性](https://developers.cloudflare.com/kv/concepts/how-kv-works/)、[Queue 时限](https://developers.cloudflare.com/queues/platform/limits/)与 [Worker RPC 流](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response)。
