import { SCRIPT_FETCH_BYTES, SCRIPT_FETCH_TIMEOUT_MS } from "../lib/constants.js";
import { public_http_url } from "../lib/proxy_url.js";
import { rss_fetch_request } from "./rss_fetch_headers.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const max_metadata_bytes = 64 * 1024;

function invalid_response(message) {
  return Object.assign(new Error("TCP HTTP 响应无效：" + message), {
    name: "FeedError", code: "UPSTREAM_INVALID_RESPONSE",
  });
}

// 未知长度和解压响应按需扩容，避免连续小 API 响应各自占用 10MB。
function grow_buffer(bytes, required) {
  if (required <= bytes.length) return bytes;
  const expanded = new Uint8Array(Math.min(SCRIPT_FETCH_BYTES, Math.max(required, bytes.length * 2, 4096)));
  expanded.set(bytes);
  return expanded;
}

// 按 HTTP 消息边界读取，不能等待 keep-alive 连接关闭才返回。
class HttpReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array();
    this.received = 0;
    this.metadata_bytes = 0;
  }
  async take(length) {
    while (!this.buffer.length) {
      const { value, done } = await this.reader.read();
      if (done) return new Uint8Array();
      this.received += value.byteLength;
      if (this.received > SCRIPT_FETCH_BYTES + max_metadata_bytes) throw invalid_response("响应超过大小限制");
      this.buffer = value;
    }
    const part = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(part.length);
    return part;
  }
  async line() {
    const parts = [];
    for (;;) {
      const end = this.buffer.indexOf(10);
      const part = await this.take(end < 0 ? Math.max(this.buffer.length, 1) : end + 1);
      if (!part.length) throw invalid_response("响应行未完整结束");
      this.metadata_bytes += part.length;
      if (this.metadata_bytes > max_metadata_bytes) throw invalid_response("响应头或分块元数据过大");
      parts.push(decoder.decode(part));
      if (part.at(-1) === 10) break;
    }
    const line = parts.join("");
    if (!line.endsWith("\r\n")) throw invalid_response("响应行缺少 CRLF");
    return line.slice(0, -2);
  }
  async headers() {
    const pairs = [];
    for (;;) {
      const line = await this.line();
      if (!line) {
        const headers = new Headers();
        for (const [name, value] of pairs) headers.append(name, value);
        return headers;
      }
      // RFC 7230 已废弃 obs-fold，但七猫等 istio-envoy 上游仍在发续行；按空格展开为单个值。
      if (/^[ \t]/.test(line)) {
        const value = line.trim();
        if (!pairs.length || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw invalid_response("响应头格式错误");
        pairs[pairs.length - 1][1] += " " + value;
        continue;
      }
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
      if (!match || /[\x00-\x08\x0a-\x1f\x7f]/.test(match[2])) throw invalid_response("响应头格式错误");
      pairs.push([match[1], match[2]]);
    }
  }
  async body(headers) {
    const transfer = headers.get("transfer-encoding");
    const declared = headers.get("content-length");
    if (transfer && (transfer.toLowerCase() !== "chunked" || declared !== null)) throw invalid_response("不支持或冲突的响应分帧");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SCRIPT_FETCH_BYTES)) throw invalid_response("Content-Length 无效或超过 10MB");
    let bytes = new Uint8Array(declared === null ? 0 : Number(declared));
    const limit = declared === null ? SCRIPT_FETCH_BYTES : Number(declared);
    let total = 0;
    const append = part => {
      if (total + part.length > limit) throw invalid_response("响应超过 10MB 限制");
      bytes = grow_buffer(bytes, total + part.length);
      bytes.set(part, total);
      total += part.length;
    };
    const exact = async length => {
      if (length > limit - total) throw invalid_response("响应超过 10MB 限制");
      while (length > 0) {
        const part = await this.take(length);
        if (!part.length) throw invalid_response("响应体被截断");
        append(part);
        length -= part.length;
      }
    };
    if (transfer) {
      for (;;) {
        const line = await this.line();
        if (!/^[\da-f]+(?:;[^\r\n]*)?$/i.test(line)) throw invalid_response("分块长度无效");
        const length = parseInt(line.split(";")[0], 16);
        if (!length) { await this.headers(); break; }
        await exact(length);
        if (await this.line() !== "") throw invalid_response("分块缺少 CRLF");
      }
    } else if (declared !== null) {
      await exact(Number(declared));
    } else {
      for (;;) {
        const part = await this.take(SCRIPT_FETCH_BYTES + 1);
        if (!part.length) break;
        append(part);
      }
    }
    return bytes.subarray(0, total);
  }
}

