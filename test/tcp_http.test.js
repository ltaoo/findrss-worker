import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync, deflateSync } from "node:zlib";
import { tcp_http_fetch } from "../server/infra/tcp_http.js";
import { SCRIPT_FETCH_BYTES } from "../server/lib/constants.js";

function socket_fixture(response, { split = 17, eof = false, opened = Promise.resolve() } = {}) {
  const bytes = Buffer.isBuffer(response) ? response : Buffer.from(response);
  let controller;
  const writes = [];
  const socket = {
    closed_count: 0, opened,
    readable: new ReadableStream({ start(value) {
      controller = value;
      for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.subarray(offset, offset + split));
      if (eof) controller.close();
    } }),
    writable: new WritableStream({ write(chunk) { writes.push(Buffer.from(chunk)); } }),
    async close() { this.closed_count++; try { controller.close(); } catch {} },
  };
  const calls = [];
  return { socket, writes, calls, connect(address, options) { calls.push({ address, options }); return socket; } };
}

test("通用 TCP HTTP 支持不同站点、HTTP/HTTPS、查询参数和 UTF-8 POST，按字节计算长度", async () => {
  for (const [url, port, secureTransport] of [["https://api.example.com/post?q=a%20b", 443, "on"], ["http://another.example/post?q=a%20b", 80, "off"]]) {
    const f = socket_fixture('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nContent-Type: text/plain\r\n\r\n你好');
    const response = await tcp_http_fetch(url, { method: "POST", body: "正文", headers: {
      "User-Agent": "browser-fixture", Cookie: "session=fixture", Referer: "https://example.com/",
      Host: "ignored.example", "Content-Length": "999", "Accept-Encoding": "br",
    } }, f.connect);
    assert.equal(await response.text(), "你好");
    assert.deepEqual(f.calls, [{ address: { hostname: new URL(url).hostname, port }, options: { secureTransport } }]);
    const request = Buffer.concat(f.writes).toString();
    assert.match(request, /^POST \/post\?q=a%20b HTTP\/1.1\r\n/);
    assert.match(request, /content-length: 6\r\n/);
    assert.match(request, /accept-encoding: identity\r\n/);
    assert.match(request, /cookie: session=fixture\r\n/);
    assert.match(request, /user-agent: browser-fixture\r\n/);
    assert.doesNotMatch(request, /ignored.example|999|android/);
    assert.ok(request.endsWith("\r\n\r\n正文"));
    assert.equal(f.socket.closed_count, 1);
  }
});

test("TCP HTTP 在连接前拒绝私网、凭据、非 HTTP(S)、非标准端口和请求注入", async () => {
  const connect = () => assert.fail("非法请求不得建立连接");
  for (const url of ["http://localhost/", "http://127.1/", "http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "ftp://example.com/", "https://user:pass@example.com/", "https://example.com:8443/"]) {
    await assert.rejects(tcp_http_fetch(url, {}, connect), /公网 HTTP\(S\)/);
  }
  for (const options of [{ headers: { Cookie: "a\r\nInjected: yes" } }, { method: "DELETE" }, { body: "GET body" }]) {
    await assert.rejects(tcp_http_fetch("https://example.com", options, connect));
  }
});

test("TCP HTTP 分片解析 Content-Length、chunked/trailer、临时响应和 EOF，不等待 keep-alive 关闭", async () => {
  const cases = [
    ["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", false],
    ["HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;name=value\r\nhe\r\n3\r\nllo\r\n0\r\nX-Trailer: done\r\n\r\n", false],
    ["HTTP/1.0 200 OK\r\n\r\nhello", true],
  ];
  for (const [raw, eof] of cases) for (const split of [1, 17, 4096]) {
    const f = socket_fixture(raw, { split, eof });
    assert.equal(await (await tcp_http_fetch("https://example.com", {}, f.connect)).text(), "hello");
    assert.equal(f.socket.closed_count, 1);
  }
  for (const status of [204, 205, 302, 304, 403, 429]) {
    const f = socket_fixture(`HTTP/1.1 ${status} Result\r\nLocation: /next\r\n\r\n`);
    const response = await tcp_http_fetch("https://example.com", {}, f.connect);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("location"), "/next");
    assert.equal(await response.text(), "");
    assert.equal(f.socket.closed_count, 1);
  }
});

