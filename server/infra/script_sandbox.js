import { load_douyin_sdk, sign_douyin_request } from './douyin_sdk.js';
import { load_kuaishou_sdk, sign_kuaishou_request } from './kuaishou_sdk.js';
import { rss_fetch_headers, rss_cookie_headers, rss_fetch_request, rss_fetch_timeout, RSS_FETCH_CREDENTIAL_HEADERS } from "./rss_fetch_headers.js";
import { create_sandbox_promises } from "./sandbox_promises.js";
import { public_feed_failure } from "../lib/feed_error.js";
import { rss_response_text } from "./rss_response_text.js";
import { tcp_http_fetch } from "./tcp_http.js";
// QuickJS(wasm) 沙箱：校验 route/routes，执行选中的 handler 并取回 JSON。
//
// 所有路由共用 handler(ctx)，返回 JSON、文本响应或代理目标描述。
// 旧 route 与多路由 routes 均支持；RSS/Atom 包装器在宿主校验 items 并序列化。
// 沙箱无法访问 Workers 运行时（storage/secret/env），出网经注入的 fetchText / puppeteer.navigate。
//
// asyncify 变体在同一 wasm 模块内同时只允许一个异步动作，所有沙箱执行
// （含编译校验）经 run_in_sandbox_queue 的泳道池调度。
import { newQuickJSAsyncWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import RELEASE_ASYNCIFY from "@jitl/quickjs-wasmfile-release-asyncify";
import { script_platform } from "../lib/discovery_platform.js";
import { script_tags } from "../lib/script_tags.js";
import { DEVICE_LOG_LEVELS, MAX_DEVICE_LOG_MESSAGE_LENGTH, MAX_SCRIPT_INVOKES, MAX_SANDBOX_LANES, SCRIPT_FETCH_BYTES, SCRIPT_MODULE_ROUTE_EXPORT, SCRIPT_OUTPUT_BYTES } from "../lib/constants.js";
import { validate_image_proxy_route, validate_script_route_path } from "../lib/image_proxy.js";
import { script_output } from "../lib/script_output.js";
import { normalize_clip_snapshot } from "./clip_html.js";
import { ClipModel } from "../domain/clip.js";
import { compare_detect_snapshots, normalize_detect_snapshot, normalize_detect_previous, normalize_detect_result, DETECT_RESULT_BYTES } from "../lib/detect.js";
import { RssRoutePatternModel } from "../domain/rss_route.js";
import { SCRIPT_LOG_MAX_LINES, SCRIPT_DEBUG_LOG_MAX_BYTES, script_error_source, script_ctx_source, script_mock_source, script_result_source, script_metadata_source, script_core_source } from "./script_sources.js";
import { script_result_helpers_source } from "./script_result.js";
import { script_classes_source } from "./script_classes.js";
import { script_util_source } from "./script_util.js";
import { script_type } from "../lib/script_type.js";
import { ScriptCookiePermissionsModel } from "../domain/script_cookie_permissions.js";
import { ScriptVersionModel } from "../domain/script_version.js";
import { SandboxLanePool } from "./sandbox_lanes.js";
import { validate_config_schema, script_config_value } from "../lib/script_config.js";
// Workers 禁止运行时 fetch wasm，必须在构建期以模块形式导入（见仓库 README 的
// Cloudflare Workers 章节），再用 newVariant 注入。
import quickjs_wasm_module from "./quickjs.wasm";

// QuickJS 的 wasm 变体在模块加载期定下来，每次执行再由 get_quickjs_module() 实例化。
const quickjs_variant = newVariant(RELEASE_ASYNCIFY, {
  wasmModule: quickjs_wasm_module
});
function inject_script_globals(vm) {
  vm.runtime.setModuleLoader(name => name === "@findrss/util" ? script_util_source() : name === "@findrss/core" ? script_core_source() : {
    error: new Error("脚本不支持导入模块：" + name)
  });
  const result = vm.evalCode(script_result_helpers_source() + "\n" + script_classes_source(), "script-globals.js");
  if (result.error) {
    const message = sandbox_error_text(vm, result.error);
    result.error.dispose();
    throw new Error("内置脚本全局变量初始化失败：" + message);
  }
  result.value.dispose();
}

/**
 * 校验脚本模块并提取 route 元数据。
 * @param {string} script
 * @returns {Promise<{ error: string, metadata: Record<string, unknown> | null }>}
 */
export function compile_script_module(script) {
  return run_in_sandbox_queue(() => compile_script_module_inner(script));
}
export async function compile_script_module_inner(script) {
  if (!SCRIPT_MODULE_ROUTE_EXPORT.test(script)) {
    return {
      error: "脚本模块必须声明 export const route = { ... }",
      metadata: null
    };
  }
  try {
    const QuickJS = await get_quickjs_module();
    const runtime = QuickJS.newRuntime();
    const vm = runtime.newContext();
    try {
      inject_script_globals(vm);
      const result = await vm.evalCodeAsync(`${script}
${script_metadata_source(script_type(script))}`, "script-source.js", {
        type: "module"
      });
      if (result.error) {
        const message = script_error_source(sandbox_error_text(vm, result.error), script.split("\n").length);
        result.error.dispose();
        throw new Error("脚本模块无效：" + message);
      }
      result.value.dispose();
      try {
        while (runtime.executePendingJobs() > 0) {}
      } catch {}
      const metadata_handle = vm.getProp(vm.global, "__routeMetadataJSON");
      const metadata_json = vm.getString(metadata_handle);
      metadata_handle.dispose();
      const metadata = JSON.parse(metadata_json);
      if (metadata.version !== undefined) {
        const parsed_version = ScriptVersionModel.parse(metadata.version);
        if (!parsed_version.ok) throw new Error(parsed_version.error.message);
        metadata.version = parsed_version.model.version;
      }
      validate_config_schema(metadata.config_schema);
      metadata.permissions = ScriptCookiePermissionsModel(metadata.permissions).toValue();
      const paths = new Set();
      for (const entry of metadata.routes) {
        entry.platform = script_platform(entry.platform, {
          strict: true
        });
        entry.tags = script_tags(entry.tags, {
          strict: true
        });
        for (const maintainer of entry.maintainers) {
          if (typeof maintainer === "string") continue;
          for (const key of ["url", "avatar"]) {
            if (!maintainer[key]) continue;
            let url;
            try {
              url = new URL(maintainer[key]);
            } catch {}
            if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
              throw new Error("维护者 " + key + " 必须是无凭据的 HTTP(S) URL");
            }
          }
        }
        const route_pattern = RssRoutePatternModel(String(entry.path));
        const example_url = new URL(String(entry.example), "https://example.invalid");
        if (route_pattern.match(example_url.pathname) === null) throw new Error("route.example 与 route.path 不匹配");
        if (paths.has(entry.path)) throw new Error("route.path 重复：" + entry.path);
        paths.add(entry.path);
        validate_script_route_path(entry);
        if (entry.allowed_hosts !== undefined) validate_image_proxy_route(entry);
      }
      metadata.platform = {
        ...metadata.routes[0].platform
      };
      metadata.tags = [...metadata.routes[0].tags];
      return {
        error: "",
        metadata
      };
    } finally {
      // dispose 前必须清空 pending jobs；残留的 Promise 回调会触发
      // QuickJS 的 gc_obj_list 断言并中止 workerd。失败路径同样适用。
      try {
        while (runtime.executePendingJobs() > 0) {}
      } catch {}
      try {
        vm.dispose();
      } catch {}
      try {
        runtime.dispose();
      } catch {}
    }
  } catch (failure) {
    return {
      error: failure instanceof Error ? failure.message : String(failure),
      metadata: null
    };
  }
}

