import { clip_extract_source } from "./clip_extract.js";
// 沙箱内 ctx/日志/结果段的源码构造器（纯字符串拼接，不依赖运行时）。
//
// 单独一个文件而不是放进 `script_sandbox.js`：后者在顶层
// `import quickjs_wasm_module from "./quickjs.wasm"`，`node --test` 加载不了，
// 而这里的构造函数必须能被单元测试直接覆盖。
//
// 纯模块，不 import 任何东西。

/** 单次执行收集的 ctx.log/ctx.error 行数上限。 */
export const SCRIPT_LOG_MAX_LINES = 200;
/** 单次执行收集的 ctx.log/ctx.error 总字节上限。 */
export const SCRIPT_LOG_MAX_BYTES = 32 * 1024;
/** 单个日志值的字符上限（对象序列化后同样适用）。 */
export const SCRIPT_LOG_MAX_VALUE_CHARS = 500;
/** 调试页允许查看原始 HTML；普通日志仍使用原有小额度。 */
export const SCRIPT_DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** 对象序列化的深度上限，超过即输出占位文本。 */
export const SCRIPT_LOG_MAX_DEPTH = 6;

/**
 * `@findrss/core` 虚拟模块的源码：把内置基类与 Result 以命名导出的形式
 * 提供给 `import { RSSScript, Result } from "@findrss/core";`。
 * 全局绑定继续保留，兼容直接使用 `RSSScript` / `Result` 的旧脚本。
 * @returns {string}
 */
export function script_core_source() {
  return ["RSSScript", "HotRankScript", "ClipScript", "DetectScript", "Result"]
    .map(name => "export const " + name + " = globalThis." + name + ";").join("\n");
}

/** 超限提示只追加一次，与行数/字节上限共享同一段文本。 */
const LOG_TRUNCATED_TEXT = "日志超过上限（" +
  SCRIPT_LOG_MAX_LINES + " 行 / " + Math.floor(SCRIPT_LOG_MAX_BYTES / 1024) + "KB），后续输出已省略";

/**
 * 把 mock ctx 片段包装成沙箱内的赋值语句。
 * 括号包裹让裸 `{ ... }` 也能作为表达式求值。
 * @param {string} mock_ctx
 * @returns {string}
 */
export function script_mock_source(mock_ctx) {
  return "globalThis.__mockCtx = (" + mock_ctx + "\n);";
}

/** 追加的校验/结果段不属于用户源码，堆栈中单独命名。 */
export function script_error_source(text, source_lines) {
  return String(text).replace(/script-source\.js:(\d+)/g, (frame, line) =>
    Number(line) <= source_lines ? frame : "rss-result.js:" + (Number(line) - source_lines));
}

/**
 * ctx.log/ctx.error 的收集段源码。沙箱内没有 console，脚本只能通过这些方法
 * 输出中间值；收集结果挂在 globalThis.__logLines 上，由宿主在执行后读回。
 * 上限（行数 + 字节）任一触顶即追加一条截断提示并停止收集。
 * 格式化全程防御：循环引用/超深/取值抛错都降级为占位文本，ctx.log 自身绝不抛错，
 * 以免日志污染脚本行为。
 * @returns {string}
 */
