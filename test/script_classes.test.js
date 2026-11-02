import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { FeedModel } from "../server/domain/feed_format.js";

register("./support/quickjs_wasm_hook.js", import.meta.url);
const { compile_script_module, execute_script } = await import("../server/infra/script_sandbox.js");

const route_source = (body) => `
export const route = { path: "/classes", name: "基类测试", async handler(ctx) { ${body} } };
`;
async function run(source, mock_ctx = "") {
  const compiled = await compile_script_module(source);
  assert.equal(compiled.error, "");
  return execute_script(source, compiled.metadata, null, undefined, [], mock_ctx);
}

test("编译、运行和 Mock ctx 都可直接使用全局 RSSScript 与 HotRankScript", async () => {
  const source = `
class Timeline extends RSSScript {
  async fetch(ctx) {
    return Result.Ok({ title: ctx.params.global_type || "时间线", link: "https://example.com/", items: [
      { id: "old", title: "旧内容", link: "https://example.com/old", published: 1700000000 },
      { id: "unknown", title: "未知时间", link: "https://example.com/unknown" },
      { id: "new", title: "新内容", link: "https://example.com/new", published: 1700000100, content: "<p>正文</p>" },
      { id: "old", title: "重复内容", link: "https://example.com/old", published: 1700000000 },
    ] });
  }
}
class Ranking extends HotRankScript {
  async fetch() { return Result.Ok({ title: "热榜", link: "https://example.com/", entries: [
    { id: "second", title: "热度最高", link: "https://example.com/second", rank: 2, heat: { value: 900, unit: "热度", text: "900" } },
    { id: "pinned", title: "置顶", link: "https://example.com/pinned", rank: null, pinned: true, heat: { value: null, unit: "热度", text: "" } },
    { id: "first", title: "榜首", link: "https://example.com/first", rank: 1, heat: { value: 10, unit: "热度", text: "10" } },
  ] }); }
}
const timeline = new Timeline(), ranking = new Ranking();
${route_source('return { feed: (await timeline.run(ctx)).data, snapshot: (await ranking.run(ctx)).data, globals: [typeof globalThis.RSSScript, typeof globalThis.HotRankScript] };')}`;
  const result = await run(source, '({ params: { global_type: typeof RSSScript } })');
  const { feed, snapshot, globals } = JSON.parse(result.output);
  assert.deepEqual(globals, ["function", "function"]);
  assert.equal(feed.title, "function");
  assert.deepEqual(feed.items.map(item => item.id), ["new", "old", "unknown"]);
  assert.equal(feed.items[0].published, "2023-11-14T22:15:00.000Z");
  assert.equal(feed.items[0].content, "<p>正文</p>");
  assert.equal(feed.items[2].published, undefined);
  assert.ok(FeedModel.fromValue(feed).render("rss").includes("&lt;p&gt;正文&lt;/p&gt;"));
  assert.deepEqual(snapshot.entries.map(item => item.id), ["pinned", "first", "second"]);
  assert.equal(snapshot.kind, "hot_rank");
  assert.ok(Number.isFinite(Date.parse(snapshot.observed_at)));
  assert.equal("items" in snapshot, false);
  assert.ok(snapshot.entries.every(item => !("published" in item)));
  assert.match(result.lines.map(line => line.text).join("\n"), /RSS 内容完成[\s\S]*热榜快照完成/);
});

test("基类保留时间及排名校验；每次沙箱执行相互隔离，旧脚本仍可自行声明同名类", async () => {
  for (const [base, payload, message] of [
    ["RSSScript", { title: "时间线", link: "https://example.com/", items: [{ id: "1", title: "内容", link: "https://example.com/1", published: "invalid-date" }] }, /时间无效/],
    ["HotRankScript", { title: "热榜", link: "https://example.com/", entries: [{ id: "1", title: "内容", link: "https://example.com/1", rank: 0, heat: { value: 1, unit: "热度", text: "1" } }] }, /正整数排名/],
  ]) {
    await assert.rejects(run(`class Example extends ${base} { async fetch() { return Result.Ok(${JSON.stringify(payload)}); } }\n`
      + route_source("return new Example().run(ctx);")), message);
  }
  await run('RSSScript.prototype.fetch = async () => Result.Ok({ title: "本次修改", link: "https://example.com/", items: [] });\n'
    + route_source("return new RSSScript().run(ctx);"));
  await assert.rejects(run(route_source("return new RSSScript().run(ctx);")), /子类必须实现/);
  const legacy = await run('export class RSSScript { run() { return { legacy: true }; } }\n'
    + route_source("return new RSSScript().run(ctx);"));
  assert.equal(JSON.parse(legacy.output).legacy, true);
});

