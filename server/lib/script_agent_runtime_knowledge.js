// 两个后台助手共用脚本 SDK 知识；示例由真实 QuickJS 执行验证。
export const SCRIPT_AGENT_UTIL_EXAMPLE = `import { utils } from ${JSON.stringify("@findrss/util")};
class ExampleRSS extends RSSScript {
  async fetch(ctx) {
    try {
      const fetched = await utils.request_json(ctx, 'https://example.com/api/articles', {
        headers: { Referer: 'https://example.com/' },
      });
      if (fetched.error) return fetched;
      const list = utils.array_at(fetched.data, 'data.items');
      if (list.error) return list;
      const items = [];
      for (const row of list.data) {
        const id = utils.identity(row.id);
        if (id.error) return id;
        const link = utils.absolute_url(row.url, 'https://example.com/');
        if (link.error) return link;
        const published = utils.timestamp(row.published);
        if (published.error) return published;
        items.push({ id: id.data, title: utils.plain_text(row.title), link: link.data,
          published: published.data, content: row.content });
      }
      ctx.log('解析文章列表', { count: items.length });
      return Result.Ok({ title: '示例文章源', link: 'https://example.com/', items });
    } catch (error) { return Result.Err(error); }
  }
}
const script = new ExampleRSS();
export const platform = { name: '网页', icon: '' };
export const tags = ['文章'];
export const route = { path: '/demo/utils', name: '工具模块示例', handler: ctx => script.run(ctx) };`;

export const SCRIPT_AGENT_HOT_RANK_EXAMPLE = `import { utils } from ${JSON.stringify("@findrss/util")};
export const category = '科技';
export const order = 10;
class ExampleHotRank extends HotRankScript {
  async fetch(ctx) {
    const fetched = await utils.request_json(ctx, 'https://example.com/api/hot');
    if (fetched.error) return fetched;
    const entries = utils.array_at(fetched.data, 'entries');
    if (entries.error) return entries;
    return Result.Ok({ title: '示例热榜', link: 'https://example.com/', category, entries: entries.data });
  }
}
const script = new ExampleHotRank();
export const route = { path: '/demo/hot', name: '热榜示例', handler: ctx => script.run(ctx) };`;

export const SCRIPT_AGENT_COOKIE_EXAMPLE = `export const permissions = { cookies: [{
  id: 'account', origin: 'https://example.com', path_prefix: '/account/',
  names: ['session'], purpose: '读取用户授权的登录账户页面',
}] };
export const route = {
  path: '/demo/account', name: 'Cookie 授权示例',
  async handler(ctx) {
    const cookies = await ctx.cookies.get('account');
    if (cookies.error) return cookies;
    const fetched = await ctx.fetchText('https://example.com/account/profile', { cookies: cookies.data });
    if (fetched.error) return fetched;
    ctx.log('账户页面获取完成');
    return Result.Ok({ body: fetched.data, content_type: 'text/html; charset=utf-8' });
  },
};`;