test("TCP HTTP 支持 gzip/deflate，压缩损坏、编码未知和解压超限均失败", async () => {
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]]) {
    const body = compress(Buffer.from("网页正文"));
    const f = socket_fixture(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Encoding: ${encoding}\r\n\r\n`), body]));
    const response = await tcp_http_fetch("https://example.com", {}, f.connect);
    assert.equal(await response.text(), "网页正文");
    assert.equal(response.headers.has("content-encoding"), false);
    assert.equal(response.headers.has("content-length"), false);
  }
  for (const [encoding, body] of [["gzip", Buffer.from("bad")], ["br", Buffer.from("bad")], ["gzip", gzipSync(Buffer.alloc(SCRIPT_FETCH_BYTES + 1))]]) {
    const f = socket_fixture(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Encoding: ${encoding}\r\n\r\n`), body]));
    await assert.rejects(tcp_http_fetch("https://example.com", {}, f.connect), error => error.code === "UPSTREAM_INVALID_RESPONSE");
    assert.equal(f.socket.closed_count, 1);
  }
});

test("TCP HTTP 连续读取小响应按需分配内存，不为每个响应预留 10MB", async t => {
  const compressed = gzipSync(Buffer.from("hello"));
  const cases = [
    [Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"), false],
    [Buffer.from("HTTP/1.0 200 OK\r\n\r\nhello"), true],
    [Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${compressed.length}\r\nContent-Encoding: gzip\r\n\r\n`), compressed]), false],
  ];
  const original = globalThis.Uint8Array;
  let allocated = 0;
  globalThis.Uint8Array = new Proxy(original, {
    construct(target, args, new_target) {
      const value = Reflect.construct(target, args, new_target);
      if (typeof args[0] === "number") allocated += value.byteLength;
      return value;
    },
  });
  t.after(() => { globalThis.Uint8Array = original; });
  for (let index = 0; index < 62; index++) {
    const [raw, eof] = cases[index % cases.length];
    const f = socket_fixture(raw, { eof });
    assert.equal(await (await tcp_http_fetch("https://example.com", {}, f.connect)).text(), "hello");
    assert.equal(f.socket.closed_count, 1);
  }
  assert.ok(allocated < SCRIPT_FETCH_BYTES, `小响应累计分配了 ${allocated} 字节`);
});

test("TCP HTTP 未知长度及压缩响应扩容后保留完整正文，支持恰好 10MB", async () => {
  for (const length of [70001, SCRIPT_FETCH_BYTES]) {
    const body = Buffer.alloc(length, 97);
    const compressed = gzipSync(body);
    const cases = [
      [Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${length.toString(16)}\r\n`), body, Buffer.from("\r\n0\r\n\r\n")]), false],
      [Buffer.concat([Buffer.from("HTTP/1.0 200 OK\r\n\r\n"), body]), true],
      [Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${compressed.length}\r\nContent-Encoding: gzip\r\n\r\n`), compressed]), false],
    ];
    for (const [raw, eof] of cases) {
      const f = socket_fixture(raw, { eof, split: 4093 });
      assert.deepEqual(Buffer.from(await (await tcp_http_fetch("https://example.com", {}, f.connect)).arrayBuffer()), body);
      assert.equal(f.socket.closed_count, 1);
    }
  }
});

test("TCP HTTP 拒绝截断、冲突分帧、畸形响应及头部/响应体超限，并关闭连接", async () => {
  const cases = [
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nshort".slice(0, -1),
    "HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxBAD\r\n0\r\n\r\n",
    "HTTP/1.1 101 Switching Protocols\r\n\r\n",
    "HTTP/1.1 200 OK\r\nBad Header: x\r\n\r\n",
    "HTTP/1.1 200 OK\nContent-Length: 0\n\n",
    "HTTP/1.1 200 OK\r\nX-Large: " + "x".repeat(65536) + "\r\n\r\n",
    `HTTP/1.1 200 OK\r\nContent-Length: ${SCRIPT_FETCH_BYTES + 1}\r\n\r\n`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${(SCRIPT_FETCH_BYTES + 1).toString(16)}\r\n`,
    "HTTP/1.1 200 OK\r\n\r\n" + "x".repeat(SCRIPT_FETCH_BYTES + 1),
  ];
  for (const raw of cases) {
    const f = socket_fixture(raw, { eof: true, split: 4096 });
    await assert.rejects(tcp_http_fetch("https://example.com", {}, f.connect), error => error.code === "UPSTREAM_INVALID_RESPONSE");
    assert.equal(f.socket.closed_count, 1);
  }
});