export function script_log_source(debug = false) {
  return `const __LOG_MAX_LINES = ${SCRIPT_LOG_MAX_LINES};
const __LOG_MAX_BYTES = ${debug ? SCRIPT_DEBUG_LOG_MAX_BYTES : SCRIPT_LOG_MAX_BYTES};
const __LOG_MAX_VALUE_CHARS = ${debug ? SCRIPT_DEBUG_LOG_MAX_BYTES : SCRIPT_LOG_MAX_VALUE_CHARS};
const __LOG_MAX_DEPTH = ${SCRIPT_LOG_MAX_DEPTH};
const __LOG_TRUNCATED_TEXT = ${JSON.stringify(debug ? "调试日志超过上限（200 行 / 4MB），后续输出已省略" : LOG_TRUNCATED_TEXT)};
const __logLines = [];
let __logBytes = 0;
let __logTruncated = false;
const __logSerialize = (value, depth, seen) => {
  if (depth > __LOG_MAX_DEPTH) return "[超过深度上限]";
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "undefined") return "[undefined]";
  if (type === "bigint") return String(value);
  if (type === "function") return "[function " + (value.name || "anonymous") + "]";
  if (type === "symbol") return String(value);
  if (seen.indexOf(value) !== -1) return "[循环引用]";
  seen.push(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(__logSerialize(value[index], depth + 1, seen));
    }
  } else {
    result = {};
    for (const key of Object.keys(value)) {
      result[key] = __logSerialize(value[key], depth + 1, seen);
    }
  }
  seen.pop();
  return result;
};
const __logFormatValue = (value) => {
  let text;
  try {
    text = ${debug ? 'typeof value === "string" ? value : ' : ''}JSON.stringify(__logSerialize(value, 0, []));
  } catch (failure) {
    text = "[无法序列化的值]";
  }
  if (typeof text !== "string") return "[无法序列化的值]";
  return text.length > __LOG_MAX_VALUE_CHARS
    ? text.slice(0, __LOG_MAX_VALUE_CHARS) + "…[截断]"
    : text;
};
const __logAppend = (level, args) => {
  try {
    if (__logTruncated) return;
    let text;
    try {
      const parts = [];
      for (let index = 0; index < args.length; index += 1) {
        parts.push(__logFormatValue(args[index]));
      }
      text = parts.join(" ");
    } catch (failure) {
      text = "[日志格式化失败]";
    }
    if (__logLines.length >= __LOG_MAX_LINES || __logBytes + text.length > __LOG_MAX_BYTES) {
      __logTruncated = true;
      __logLines.push({ level: "warn", text: __LOG_TRUNCATED_TEXT });
      return;
    }
    __logBytes += text.length;
    __logLines.push({ level, text });
  } catch (failure) {}
};
globalThis.__logLines = __logLines;`;
}

/**
 * ctx 构造段源码。基线仍由 request_context + route.example 推导；
 * mock 的 params/query 按 key 覆盖合并（便于只覆盖 account 这类单键），
 * method/pathname 覆盖字符串值；invoke 优先取 mock 提供的函数（测试模式的
 * 唯一来源），其次才桥接真实设备，两者都没有时可调用但一调就抛明确错误。
 * 另注入 ctx.log/ctx.error（见 script_log_source），收集结果挂在
 * globalThis.__logLines 上供宿主读回。
 * 路由返回值由宿主输出；RSS/Atom 包装器负责 feed 转义与序列化，
 * 因此不再提供 ctx.xmlEscape。
 * @param {{ has_invoke: boolean }} options 是否桥接真实设备（真实 /rss/、/atom/ 请求为 true）
 * @returns {string}
 */