/**
 * 从沙箱 Error handle 提取 message 与 stack。两者分开返回，便于日志把
 * 「摘要」与「可定位行号的全文」分别落库。
 * @param {object} vm QuickJS 上下文
 * @param {object} error_handle 沙箱错误 handle
 * @returns {{ message: string, stack: string }}
 */
export function sandbox_error_detail(vm, error_handle) {
  let message = "";
  let stack = "";
  try {
    const message_handle = vm.getProp(error_handle, "message");
    if (vm.typeof(message_handle) === "string") message = vm.getString(message_handle);
    message_handle.dispose();
  } catch {}
  try {
    // QuickJS 对解析错误不给 stack，此处静默回退（try/catch 已能兜住）。
    const stack_handle = vm.getProp(error_handle, "stack");
    if (vm.typeof(stack_handle) === "string") stack = vm.getString(stack_handle);
    stack_handle.dispose();
  } catch {}
  let problem = null;
  try {
    const fields = {
      message
    };
    for (const key of ["name", "code"]) {
      const handle = vm.getProp(error_handle, key);
      fields[key] = vm.typeof(handle) === "string" ? vm.getString(handle) : "";
      handle.dispose();
    }
    problem = public_feed_failure(fields);
  } catch {}
  return {
    message,
    stack,
    problem
  };
}