async function decode_body(bytes, encoding) {
  if (!encoding || encoding === "identity") return bytes;
  if (!["gzip", "deflate"].includes(encoding)) throw invalid_response("不支持的 Content-Encoding");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(encoding)).getReader();
  let output = new Uint8Array();
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return output.subarray(0, length);
      if (length + value.length > SCRIPT_FETCH_BYTES) throw invalid_response("解压后超过 10MB 限制");
      output = grow_buffer(output, length + value.length);
      output.set(value, length);
      length += value.length;
    }
  } catch (failure) {
    void reader.cancel().catch(() => {});
    if (failure?.name === "FeedError") throw failure;
    throw invalid_response("压缩响应损坏");
  } finally {
    reader.releaseLock();
  }
}

/** 通用 HTTP(S) TCP 传输；Cookie 授权、重定向与 HTTP 状态由 fetchText 统一处理。 */
export async function tcp_http_fetch(value, options = {}, connect_fn) {
  const url = new URL(value);
  if (!public_http_url(url.origin) || url.username || url.password || url.port) {
    throw new Error("TCP 传输只允许无凭据的公网 HTTP(S) 地址及标准端口");
  }
  const target = url.pathname + url.search;
  if (target.length > 16384) throw new Error("TCP 请求地址超过 16KB 限制");
  const { method, body } = rss_fetch_request(options);
  const headers = new Headers(options.headers);
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]) headers.delete(name);
  headers.set("Host", url.host);
  headers.set("Connection", "close");
  headers.set("Accept-Encoding", "identity");
  const body_bytes = encoder.encode(body ?? "");
  if (method === "POST") headers.set("Content-Length", String(body_bytes.length));
  const request = encoder.encode(method + " " + target + " HTTP/1.1\r\n" +
    [...headers].map(([name, header]) => name + ": " + header + "\r\n").join("") + "\r\n");
  const signal = options.signal ?? AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS);
  signal.throwIfAborted();
  const connector = connect_fn ?? (await import("cloudflare:sockets")).connect;
  signal.throwIfAborted();
  const socket = connector({ hostname: url.hostname, port: url.protocol === "https:" ? 443 : 80 },
    { secureTransport: url.protocol === "https:" ? "on" : "off" });
  socket.closed?.catch(() => {});
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let on_abort;
  const aborted = new Promise((_resolve, reject) => { on_abort = () => reject(signal.reason); });
  signal.addEventListener("abort", on_abort, { once: true });
  const perform = async () => {
    await socket.opened;
    await writer.write(request);
    if (body_bytes.length) await writer.write(body_bytes);
    const http = new HttpReader(reader);
    let status, response_headers;
    do {
      const match = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?$/.exec(await http.line());
      status = Number(match?.[1]);
      if (status < 100 || status > 599 || !match || status === 101) throw invalid_response("HTTP 状态行无效");
      response_headers = await http.headers();
    } while (status < 200);
    let bytes = null;
    if (status >= 200 && status < 300 && ![204, 205].includes(status)) {
      bytes = await decode_body(await http.body(response_headers), response_headers.get("content-encoding")?.toLowerCase());
    }
    for (const name of ["content-length", "transfer-encoding", "content-encoding", "connection"]) response_headers.delete(name);
    return new Response(bytes, { status, headers: response_headers });
  };
  try {
    if (signal.aborted) on_abort();
    return await Promise.race([perform(), aborted]);
  } finally {
    signal.removeEventListener("abort", on_abort);
    // 关闭握手不能延长请求或取消的超时预算。
    try { void socket.close().catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
  }
}