export function script_ctx_source({ has_invoke, debug = false }) {
  const invoke_source = has_invoke
    ? `ctx.invoke = async (method, args, options) => {
    try {
    if (typeof method !== "string" || method === "") {
      throw new Error("invoke 的 method 必须是非空字符串");
    }
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new Error("invoke 的 args 必须是对象");
    }
    const opts = options ?? {};
    const spec = {
      method,
      args: args ?? {},
      target_device_id: typeof opts.target_device_id === "string" ? opts.target_device_id : "",
    };
    return parseJSON(await __invoke(JSON.stringify(spec)));
    } catch (error) { return Result.Err(error); }
  };`
    : `ctx.invoke = async () => {
    return Result.Err("测试运行未提供 invoke mock：请在 mock ctx 中声明 invoke(method, args) 后重试", "DEVICE_UNAVAILABLE");
  };`;
  return `const __extractClip = (${clip_extract_source});
${script_log_source(debug)}
const __requestContext = JSON.parse(__requestContextJSON);
const ctx = {
  route: JSON.parse(__routeMetadataJSON),
  config: JSON.parse(__routeMetadataJSON).config || {},
  method: __requestContext.method,
  pathname: __requestContext.pathname,
  params: __requestContext.params,
  query: __requestContext.query,
  public_origin: __requestContext.public_origin || "",
  detect: Object.freeze({
    async snapshot(value) { try { return parseJSON(await __detectOperation("snapshot", JSON.stringify(value, (key, child) => {
      if (typeof child === "number" && !Number.isFinite(child)) throw new Error("检测数值必须有限"); return child;
    }))); } catch (error) { return Result.Err(error); } },
    async compare(previous, current) { try { return parseJSON(await __detectOperation("compare", JSON.stringify({ previous, current }))); } catch (error) { return Result.Err(error); } },
  }),
  async fetchText(url, options) {
    try { return Result.Ok(await __fetchText(url, options)); }
    catch (error) { return Result.Err(error); }
  },
  cookies: Object.freeze({ async get(id) {
    try { return Result.Ok(await __getCookies(id)); }
    catch (error) { return Result.Err(error); }
  } }),
  puppeteer: Object.freeze({ async navigate(url, options = {}, evaluate) {
    try {
      if (evaluate !== undefined && typeof evaluate !== "function") throw new Error("navigate 的 evaluate 必须是函数");
      if (__mockCtx?.puppeteer && typeof __mockCtx.puppeteer.navigate === "function") {
        const value = await __mockCtx.puppeteer.navigate(url, options, evaluate);
        return value && typeof value === "object" && "data" in value && "error" in value ? value : Result.Ok(value);
      }
      return parseJSON(await __puppeteerNavigate(JSON.stringify({ url, options,
        ...(evaluate === undefined ? {} : { evaluate: String(evaluate) }) })));
    } catch (error) { return Result.Err(error); }
  } }),
  clip: Object.freeze({ async capture(url, options = {}) {
    try {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("capture 的 options 必须是对象");
      if (Object.keys(options).some(key => !["selector", "viewport", "wait_ms", "id_prefix"].includes(key))) throw new Error("capture 包含不支持的选项");
      if (typeof options.selector !== "string" || !options.selector.trim() || options.selector.length > 1000) throw new Error("capture 需要 1–1000 字符的 CSS 选择器");
      if (__mockCtx?.clip && typeof __mockCtx.clip.capture === "function") {
        const value = await __mockCtx.clip.capture(url, options);
        return value && typeof value === "object" && "data" in value && "error" in value ? value : Result.Ok(value);
      }
      const { id_prefix, ...navigation } = options;
      const result = await ctx.puppeteer.navigate(url, { ...navigation,
        args: [options.selector, { id_prefix: id_prefix || __requestContext.clip_id || "" }] }, __extractClip);
      if (result.error) return result;
      if (!result.data?.ok) return Result.Err(result.data?.error || "节点提取失败", "UPSTREAM_INVALID_RESPONSE");
      return Result.Ok({ title: result.data.title || "", html: result.data.html, stats: result.data.stats });
    } catch (error) { return Result.Err(error); }
  } }),
  log: (...args) => __logAppend("info", args),
  error: (...args) => __logAppend("error", args),
  fail(code, detail) {
    if (typeof code !== "string" || typeof detail !== "string" || !detail.trim() || detail.length > 1000) {
      return Result.Err("ctx.fail 需要错误代码和不超过 1000 字符的公开提示", "INVALID_PARAMETER");
    }
    return Result.Err(detail, code);
  },
};
function __freezePrevious(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) __freezePrevious(child); Object.freeze(value); }
  return value;
}
Object.defineProperty(ctx, "previous", { enumerable: true, value: __freezePrevious(__requestContext.previous ?? null) });
const __mockCtx = typeof globalThis.__mockCtx === "undefined" ? null : globalThis.__mockCtx;
if (__mockCtx !== null && (typeof __mockCtx !== "object" || Array.isArray(__mockCtx))) {
  throw new Error('mock ctx 求值结果必须是对象（例如 ({ params: { account: "wow36kr" } })）');
}
if (__mockCtx !== null && __mockCtx.params !== undefined) {
  if (__mockCtx.params === null || typeof __mockCtx.params !== "object" || Array.isArray(__mockCtx.params)) {
    throw new Error("mock ctx 的 params 必须是对象");
  }
  ctx.params = { ...ctx.params, ...__mockCtx.params };
}
if (__mockCtx !== null && __mockCtx.query !== undefined) {
  if (__mockCtx.query === null || typeof __mockCtx.query !== "object" || Array.isArray(__mockCtx.query)) {
    throw new Error("mock ctx 的 query 必须是对象");
  }
  ctx.query = { ...ctx.query, ...__mockCtx.query };
}
if (__mockCtx !== null && typeof __mockCtx.method === "string") {
  ctx.method = __mockCtx.method;
}
if (__mockCtx !== null && typeof __mockCtx.pathname === "string") {
  ctx.pathname = __mockCtx.pathname;
}
if (__mockCtx !== null && typeof __mockCtx.invoke === "function") {
  ctx.invoke = async (method, args, options) => {
    try {
      const value = await __mockCtx.invoke(method, args, options);
      return value && typeof value === "object" && "data" in value && "error" in value ? value : Result.Ok(value);
    } catch (error) { return Result.Err(error); }
  };
} else {
  ${invoke_source}
}
globalThis.__actualRequestContextJSON = JSON.stringify({ method: ctx.method, pathname: ctx.pathname, params: ctx.params, query: ctx.query });`;
}