export const SCRIPT_AGENT_RUNTIME_KNOWLEDGE = `
FindRSS Worker QuickJS 脚本 SDK 知识（编译、Mock 调试、真实 Debug 和正式执行共用）：

一、全局对象与 Result
全局已注入 RSSScript、HotRankScript、Result、BizError、parseJSON，不需要导入或复制定义。也可用 ES 模块命名导入基类和 Result：\`import { RSSScript, HotRankScript, ClipScript, DetectScript, Result } from ${JSON.stringify("@findrss/core")};\`，导入对象与全局绑定相同，按脚本习惯二选一即可。没有 console、DOM、Node.js 或原生 URL 对象。
Result.Ok(data) 返回 {data,error:null}；Result.Err(message,code?,data?) 返回 {data,code,error:BizError}，error 包含 message/messages/code/data。先检查 result.error，失败 return result，成功取 result.data；不能用 data 的真值判断成功（null/false/0 都可以是成功数据）。
ctx.fetchText、ctx.invoke、ctx.cookies.get、ctx.puppeteer.navigate 返回 Promise<Result>；ctx.fail(code,message) 返回失败 Result，必须 return 才会中止当前 handler。基类 fetch/run/timestamp 也使用 Result；脚本自己的请求、解析和校验异常应转成 Result.Err，不用 throw 作为正常失败流程。
parseJSON(text,reviver?) 返回 Result 并捕获语法和 reviver 错误。使用 parseJSON 或 utils.parseJSON，不直接 JSON.parse。纯字符串转换无需套 Result。
路由出口由宿主展开一层 Result，错误映射为 HTTP 响应；不要把 Result 当 feed、items 数组或 HTML 内容。ctx.invoke 是设备调用，真实 Debug 可能调用设备并扣积分，Mock 只使用声明的 invoke；不要虚构设备能力。

脚本配置：模块可导出 config_schema（根 type:'object'、properties），卡片「配置」按 JSON Schema 生成表单，handler 通过 ctx.config 读取已保存配置和 default。多路由共用；编辑已保存脚本的 Debug/Mock 也读取保存值，新脚本只用默认值。支持 string/number/integer/boolean/object/array，title/description/default/enum/enumDescriptions/writeOnly、required/additionalProperties（布尔值）、minLength/maxLength/pattern/minimum/maximum/minItems/maxItems/items。object 需 properties、array 需 items；最多嵌套 8 层。不支持 $ref、组合或条件 Schema；不要生成这些关键字。配置保存不升级版本，改代码不会清空值；新增无默认值的必填项需管理员从卡片补填才能运行。writeOnly 仅遮挡输入，配置按脚本元数据保存；不要把真实密钥写进默认值或输出日志。

二、公共工具模块
脚本使用 ES 模块命名导入：\`import { utils } from ${JSON.stringify("@findrss/util")};\`。可导入的内置模块只有 \`@findrss/util\` 和 \`@findrss/core\`，不是需安装的 npm 包；禁止宿主文件、其它包和网络模块。utils 是冻结的无状态对象，不提供 utils.source/main，通用工具优先复用，不重复声明。
decode_html/decode_entities(value) → string：解码常见 HTML 实体和数字实体，非法码点保留原文。plain_text(value) → string：剔除 script/style 和标签、解码实体。escape_html(value) → string：将纯文本嵌入 HTML 片段时转义；不是 HTML 安全清洗器，也不是 XML 转义。直接给 feed 的 title/description/content 时不用整体 escape_html，XML 由渲染端处理。
absolute_url(value,base) → Result<string>：拼接 HTTP(S) 地址，相对地址显式传 base；拒绝其它协议、用户凭据、非法字符，空值成功返回空串，必填链接仍须检查。
timestamp(value) → Result<number|undefined>：秒/毫秒/数字字符串/日期转毫秒；缺失为 undefined，无时区的年月日格式按北京时间。RSSScript.timestamp(value) 返回 Result<ISO字符串|undefined>，不能混淆两者的单位和返回类型。
identity(value) → Result<string>：稳定非空 ID，数字必须是安全整数；不要使用排名、列表下标、随机值或采集时间充当 ID。array_at(value,path='') → Result<Array>：按点分路径读取数组；空数组成功，缺失/类型错误失败。
request_text(ctx,url,options) / request_json(ctx,url,options) → Promise<Result>：复用 ctx.fetchText，后者再 parseJSON。默认提供基础 Accept、Accept-Language、User-Agent，headers 可覆盖；Referer、Cookie 句柄需显式提供，其它请求 options 透传。错误保留 Result，不猜测网站业务状态字段，脚本自行校验回包。
transport:'tcp'：ctx.fetchText 和 utils.request_text/request_json 的通用选项，通过宿主 TCP 请求公网 HTTP:80 / HTTPS:443，支持 GET/POST；默认 transport:'fetch'。HTTPS 使用原生 TLS 证书校验和 HTTP/1.1，不是 gRPC，也不模拟浏览器 TLS 指纹。Cookie 仍需显式授权句柄，每跳校验地址并移除跨 origin 凭证；超时预算含连接/读取/解压，正文及解压后均限制 10MB。TCP 请求 identity 编码，兼容 gzip/deflate；受 Cloudflare 出站限制，不能承诺绕过风控。Bilibili RSS 示例沿用网页 API、Cookie 和 WBI 签名，仅改用此传输；已保存脚本需自行更新发布并确认新源码的 Cookie 权限。
kuaishou_sign:true：仅用于 POST https://www.kuaishou.com/rest/v/profile/feed，宿主以固定版本官方 SDK 为本次 JSON 请求体动态生成 __NS_hxfalcon/caver；配合显式授权的 cookies 句柄使用，不能复用 HAR 中的固定签名。网页 HTTP 200 不代表作品接口成功，需检查 result===1 和 feeds 数组。
embedded_json(text,marker:RegExp) → Result：扫描 marker 后的 JSON 对象/数组，处理括号和字符串转义，不执行页面脚本。
document_nodes(text,xml=false) → Result<节点树>：轻量 HTML/XML 解析，XML 拒绝 DOCTYPE。rows(root,selector) → Result<非空节点数组>：必需列表缺失时失败。
descendants(root)/select(root,selector) → 节点数组，matches(node,selector) → boolean，first(root,selector) → 节点或 undefined，text_of(node)/field(root,selector)/attribute(root,selector,name) → 字符串；未命中 select 返回空数组，文本/属性返回空串。节点查询直接返回值，document_nodes/rows 返回 Result；元素有不可枚举的 parent 供父节点查询，节点树可 JSON 序列化。
feed_items(xml,base) → Result<Array>：解析常见 RSS/Atom 的 ID、标题、HTTP(S) 链接、正文、日期和缩略图，缺失日期不补齐；轻量解析不涵盖所有 XML 扩展。
map_results(array,mapper) → Result<Array> 和 replace_results(text,pattern,mapper) → Result<string>：同步回调必须返回 Result，保留成功 data，立即传播失败并捕获异常；不要把 Result 对象直接放入 Array.map 或 String.replace 的输出中。
选择器只支持标签、ID、class、属性存在/等于/前缀/后缀、后代和直接子节点；属性值不支持空白，不支持完整 DOM/CSS 或严格 XML 校验。parseJSON(text,reviver?) 同全局函数。

三、RSS 源与热榜
handler(ctx) 的返回值可声明 kind：rss 提供 XML 与卡片预览；img、video、audio 返回 {kind,url,headers?}，分别预览图片、MP4、音频，均可用 Result.Ok 包装。url 必须是无凭据 HTTP(S) 绝对地址。纯公开直链可不声明 allowed_hosts；需要代理或 Referer 等请求头时，路由声明 allowed_hosts=[明确的公网 HTTPS 域名]，禁止 Cookie/Authorization。Debug 使用管理员专用草稿快照，视频/音频支持 Range/HEAD 流式播放；不能把预览地址保存到脚本输出中。这里的返回值 kind 与模块级 kind=rss|hot|clip|detect 的脚本分类不同。
class WechatChannelsRSS extends RSSScript {} 实现 async fetch(ctx) 返回 Result<feed>，route.handler 返回实例 run(ctx)。RSSScript 校验标题、来源链接、items 的稳定 ID/标题/原文链接，归一化时间、按真实 published 倒序并按 ID 去重。无发布时间的条目在末尾，不用采集时间补齐；热度与置顶不参与 RSS 排序。基类透传条目 description/content/image/images/live_photos/media_group/type/author/enclosure/categories/extra，保留源 id/extra 和真实 updated；多图、视频和动态照片可经 run(ctx) 输出。
class BaiduHotRank extends HotRankScript {} 的 fetch(ctx) 返回 Result<{title,link,category?,entries}>。可选 category 为最多 32 字符且无控制字符的分类字符串，去除首尾空格，空值不输出。模块可 export const category = '科技' 作为 rank 页默认分类（失败卡片也能归类），快照 category 有值时优先；export const platform = {name:'来源'} 用于来源筛选。模块可 export const order = 10 设置 rank 页榜单顺序，必须是安全整数，越小越靠前，省略按 0，同值保持原顺序，不影响条目排名。entry 必须有稳定 id/title/link；非置顶 rank 是上游正整数或未知 null，置顶 pinned=true 且 rank=null；heat={value:非负数字或null,unit:非空字符串,text:字符串}。可选 thumbnail 为小说封面等缩略图的无凭据 HTTP(S) 绝对 URL 字符串，基类校验并保留；省略、null 或空字符串不输出此字段，相对地址需先用 utils.absolute_url 转换。不能从列表下标推断排名或伪造热度。
Detect 内容检测脚本导出 kind="detect"、version、platform、route/routes。DetectScript.fetch(ctx) 抓取，normalize(data,ctx) 返回 Result<{title,link,snapshot}>，compare(previous,current,ctx) 返回 Result<{changes,matches?}>；run(ctx) 编排流程。ctx.previous 只读，是上次成功的网站数据快照（id、snapshot），不是脚本源码。ctx.detect.compare 提供默认比较，宿主只接受与前后值相符的标准事件；自定义 compare 无法可靠判断时可返回 Result.Ok({status:"inconclusive",changes:[],issues:[{reason:"原因"}]}), 不能同时返回变化或规则命中。可筛选事件、筛选 list.item_updated.fields，不能伪造变化。snapshot 由命名对象组成：content 的 value 是 text/html 字符串；record.value 是 JSON 对象；list.items 是 {id:稳定字符串,data:对象}，列表须声明 coverage=complete/window/partial，window 要有稳定 scope；ordered=true 比较共同条目的相对顺序。业务对象确实不存在时 present=false；缺失目标、登录页、验证码、失败和 partial 不等同于删除。结果 kind=detect、schema_version=1、status=initialized/unchanged/changed/inconclusive，带 snapshot、changes、matches、issues。变化类型 content.updated、field.added/removed/updated、list.item_added/removed/updated/moved、list.item_entered/left、target.appeared/disappeared。matches 项含 id、label、可选 change_indexes。正文/列表移出窗口/价格状态等按真实业务数据判断；脚本代码修改本身不算内容变化。后台 /admin/detections 保存任务、历史和独立基线；API /api/detect 只是无状态试采样。Debug 可传 previous 旧 snapshot 或完整成功历史重放，不写正式基线。首版不做截图、OCR 或 AI 语义比较。
Clip 脚本导出 kind="clip"、version、platform 和 route/routes。ClipScript.fetch(ctx) 返回 Result<{title,link,html,stats?}>，run(ctx) 统一输出 kind:"clip"；宿主清理 HTML、校验无凭据 HTTP(S) 来源链接并填写 captured_at，HTML 上限 8MB。ctx.clip.capture(url,{selector,viewport?,wait_ms?,id_prefix?}) 返回 Result<{title,html,stats}>，复用样式冻结及图片内嵌；浏览器保持匿名，Cookie 声明不会自动注入。可通过 ctx.fetchText 获取数据后直接生成 HTML，此类 Clip 不要求 BROWSER。Mock 可提供 clip:{capture:async()=>值或Result} 或 puppeteer.navigate。/api/clip 加脚本路由只匹配已发布启用的 Clip；后台剪藏保存脚本 ID、具体路由和刷新规则，/clips/<ID> 仅读最近成功快照。旧手动记录自动关联内置通用网页脚本。
HotRankScript.run(ctx) 返回 {kind:'hot_rank',observed_at,entries,...} 的 Result；置顶在前；其余排名全部已知时按 rank 升序，有未知 rank 时保留上游次序，不按热度重新排。observed_at 是采集时间，不是 published。Hot 脚本使用 /api/hot 加注册路径访问 JSON（如 /api/hot/douyin/hot），原普通路由和 Debug 仍可查看；/api/hot 只匹配已发布且启用的 kind=hot 脚本，/rss、/atom 只匹配 kind=rss 脚本。前缀不是 route.path 的一部分，路径参数、查询参数、公开性、访问凭证和 Cookie 授权规则不变。
模块可 export const kind="hot"、"rss"、"clip" 或 "detect"，兼容旧 script_type；未声明时按顶部 /** HOT */、/** RSS */、/** CLIP */ 或 /** DETECT */，再按基类推断。迁移前无标记的 NewsNow 示例兼容归为 hot，其余旧普通脚本默认为 rss。列表接口支持 ?kind=hot|rss|clip|detect。/admin/scripts 的标题是 RSS/Hot/剪藏/内容检测 Tabs，Tab 内筛选、数量和列表按 kind 只展示当前类型，新增使用对应类型的默认脚本。采集脚本维护在 https://github.com/ltaoo/findrss-scripts，共 84 个 Hot、18 个 RSS、2 个 Clip 剪藏脚本和 2 个 Detect 内容检测脚本；主项目使用自动生成的内置快照，不自动导入管理后台。route.path 不包含 /rss、/atom、/debug 前缀。新增脚本可存 draft，发布为 published 且 enabled 才生效。已发布脚本保存草稿只更新独立工作副本，旧正式源码、路由和授权继续有效；再次发布才替换正式版本，明确点击退回草稿才下线正式路由。脚本助手只能修改未保存草稿和 Debug，不能自行保存/发布/回退，全局助手不能声称修改脚本。

platform 使用 { name: '知乎', icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">...</svg>' }，icon 可以直接包含完整 SVG 源码，也支持无凭据的 HTTP(S) 或站内图片地址，允许为空；缺省为 { name: '网页', icon: '' }。可 export const platform 供全部路由共用，也可在 route.platform 覆盖；兼容旧字符串。正式版本发布成功后才收集来源并写入数据库，按名称去重，同名新图标更新旧图标；保存草稿和调试不注册来源。订阅广场来源列表与后台来源筛选 Select 从同一来源表读取。route.maintainers 支持多个 {nickname,url,avatar} 对象，也兼容字符串数组；nickname 必填，也可用 name 代替，url/avatar 可空，非空必须是无凭据 HTTP(S) 地址。

设置脚本标签使用模块声明 export const tags = ['科技', '文章']，全部路由共用；也可在 route.tags 或 routes 中每条路由的 tags 覆盖。路由数组覆盖公共标签，tags: [] 表示该路由无标签，不自动合并；未声明时为空数组。tags 是字符串数组，每条路由最多 13 个不同标签，每个标签去除首尾空白后为 1–32 字符，不能有控制字符；按精确名称去重。标签属于路由元数据，不要放进 handler 返回的 feed 或 item.categories 代替声明。
来源与标签都在正式版本校验成功后，随脚本在同一事务中收集入库；草稿、Debug 与失败发布不注册。discover 的标签筛选与后台订阅源表单的可选标签统一读取脚本标签表，取消固定默认标签，不从订阅源手填标签或旧分类生成目录。无需先创建订阅源；删除脚本或退回草稿不会清除已收集的来源和标签。旧脚本没有 tags 时不会产生默认标签。
订阅源配置与脚本声明分开：source_type 使用 get_admin_context.data.source_types 中的来源 ID，tags 使用字符串数组，可选标签见 data.tags；script_routes 提供已发布路由的来源和标签。新增自有 RSS/Atom 源默认带入匹配路由的来源和标签，管理员可以手动修改；修改源的 tags/source_type 不会注册新的脚本标签或来源。需要新增来源或可选标签时，在脚本页编辑 export const platform/tags 或 route.platform/tags 并发布。全局 XiaoxunAgent 可以说明和按授权修改订阅源配置，但没有脚本写入/发布工具，不能声称已更改脚本；三栏编辑器中的脚本助手可修改当前未保存草稿，正式发布仍由管理员操作。

四、显式 Cookie 权限与日志
ctx.puppeteer.navigate(url, options?, evaluate?) 显式渲染页面，依赖宿主 BROWSER 绑定，无渲染方式配置开关。options 支持 viewport:{width,height}（默认1440×900，宽320–3840、高320–2160）、selector（等待可见）、wait_ms（0–10000，默认1000）、args（数组）。省略 evaluate 返回 {html}；传入函数则返回其在页面中执行的 JSON 结果。函数没有脚本闭包，参数通过 args 传入，可访问 document/getComputedStyle；不能访问 ctx 或 Worker 环境。每次调用匿名新页面，不注入 Cookie，结束/失败/取消关闭会话。Mock 声明 puppeteer:{navigate:async(url,options,evaluate)=>值或Result}；无绑定且无 mock 返回错误 Result。区域内容与样式提取示例见 https://github.com/ltaoo/findrss-scripts/tree/main/clip。

ctx.fetchText 默认匿名，宿主不按 URL 自动注入 Cookie，不能填写 headers.Cookie。模块导出 permissions.cookies=[{id,origin,path_prefix,names,purpose}]：origin 是完整公网 HTTPS origin，无路径；path_prefix 是规范绝对路径；names 明确列出非空 Cookie 名称，不用通配符；purpose 说明读取用途。
管理员确认当前源码和权限后，await ctx.cookies.get(id) 得到 Result<句柄>；传入 fetchText(url,{cookies:result.data}) 或 utils.request_text/request_json 的 options。脚本拿不到 Cookie 明文，不能把句柄当字符串或手写 Cookie 头；宿主校验名称、域、路径、有效期和重定向。源码变更要重新确认，撤销后不能继续使用。AI 不能代替用户确认授权。
ctx.log(...args)/ctx.error(...args) 收集 info/error 日志，自身不抛错；ctx.error 记录日志，不会中止脚本，失败应 return Result.Err。日志不要记录凭证或账户页面正文。Debug 的输出、上下文、日志是三个 Tab，可以查看抓取、解析条目数量和错误的效果。
这些 SDK 约定仅适用于 findrss-worker QuickJS；Go/goja 暂不支持此内置模块和全局基类。下面的 example.com、Cookie 名称和数据结构仅为模板，必须根据真实网站、回包与用户授权替换。

五、RSSScript 与工具模块示例（返回 feed，由 /rss 或 /atom 渲染）
\`\`\`js
${SCRIPT_AGENT_UTIL_EXAMPLE}
\`\`\`

六、HotRankScript 示例（普通路由 JSON；上游需提供 entries 的 id/title/link/rank/pinned/heat）
\`\`\`js
${SCRIPT_AGENT_HOT_RANK_EXAMPLE}
\`\`\`

七、Cookie 授权示例（普通路由 HTML；执行前必须由管理员确认）
\`\`\`js
${SCRIPT_AGENT_COOKIE_EXAMPLE}
\`\`\`
`;