/**
 * 从沙箱 Error handle 提取可读文本（dump 对部分宿主对象会输出 [object Object]）。
 * 有 stack 时一并带上，让模块求值/语法错误也能定位到行号。
 * @param {object} vm QuickJS 上下文
 * @param {object} error_handle 沙箱错误 handle
 * @returns {string}
 */
export function sandbox_error_text(vm, error_handle) {
  const {
    message,
    stack
  } = sandbox_error_detail(vm, error_handle);
  if (message !== "") {
    return stack !== "" && stack !== message ? message + "\n" + stack : message;
  }
  try {
    return String(vm.dump(error_handle));
  } catch {}
  return "未知错误";
}

/**
 * QuickJS 沙箱实例（asyncify 变体，支持宿主异步 fetch）。
 * 每次执行都全新 instantiate：Asyncify 的栈展开状态挂在 Emscripten 模块
 * 全局上，跨请求复用会在 workerd 中损坏（fetchText 返回 undefined、
 * dispose 时触发 gc_obj_list 断言）。WebAssembly.Module 本身不可变可复用，
 * 因此实例化成本可接受。
 */
export async function get_quickjs_module() {
  return newQuickJSAsyncWASMModuleFromVariant(quickjs_variant);
}

/**
 * 设备调用被上游拒绝（HTTP 非 2xx）时抛出，携带上游状态码。
 * /rss/ 路由据此把 402（积分不足）、409（设备不可用）等可行动原因透传给调用方，
 * 而不是统一塌成 502。错误对象无法穿过 QuickJS 沙箱，路由必须在其抛出点捕获。
 */
export class ScriptInvokeError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message, headers = {}) {
    super(message);
    this.headers = headers;
    this.name = "ScriptInvokeError";
    this.status = status;
  }
}

/**
 * 脚本执行失败，携带失败相位与沙箱 stack，供 /rss/ 路由与测试运行记录完整日志。
 * phase 取值见 SCRIPT_LOG_PHASES；lines 是失败前 ctx.log/ctx.error 已收集的行，
 * 由 execute_script_inner 在抛出前挂上。
 */
export class ScriptError extends Error {
  /**
   * @param {string} phase
   * @param {string} message
   * @param {{ message?: string, stack?: string }} [detail] 沙箱错误的 stack（可选）
   */
  constructor(phase, message, detail = {}) {
    super(message);
    this.name = "ScriptError";
    this.phase = phase;
    this.sandbox_stack = detail.stack ?? "";
    this.problem = detail.problem ?? null;
    /** @type {{ level: string, text: string }[]} */
    this.lines = [];
  }
}

/**
 * 读回沙箱内 ctx.log/ctx.error 收集的行。沙箱已限行数与字节，这里再按形状过滤，
 * 并丢掉超长单行，避免脚本直接改写 globalThis.__logLines 造成的异常放大。
 * @param {object} vm QuickJS 上下文
 * @returns {{ level: string, text: string }[]}
 */
export function sandbox_log_lines(vm, debug = false) {
  let dumped;
  try {
    const handle = vm.getProp(vm.global, "__logLines");
    dumped = vm.dump(handle);
    handle.dispose();
  } catch {
    return [];
  }
  if (!Array.isArray(dumped)) return [];
  const lines = [];
  let remaining = debug ? SCRIPT_DEBUG_LOG_MAX_BYTES : SCRIPT_LOG_MAX_LINES * MAX_DEVICE_LOG_MESSAGE_LENGTH;
  for (const item of dumped) {
    if (lines.length >= SCRIPT_LOG_MAX_LINES) break;
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    if (typeof item.text !== "string") continue;
    if (remaining <= 0) break;
    const text = item.text.slice(0, Math.min(remaining, debug ? SCRIPT_DEBUG_LOG_MAX_BYTES : MAX_DEVICE_LOG_MESSAGE_LENGTH));
    remaining -= text.length;
    lines.push({
      level: DEVICE_LOG_LEVELS.has(item.level) ? item.level : "info",
      text
    });
  }
  return lines;
}