/**
 * 结果段源码：调用 route.handler(ctx)，展开 Result；只在宿主边界转换失败，并校验返回值。
 * 契约：handler 返回可序列化的值，响应格式由宿主解释；
 * 序列化成 JSON 串经 globalThis.__result 传出，内置包装器按请求前缀渲染。
 * @returns {string}
 */
export function script_result_source() {
  return `const __describe = (failure) =>
  failure && failure.message
    ? failure.message + (failure.stack ? "\\n" + failure.stack : "")
    : String(failure);
let __result;
try {
  if (typeof routes === "undefined" && (typeof route !== "object" || route === null || typeof route.handler !== "function")) {
    throw new Error("脚本模块必须导出包含 handler 的 route 对象");
  }
  const __selected = typeof routes !== "undefined" ? routes[ctx.route.route_index || 0] : route;
  if (!__selected || typeof __selected.handler !== "function") throw new Error("找不到选中的路由 handler");
  __result = await __selected.handler(ctx);
  if (__result && typeof __result === "object" && "data" in __result && "error" in __result) {
    if (__result.error) {
      const error = __result.error;
      const failure = Object.assign(new Error(error.message || error.messages?.join("\\n") || "脚本返回错误"), {
        name: "FeedError", code: error.code ?? __result.code ?? "SCRIPT_FAILED",
      });
      if (error.stack) failure.stack = error.stack;
      throw failure;
    }
    __result = __result.data;
  }
} catch (failure) {
  if (failure && failure.name === "FeedError") throw failure;
  throw new Error("脚本异常：" + __describe(failure));
}
try {
  globalThis.__result = JSON.stringify(__result);
} catch (failure) {
  throw new Error("路由返回值无法序列化：" + __describe(failure));
}
if (typeof globalThis.__result !== "string") {
  throw new Error("路由返回值无法序列化");
}`;
}