test("未知排名保留上游次序，RSS 基类保留媒体和真实源更新时间", async () => {
  const result = await run(`
class Ranking extends HotRankScript {
  async fetch() { return Result.Ok({ title: '快照', link: 'https://example.com/', entries:
    ['second', 'unknown', 'first', 'pinned'].map((id, index) => ({ id, title: id, link: 'https://example.com/' + id,
      rank: [2, null, 1, null][index], pinned: id === 'pinned', heat: { value: null, unit: '热度', text: '' } })) }); }
}
class MediaFeed extends RSSScript {
  async fetch() { return Result.Ok({ id: 'source', title: '媒体', link: 'https://example.com/', language: '',
    updated: '2026-10-14T00:00:00Z', extra: { source: 'account' }, items: [{ id: 'post', title: '内容',
      link: 'https://example.com/post', published: '2026-10-13T00:00:00Z',
      images: ['https://example.com/photo'], live_photos: [{ image: 'https://example.com/photo', key: 'k' }],
      type: 'gallery', media_group: true, extra: { platform: 'test' } }] }); }
}
${route_source('return { snapshot: (await new Ranking().run(ctx)).data, feed: (await new MediaFeed().run(ctx)).data };')}`);
  const { snapshot, feed } = JSON.parse(result.output);
  assert.deepEqual(snapshot.entries.map(entry => entry.id), ['pinned', 'second', 'unknown', 'first']);
  assert.equal(snapshot.entries[2].rank, null);
  assert.equal(feed.id, 'source');
  assert.equal(feed.language, '');
  assert.equal(feed.updated, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(feed.extra, { source: 'account' });
  assert.deepEqual(feed.items[0].images, ['https://example.com/photo']);
  assert.equal(feed.items[0].live_photos[0].key, 'k');
  assert.equal(feed.items[0].media_group, true);
  assert.equal(feed.items[0].type, 'gallery');
  assert.deepEqual(feed.items[0].extra, { platform: 'test' });
});

test("百度热榜和视频号示例通过真实 QuickJS 编译及内置自检，无需定义或导入基类", async () => {
  for (const filename of ["baidu_hot_rank.js", "wechat_channels_rss.js"]) {
    const source = await readFile(new URL("../examples/script-classes/" + filename, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:export\s+)?class\s+(?:RSSScript|HotRankScript)\b/);
    const result = await run(source + `
const original_handler = route.handler;
route.handler = () => { route.handler = original_handler; return self_check(); };`);
    assert.match(JSON.parse(result.output), /自检通过/);
  }
});

test("百度示例的请求失败、JSON/榜单校验和可见列表回退均使用 Result", async () => {
  const source = await readFile(new URL("../examples/script-classes/baidu_hot_rank.js", import.meta.url), "utf8");
  const result = await run(source + `
route.handler = async () => {
  const failed = Result.Err("抓取失败", "UPSTREAM_TIMEOUT");
  const propagated = await script.fetch({ log() {}, fetchText: async () => failed });
  const invalid = [
    '<textarea id="hotsearch_data">{broken}</textarea>',
    '<textarea id="hotsearch_data">{"hotsearch":[{"card_title":"标题","index":"bad"}]}</textarea>',
    '<html>访问验证</html>',
  ];
  const results = [];
  for (const html of invalid) results.push(await script.fetch({ log() {}, fetchText: async () => Result.Ok(html) }));
  const fallback = await script.run({ log() {}, fetchText: async () => Result.Ok(
    '<li class="hotsearch-item" data-index="1"><span class="title-content-title">新闻 &amp; 热榜</span></li>') });
  return Result.Ok({ same: propagated === failed, results, fallback,
    decoded: utils.decode_html("&amp; &#65; &#x1F600; &#0; &#1114112;") });
};`);
  const value = JSON.parse(result.output);
  assert.equal(value.same, true);
  for (const failure of value.results) {
    assert.equal(failure.data, null);
    assert.equal(failure.error.code, "UPSTREAM_INVALID_RESPONSE");
  }
  assert.equal(value.decoded, "& A 😀 &#0; &#1114112;");
  assert.equal(value.fallback.error, null);
  assert.equal(value.fallback.data.entries[0].title, "新闻 & 热榜");
  assert.equal(value.fallback.data.entries[0].rank, 1);
});

test("视频号示例显式返回参数、上游回包及条目校验失败，并透传 invoke Result", async () => {
  const source = await readFile(new URL("../examples/script-classes/wechat_channels_rss.js", import.meta.url), "utf8");
  const result = await run(source + `
route.handler = async () => {
  const failed = Result.Err("设备不可用", "DEVICE_UNAVAILABLE");
  const mock = { params: { account: "example@finder" }, query: {}, log() {}, invoke: async () => failed };
  const propagated = await script.fetch(mock);
  const missing = await script.fetch({ ...mock, params: {} });
  const invalid = [
    { BaseResponse: { Ret: 1, ErrMsg: { String: "上游拒绝" } } },
    {}, { object: [{ id: 9007199254740992 }] }, { object: [{}] },
    { object: [{ id: "bad-cover", object_desc: { media: [{ cover_url: "javascript:bad" }] } }] },
    { object: [{ id: "bad-video", object_desc: { media_type: 4, media: [{ url: "http://example.com/video" }] } }] },
  ];
  const results = [];
  for (const data of invalid) results.push(await script.fetch({ ...mock, invoke: async () => Result.Ok(data) }));
  return Result.Ok({ same: propagated === failed, missing, results });
};`);
  const value = JSON.parse(result.output);
  assert.equal(value.same, true);
  assert.equal(value.missing.error.code, "INVALID_PARAMETER");
  for (const failure of value.results) {
    assert.equal(failure.data, null);
    assert.equal(failure.error.code, "UPSTREAM_INVALID_RESPONSE");
  }
});

test("RSS 基类保留原帖引用、归一化子项时间，循环引用只保留标识且不影响父项排序", async () => {
  const result = await run(`
class SocialFeed extends RSSScript {
  async fetch() {
    const parent = { id: 'reply', kind: 'reply', type: 'video', title: '回复', link: 'https://example.com/reply', published: 1700000000 };
    const original = { id: 'original', kind: 'post', title: '原帖', link: 'https://example.com/original', published: 1700000100 };
    parent.references = [{ relation: 'reply', item: original }];
    original.references = [{ relation: 'quote', item: parent }];
    return Result.Ok({ title: '源', link: 'https://example.com/', items: [parent] });
  }
}
${route_source('return new SocialFeed().run(ctx);')}`);
  const feed = JSON.parse(result.output);
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kind, 'reply');
  assert.equal(feed.items[0].type, 'video');
  assert.equal(feed.updated, '2023-11-14T22:13:20.000Z');
  const reference = feed.items[0].references[0];
  assert.equal(reference.id, 'original');
  assert.equal(reference.item.published, '2023-11-14T22:15:00.000Z');
  assert.equal(reference.item.references[0].id, 'reply');
  assert.equal(reference.item.references[0].item, undefined);
});