/**
 * 把一次失败拆成日志字段。非 ScriptError（沙箱外失败，如超时）同样记录，
 * 相位回退 runtime，stack 直接取宿主 Error 的 stack。
 * @param {unknown} failure
 * @returns {{ phase: string, message: string, error_text: string, lines: { level: string, text: string }[] }}
 */
export function script_failure_fields(failure) {
  if (failure instanceof ScriptError) {
    const stack = String(failure.sandbox_stack ?? "").trim();
    return {
      phase: failure.phase,
      message: failure.message,
      error_text: stack === "" ? failure.message : failure.message + "\n" + stack,
      lines: Array.isArray(failure.lines) ? failure.lines : []
    };
  }
  if (failure instanceof Error) {
    return {
      phase: "runtime",
      message: failure.message,
      error_text: failure.stack ?? failure.message,
      lines: []
    };
  }
  return {
    phase: "runtime",
    message: String(failure),
    error_text: String(failure),
    lines: []
  };
}

// asyncify 变体在同一 wasm 模块**实例**内同时只允许一个异步动作——但
// `get_quickjs_module()` 每次执行都全新 instantiate（Asyncify 的栈展开状态挂在 Emscripten
// 模块全局上，跨请求复用会损坏），执行之间**没有共享的可变状态**，所以并发是安全的。
//
// 这里原先是一条**全局单链**，把每次脚本执行（含它内部最长 30s 的 `ctx.invoke` 设备调用）
// 串成一条线：一台设备时看不出差别，多设备时吞吐完全不涨——实测 1/4/8/16 台设备
// 总时长恒为 27s，且所有任务都落在同一台设备上（因为任何时刻只有一条任务在飞，
// 调度永远挑 device_id 最小的那台）。改成 K 条泳道后脚本执行才能真正重叠。
//
// 泳道池本体见 infra/sandbox_lanes.js（纯模块，可在 node --test 下覆盖）：
// 泳道按需创建到 MAX_SANDBOX_LANES，不预建。实测固定 8 条泳道在 16/24 台设备时
// 封顶（4.4s 不再下降），所以才要能接着扩容。
const sandbox_pool = new SandboxLanePool(MAX_SANDBOX_LANES);

/**
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
export function run_in_sandbox_queue(task) {
  return sandbox_pool.run(task);
}

/**
 * 在 QuickJS 沙箱内执行 脚本。
 * 沙箱契约：脚本模块导出 route 或 routes，handler(ctx) 返回 Result 或可序列化的路由内容
 * RSS/Atom 包装器校验 items 并序列化，脚本不接触 XML，
 * 也没有 xmlEscape（转义归渲染端，留着会诱导双重转义）。
 * ctx = { route, method, pathname, params, query, fetchText(url, options?),
 * puppeteer: { navigate(url, options?, evaluate?) },
 * invoke(method, args, options?), log(...args), error(...args) }。
 * invoke 仅在提供 invoke_impl 时可用（真实 RSS 请求），会下发设备任务并扣积分；
 * 测试运行改由 mock_ctx_source 注入 mock ctx（含 mock invoke），不触碰真实设备、
 * 不扣积分，未声明 invoke 时返回错误 Result；fetchText/invoke/cookies.get 都返回 Promise<Result>。
 * 沙箱无法访问 Workers 运行时（storage/secret/env）。
 * @param {string} script
 * @param {Record<string, unknown>} route_metadata
 * @param {((spec: { method: string, args: unknown, target_device_id?: string }) => Promise<unknown>) | null} invoke_impl
 * @param {{ method: string, pathname: string, params: Record<string, string>, query: Record<string, string> }} request_context
 * @param {unknown[]} cookies 兼容参数，已取消隐式注入；授权凭据只经 cookie_access 提供
 * @param {string} mock_ctx_source 测试运行用的 mock ctx 片段，空串表示不注入
 * @param {object | null} cookie_access 已确认的 Cookie 授权
 * @param {AbortSignal} [signal] 任务取消信号
 * @param {Function | null} [puppeteer_navigate] 宿主页面渲染能力
 * @param {number} [output_limit] 宿主输出上限；剪藏允许保存较大的静态片段
 * @returns {Promise<{ output: string, invoked: boolean, lines: { level: string, text: string }[] }>}
 *   路由返回值的 JSON 串、是否调用过设备与 ctx.log/ctx.error 收集到的行
 */