/** 校验模块中的全部路由；只传回元数据，handler 留在沙箱。 */
export function script_metadata_source(default_type = "rss") {
  return `
if (typeof route !== "undefined" && typeof routes !== "undefined") {
  throw new Error("不能同时导出 route 和 routes");
}
const __entries = typeof routes !== "undefined" ? routes : typeof route !== "undefined" ? [route] : null;
if (!Array.isArray(__entries) || __entries.length === 0 || __entries.length > 32) {
  throw new Error("routes 必须是包含 1–32 条路由的数组");
}
const __metadata = __entries.map((entry, route_index) => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("route 必须是对象");
  }
  entry = { url: "", platform: typeof platform === "undefined" ? { name: "网页", icon: "" } : platform, tags: typeof tags === "undefined" ? [] : tags, maintainers: [], example: entry.path, parameters: {}, description: "", ...entry };
  if (typeof entry.path !== "string" || entry.path === "") {
    throw new Error("route.path 必须是非空字符串");
  }
  if (typeof entry.name !== "string" || entry.name === "") {
    throw new Error("route.name 必须是非空字符串");
  }
  if (typeof entry.url !== "string") { throw new Error("route.url 必须是字符串"); }
  if (!Array.isArray(entry.maintainers)) {
    throw new Error("route.maintainers 必须是字符串或维护者对象数组");
  }
  entry.maintainers = entry.maintainers.map(value => {
    if (typeof value === "string") return value;
    const nickname = value && (value.nickname || value.name);
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof nickname !== "string" ||
        !nickname.trim() || nickname.length > 128) throw new Error("维护者 nickname 或 name 必须是 1–128 字符的字符串");
    for (const key of ["url", "avatar"]) {
      if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 2048 ||
          value[key] !== "" && !/^https?:\\/\\/[^\\s/]+(?:[/?#]|$)/i.test(value[key]))) {
        throw new Error("维护者 " + key + " 必须是 HTTP(S) URL");
      }
    }
    return { nickname: nickname.trim(), url: value.url || "", avatar: value.avatar || "" };
  });
  if (typeof entry.handler !== "function") { throw new Error("route.handler 必须是函数"); }
  if (typeof entry.example !== "string" || !entry.example.startsWith("/")) {
    throw new Error("route.example 必须是以 / 开头的字符串");
  }
  if (entry.parameters === null || typeof entry.parameters !== "object" || Array.isArray(entry.parameters)) {
    throw new Error("route.parameters 必须是对象");
  }
  if (Object.values(entry.parameters).some((value) => typeof value !== "string")) {
    throw new Error("route.parameters 的值必须是字符串");
  }
  if (typeof entry.description !== "string") { throw new Error("route.description 必须是字符串"); }

  if (entry.public !== undefined && typeof entry.public !== "boolean") throw new Error("route.public 必须是布尔值");
  return {
    // 旧脚本的 type 仅用于兼容公开性，不参与注册或路由选择。
    public: entry.public === undefined ? entry.type === "image_proxy" : entry.public,
    route_index,
    allowed_hosts: entry.allowed_hosts,
    path: entry.path,
    name: entry.name,
    url: entry.url,
    platform: entry.platform,
    tags: entry.tags,
    maintainers: entry.maintainers,
    example: entry.example,
    parameters: entry.parameters,
    description: entry.description,
  };
});
const __scriptType = typeof kind !== "undefined" ? kind : typeof script_type === "undefined" ? ${JSON.stringify(default_type)} : script_type;
if (__scriptType !== "hot" && __scriptType !== "rss" && __scriptType !== "clip" && __scriptType !== "detect") throw new Error("kind/script_type 必须是 hot、rss、clip 或 detect");
if (["clip", "detect"].includes(__scriptType) && (typeof version === "undefined" || !String(version).trim())) throw new Error("Clip/Detect 脚本必须导出 version");
if (["clip", "detect"].includes(__scriptType) && typeof platform === "undefined") throw new Error("Clip/Detect 脚本必须导出 platform");
if (__scriptType === "hot") {
  if (typeof category !== "undefined" && (typeof category !== "string" || category.trim().length > 32 || /[\\u0000-\\u001f\\u007f]/.test(category))) throw new Error("category 必须是最多 32 字符且不含控制字符的字符串");
  if (typeof order !== "undefined" && !Number.isSafeInteger(order)) throw new Error("order 必须是安全整数，数值越小越靠前");
}
globalThis.__routeMetadataJSON = JSON.stringify({ ...__metadata[0], kind: __scriptType, script_type: __scriptType, routes: __metadata, permissions: typeof permissions === "undefined" ? {} : permissions,
  ...(__scriptType === "hot" && typeof category !== "undefined" ? { category: category.trim() } : {}),
  ...(__scriptType === "hot" && typeof order !== "undefined" ? { order } : {}),
  ...(typeof version === "undefined" ? {} : { version }),
  ...(typeof config_schema === "undefined" ? {} : { config_schema }) });`;
}