test("@findrss/core 以命名导出提供基类与 Result，可与全局和 @findrss/util 共用", async () => {
  const result = await run(`
import { RSSScript, HotRankScript, ClipScript, DetectScript, Result } from "@findrss/core";
import { utils } from "@findrss/util";
class CoreFeed extends RSSScript {
  async fetch(ctx) {
    return Result.Ok({ title: utils.decode_html("模块 &amp; 基类"), link: "https://example.com/",
      items: [{ id: "core", title: "核心导入", link: "https://example.com/core", published: 1700000000 }] });
  }
}
class CoreRank extends HotRankScript {
  async fetch() { return Result.Ok({ title: "热榜", link: "https://example.com/", entries: [
    { id: "one", title: "条目", link: "https://example.com/one", rank: 1,
      heat: { value: 10, unit: "热度", text: "10" } }] }); }
}
${route_source(`const feed = await new CoreFeed().run(ctx);
  return Result.Ok({ feed: feed.data, snapshot: (await new CoreRank().run(ctx)).data,
    same: [RSSScript === globalThis.RSSScript, HotRankScript === globalThis.HotRankScript,
      ClipScript === globalThis.ClipScript, DetectScript === globalThis.DetectScript,
      Result === globalThis.Result] });`)}`);
  const value = JSON.parse(result.output);
  assert.equal(value.feed.title, "模块 & 基类");
  assert.deepEqual(value.feed.items.map(item => item.id), ["core"]);
  assert.deepEqual(value.snapshot.entries.map(entry => entry.id), ["one"]);
  assert.deepEqual(value.same, [true, true, true, true, true]);
});