export function execute_script(script, route_metadata, invoke_impl = null, request_context = {
  method: "GET",
  pathname: "/rss/",
  params: {},
  query: {}
}, cookies = [], mock_ctx_source = "", cookie_access = null, signal, puppeteer_navigate = null, output_limit = SCRIPT_OUTPUT_BYTES) {
  return run_in_sandbox_queue(() => execute_script_inner(script, route_metadata, invoke_impl, request_context, cookies, mock_ctx_source, cookie_access, signal, puppeteer_navigate, output_limit));
}
export async function execute_script_inner(script, route_metadata, invoke_impl, request_context, cookies, mock_ctx_source, cookie_access = null, task_signal, puppeteer_navigate = null, output_limit = SCRIPT_OUTPUT_BYTES) {
  task_signal?.throwIfAborted();
  const clip_request = script_type(script, route_metadata.kind ?? route_metadata.script_type) === "clip";
  if (clip_request) output_limit = ClipModel.MAX_BYTES * 3;
  const detect_request = script_type(script, route_metadata.kind ?? route_metadata.script_type) === "detect";
  if (detect_request) output_limit = DETECT_RESULT_BYTES;
  request_context = {
    ...request_context,
    previous: normalize_detect_previous(request_context?.previous)
  };
  const QuickJS = await get_quickjs_module();
  const runtime = QuickJS.newRuntime();
  const vm = runtime.newContext();
  const promises = create_sandbox_promises(vm);
  const upstream_requests = [];
  try {
    inject_script_globals(vm);
    try {
      route_metadata = {
        ...route_metadata,
        config: route_metadata.config_schema ? script_config_value(route_metadata.config_schema, route_metadata.config) : {}
      };
    } catch (error) {
      throw new ScriptError("runtime", "脚本配置无效，请在脚本卡片中配置：" + error.message);
    }
    const get_cookies = promises.bind("cookies.get", async id_handle => {
      task_signal?.throwIfAborted();
      if (!cookie_access) throw new Error("Cookie 权限尚未获得管理员确认");
      return vm.unwrapResult(vm.evalCode("(" + JSON.stringify(await cookie_access.get(vm.getString(id_handle))) + ")"));
    });
    vm.setProp(vm.global, "__getCookies", get_cookies);
    get_cookies.dispose();
    const detect = promises.bind("detect", async (operation_handle, value_handle) => {
      task_signal?.throwIfAborted();
      const operation = vm.getString(operation_handle),
        value = JSON.parse(vm.getString(value_handle));
      const data = operation === "snapshot" ? normalize_detect_snapshot(value) : operation === "compare" ? compare_detect_snapshots(value.previous, value.current) : (() => {
        throw new Error("未知检测操作");
      })();
      return vm.newString(JSON.stringify(data));
    });
    vm.setProp(vm.global, "__detectOperation", detect);
    detect.dispose();
    const navigate = promises.bind("puppeteer.navigate", async spec_handle => {
      task_signal?.throwIfAborted();
      if (!puppeteer_navigate) throw new Error("Puppeteer 不可用，请配置 Worker 的 BROWSER 绑定或提供 puppeteer.navigate mock");
      const {
        url,
        options,
        evaluate
      } = JSON.parse(vm.getString(spec_handle));
      const value = await puppeteer_navigate(url, options, evaluate, task_signal);
      return vm.newString(JSON.stringify(value));
    });
    vm.setProp(vm.global, "__puppeteerNavigate", navigate);
    navigate.dispose();
    const fetch_text = promises.bind("fetchText", async (url_handle, options_handle) => {
      task_signal?.throwIfAborted();
      const url = vm.getString(url_handle);
      const fetch_options = options_handle ? vm.dump(options_handle) : null;
      const headers = rss_fetch_headers(fetch_options);
      const transport = fetch_options?.transport === undefined ? "fetch" : fetch_options.transport;
      if (!["fetch", "tcp"].includes(transport)) throw new Error("fetchText transport 只支持 fetch 或 tcp");
      const timeout_ms = rss_fetch_timeout(fetch_options);
      let {
        method,
        body
      } = rss_fetch_request(fetch_options);
      rss_cookie_headers(fetch_options, "");
      if (fetch_options?.douyin_sign !== undefined && typeof fetch_options.douyin_sign !== "boolean") throw new Error("douyin_sign 必须为布尔值");
      if (fetch_options?.kuaishou_sign !== undefined && typeof fetch_options.kuaishou_sign !== "boolean") throw new Error("kuaishou_sign 必须为布尔值");
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("脚本请求了非法 URL：" + url.slice(0, 200));
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("脚本只允许请求 HTTP(S) 地址");
      }
      if (headers.cookie !== undefined) throw new Error("请使用 ctx.cookies.get 和 fetchText 的 cookies 参数，禁止直接填写 Cookie 请求头");
      const cookie_handle = fetch_options?.cookies;
      if (cookie_handle && (!cookie_access || !(await cookie_access.allows(cookie_handle, parsed)))) throw new Error("Cookie 句柄无效或请求地址超出授权范围");
      if (fetch_options?.cookie_headers && !cookie_handle) throw new Error("cookie_headers 需要显式的 Cookie 句柄");
      let response;
      let signal;
      let credentials_allowed = true;
      for (let redirects = 0;; redirects += 1) {
        const request_cookie = credentials_allowed && cookie_handle ? await cookie_access.header(cookie_handle, parsed, fetch_options?.cookie_headers) : "";
        let signed_headers = {};
        let outgoing_url = parsed.toString();
        if (fetch_options?.kuaishou_sign) {
          if (parsed.origin !== 'https://www.kuaishou.com' || parsed.pathname !== '/rest/v/profile/feed' || method !== 'POST') {
            throw new Error('快手签名只允许 POST www.kuaishou.com/rest/v/profile/feed');
          }
          const sdk = await load_kuaishou_sdk();
          // fetchText 正挂起主沙箱的 Asyncify 栈，签名必须使用独立 wasm 实例。
          outgoing_url = sign_kuaishou_request(await get_quickjs_module(), sdk, {
            url: outgoing_url,
            method,
            body,
            cookie: request_cookie
          });
        }
        if (fetch_options?.douyin_sign && parsed.origin === "https://www.douyin.com") {
          const sdk = await load_douyin_sdk();
          const signed = sign_douyin_request(QuickJS, sdk, {
            url: outgoing_url,
            cookie: request_cookie,
            user_agent: headers["user-agent"]
          });
          outgoing_url = signed.url;
          signed_headers = signed.headers;
        }
        signal ||= task_signal ? AbortSignal.any([AbortSignal.timeout(timeout_ms), task_signal]) : AbortSignal.timeout(timeout_ms);
        const derived_headers = rss_cookie_headers(fetch_options, request_cookie);
        if (!credentials_allowed) for (const name of RSS_FETCH_CREDENTIAL_HEADERS) delete derived_headers[name];
        const trace = route_metadata.debug === true ? {
          method,
          host: parsed.host,
          pathname: parsed.pathname.slice(0, 1024),
          status: null,
          transport,
          credentials: {
            source: request_cookie ? "script_grant" : "none",
            headers_sent: [...(request_cookie ? ["Cookie"] : []), ...RSS_FETCH_CREDENTIAL_HEADERS.filter(name => headers[name] || signed_headers[name] || derived_headers[name])]
          }
        } : null;
        if (trace && upstream_requests.length < SCRIPT_LOG_MAX_LINES) upstream_requests.push(trace);
        try {
          response = await (transport === "tcp" ? tcp_http_fetch : fetch)(outgoing_url, {
            method,
            body,
            redirect: "manual",
            signal,
            headers: {
              ...headers,
              ...signed_headers,
              ...derived_headers,
              ...(request_cookie ? {
                Cookie: request_cookie
              } : {})
            }
          });
          if (trace) trace.status = response.status;
        } catch (failure) {
          task_signal?.throwIfAborted();
          if (!signal.aborted && public_feed_failure(failure)) throw failure;
          const timed_out = signal.aborted;
          throw Object.assign(new Error(timed_out ? "脚本上游请求超时，请稍后重试" : "脚本上游连接失败，请稍后重试"), {
            name: "FeedError",
            code: timed_out ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FETCH_FAILED"
          });
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirects >= 5) throw new Error("脚本上游重定向过多");
        const location = response.headers.get("Location");
        if (!location) throw new Error("脚本上游重定向缺少 Location");
        const next = new URL(location, parsed);
        if (response.status === 303 || [301, 302].includes(response.status) && method === "POST") {
          method = "GET";
          body = undefined;
          delete headers["content-type"];
        }
        if (next.origin !== parsed.origin) {
          if (body) throw new Error("fetchText 不允许跨 origin 重定向请求体");
          credentials_allowed = false;
          for (const name of RSS_FETCH_CREDENTIAL_HEADERS) delete headers[name];
        }
        if (cookie_handle && credentials_allowed && !(await cookie_access.allows(cookie_handle, next))) {
          credentials_allowed = false;
          for (const name of RSS_FETCH_CREDENTIAL_HEADERS) delete headers[name];
        }
        parsed = next;
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("脚本只允许请求 HTTP(S) 地址");
      }
      if (!response.ok) {
        const code = {
          401: "UPSTREAM_AUTH_REQUIRED",
          403: "UPSTREAM_ACCESS_DENIED",
          429: "UPSTREAM_RATE_LIMITED",
          504: "UPSTREAM_TIMEOUT"
        }[response.status] || "UPSTREAM_FETCH_FAILED";
        throw Object.assign(new Error(`脚本上游 ${parsed.host} 返回 HTTP ${response.status}`), {
          name: "FeedError",
          code
        });
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > SCRIPT_FETCH_BYTES) {
        throw new Error("脚本上游响应超过 10MB 限制");
      }
      const text = rss_response_text(buffer, response.headers.get("Content-Type") || "");
      // newString 使用 C 字符串，内嵌 NUL（如 X 的流式页面）会截断后续内容。
      return text.includes("\0") ? vm.unwrapResult(vm.evalCode(JSON.stringify(text), "fetch-response.js")) : vm.newString(text);
    });
    vm.setProp(vm.global, "__fetchText", fetch_text);
    fetch_text.dispose();
    let invoked = false;
    if (invoke_impl !== null) {
      let invoke_count = 0;
      const invoke_fn = promises.bind("invoke", async spec_handle => {
        task_signal?.throwIfAborted();
        invoked = true;
        invoke_count += 1;
        if (invoke_count > MAX_SCRIPT_INVOKES) {
          throw new Error("脚本调用设备次数超过上限（" + MAX_SCRIPT_INVOKES + " 次）");
        }
        const value = await invoke_impl(JSON.parse(vm.getString(spec_handle)));
        return vm.newString(JSON.stringify(value === undefined ? null : value));
      });
      vm.setProp(vm.global, "__invoke", invoke_fn);
      invoke_fn.dispose();
    }
    const {
      cookie_grant_id,
      ...sandbox_metadata
    } = route_metadata;
    const route_metadata_handle = vm.newString(JSON.stringify(sandbox_metadata));
    vm.setProp(vm.global, "__routeMetadataJSON", route_metadata_handle);
    route_metadata_handle.dispose();
    const request_context_handle = vm.newString(JSON.stringify(request_context));
    vm.setProp(vm.global, "__requestContextJSON", request_context_handle);
    request_context_handle.dispose();
    if (mock_ctx_source !== "") {
      // mock 片段单独求值，语法错误不会和脚本错误混在一起。
      const mock_result = vm.evalCode(script_mock_source(mock_ctx_source), "mock-ctx.js");
      if (mock_result.error) {
        const detail = sandbox_error_detail(vm, mock_result.error);
        mock_result.error.dispose();
        throw new ScriptError("mock", "mock ctx 无效：" + (detail.message || "未知错误"), detail);
      }
      mock_result.value.dispose();
    }
    // ctx 在独立文件求值，脚本堆栈的行号直接对应编辑器源码。
    const context_result = vm.evalCode(script_ctx_source({
      has_invoke: invoke_impl !== null,
      debug: route_metadata.debug_request === true
    }), "rss-context.js");
    if (context_result.error) {
      const detail = sandbox_error_detail(vm, context_result.error);
      context_result.error.dispose();
      throw new ScriptError("mock", detail.message, detail);
    }
    context_result.value.dispose();
    const code = script + "\n" + script_result_source();
    // module 模式支持顶层 await（async 脚本函数）；返回值是 module exports，
    // 因此脚本结果经 globalThis.__result 传出。
    const result = await vm.evalCodeAsync(code, "script-source.js", {
      type: "module"
    });
    if (result.error) {
      // 语法/模块求值失败：QuickJS 对解析错误不给 stack，属预期。
      const detail = sandbox_error_detail(vm, result.error);
      result.error.dispose();
      throw new ScriptError("module", "脚本执行失败：" + (detail.message || "未知错误"), detail);
    }
    // TLA module 的续体在 pending jobs 中推进；读取结果前必须驱动完成，
    // 否则 globalThis.__result 尚未赋值。
    await promises.drain();
    // module 体整体是 async 函数，脚本体抛出的异常只会让 eval 返回的 promise
    // 变 rejected（不写进 result.error），必须显式取回，否则会被当成空输出。
    const module_state = vm.getPromiseState(result.value);
    if (module_state.type === "rejected") {
      // handler 抛错：结果段已把 message + 脚本自身 stack 拼进文本，外层 stack
      // 只是模块包装帧，不再重复采集。
      const detail = sandbox_error_detail(vm, module_state.error);
      module_state.error.dispose();
      result.value.dispose();
      throw new ScriptError("runtime", "脚本执行失败：" + (detail.message || "未知错误"), detail);
    }
    if (module_state.type === "fulfilled" && !module_state.notAPromise) {
      module_state.value.dispose();
    }
    if (module_state.type === "pending") {
      result.value.dispose();
      throw new ScriptError("runtime", "脚本异步任务未完成");
    }
    result.value.dispose();
    const result_handle = vm.getProp(vm.global, "__result");
    let output = vm.getString(result_handle);
    result_handle.dispose();
    if (output.length === 0) {
      throw new ScriptError("output", "脚本返回了空内容");
    }
    if (output.length > output_limit) {
      throw new ScriptError("output", `脚本输出超过 ${output_limit / 1024 / 1024}MB 限制`);
    }
    // 宿主再次校验响应格式与代理白名单，防止绕过沙箱结果段。
    try {
      const value = JSON.parse(output);
      if (clip_request || value?.kind === "clip") output = JSON.stringify(normalize_clip_snapshot(value));
      if (detect_request || value?.kind === "detect") output = JSON.stringify(normalize_detect_result(value, request_context.previous));
      script_output(route_metadata, JSON.parse(output));
    } catch (failure) {
      throw new ScriptError("output", "路由返回值无效：" + (failure instanceof Error ? failure.message : String(failure)));
    }
    await cookie_access?.assert_grant();
    return {
      output,
      invoked,
      cookie_accesses: cookie_access?.records || [],
      lines: sandbox_log_lines(vm, route_metadata.debug_request === true),
      upstream_requests
    };
  } catch (failure) {
    // 失败路径也要把已经收集到的日志行带走，否则前几行 ctx.log 会随错误丢失。
    if (failure instanceof ScriptError) {
      failure.message = script_error_source(failure.message, script.split("\n").length);
      failure.sandbox_stack = script_error_source(failure.sandbox_stack, script.split("\n").length);
      failure.lines = sandbox_log_lines(vm, route_metadata.debug_request === true);
      failure.upstream_requests = upstream_requests;
      failure.cookie_accesses = cookie_access?.records || [];
      const context_handle = vm.getProp(vm.global, "__actualRequestContextJSON");
      try {
        failure.request_context = JSON.parse(vm.getString(context_handle));
      } catch {}
      context_handle.dispose();
    }
    throw failure;
  } finally {
    // dispose 前必须清空 pending jobs；残留的 Promise 回调会触发
    // QuickJS 的 gc_obj_list 断言并中止 workerd。失败路径同样适用。
    try {
      await promises.drain();
    } catch {}
    try {
      vm.dispose();
    } catch {}
    try {
      runtime.dispose();
    } catch {}
  }
}