test("TCP HTTP 连接、读取、写入可被取消/超时中断，预先取消不会连接", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(tcp_http_fetch("https://example.com", { signal: controller.signal }, () => assert.fail("不应连接")), /cancelled/);
  for (const phase of ["connect", "read", "write"]) {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = socket_fixture("", { opened: phase === "connect" ? new Promise(() => {}) : Promise.resolve() });
    if (phase === "read") f.socket.readable = new ReadableStream({ pull() { entered(); } }, { highWaterMark: 0 });
    if (phase === "write") f.socket.writable = new WritableStream({ write() { entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const request = tcp_http_fetch("https://example.com", { signal: controller.signal }, (...args) => {
      if (phase === "connect") entered();
      return f.connect(...args);
    });
    await started;
    controller.abort(new Error("cancelled " + phase));
    await assert.rejects(request, new RegExp("cancelled " + phase));
    assert.equal(f.socket.closed_count, 1);
  }
  const f = socket_fixture("");
  const controller_2 = new AbortController();
  const timer = setTimeout(() => controller_2.abort(new DOMException("timed out", "TimeoutError")), 10);
  await assert.rejects(tcp_http_fetch("https://example.com", { signal: controller_2.signal }, f.connect), { name: "TimeoutError" });
  clearTimeout(timer);
  assert.equal(f.socket.closed_count, 1);
});

test("TCP 响应头按 RFC 7230 展开 obs-fold 续行", async () => {
  const f = socket_fixture("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Security-Policy: a;\r\n b;\r\n c\r\n" +
    "X-Frame-Options: ALLOW-FROM example.com\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
  const response = await tcp_http_fetch("https://example.com/page", {}, f.connect);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), "a; b; c");
  assert.equal(response.headers.get("x-frame-options"), "ALLOW-FROM example.com");
  assert.equal(await response.text(), "ok");
});

test("响应头首行就是续行时仍按无效响应拒绝", async () => {
  const f = socket_fixture("HTTP/1.1 200 OK\r\n Content-Security-Policy: a\r\nContent-Length: 2\r\n\r\nok");
  await assert.rejects(tcp_http_fetch("https://example.com/page", {}, f.connect), error => error.code === "UPSTREAM_INVALID_RESPONSE" && /响应头格式错误/.test(error.message));
});

test("TCP HTTP 成功或取消后不等待连接关闭握手完成", async () => {
  for (const abort of [false, true]) {
    const f = socket_fixture("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const close = f.socket.close.bind(f.socket);
    let finish_close;
    const closing = new Promise(resolve => { finish_close = resolve; });
    f.socket.close = () => { void close(); return closing; };
    const controller = new AbortController();
    const request = tcp_http_fetch("https://api.bilibili.com/x/web-interface/nav", { signal: controller.signal }, f.connect);
    if (abort) controller.abort(new Error("cancelled"));
    let immediate;
    const stalled = new Promise((_, reject) => {
      immediate = setImmediate(() => reject(new Error("等待 socket.close 导致请求未能返回")));
    });
    try {
      const result = Promise.race([request, stalled]);
      if (abort) await assert.rejects(result, /cancelled/);
      else assert.equal(await (await result).text(), "ok");
      assert.equal(f.socket.closed_count, 1);
    } finally {
      clearImmediate(immediate);
      finish_close();
    }
  }
});
