import { realtime_fixture } from "./realtime_fixture.mjs";
import { list_runtime, paged_fixture } from "./list_fixture.mjs";
import { PollPolicyView, poll_policy_label } from "../components/poll_policy.js";
import { page_source } from "./page_source.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { resolveObjectURL } from "node:buffer";
import { ListPaginationModel, PaginationModel, PaginationView } from "../components/pagination.js";
import * as platform_helpers from "../components/discovery_platform.js";
import { RssRoutePatternModel } from "../../server/domain/rss_route.js";
import { PollPolicyModel } from "../components/poll_policy.model.js";

function modal_model(fetch, { confirm = () => true, notify = () => {}, document = { querySelector: () => null },
  background_tasks = async () => Response.json({ tasks: [] }), timers = { setTimeout: handler => handler(), clearTimeout() {} } } = {}) {
  const ref = value => ({ value, set(next) { this.value = next; }, as(next) { this.value = next; } });
  const context = vm.createContext({ ...platform_helpers, PollPolicyView, poll_policy_label, PollPolicyModel, RssRoutePatternModel, ListPaginationModel, PaginationModel, PaginationView, URL, File, Blob, document, window: {
    FindRSSAdminUI: { ...list_runtime, DOM: {}, notify, ref, refarr: ref, computed: (source, map) => ({ get value() { return map(source.value); } }), combine: (sources, map) => ({ get value() { return map(Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.value]))); } }) },
    FindRSSAdminRealtime: timers.realtime, confirm, ...timers, FindRSSAdminShell: {}, FindRSSAdminPages: {}, FindRSSAdminAuth: { fetch: async (url, options) =>
      url.startsWith("/admin/api/background-tasks?") ? background_tasks(url, options || {}) : paged_fixture(await fetch(url, options || {}), url) },
  } });
  vm.runInContext(page_source("discovery.js") + "\nglobalThis.model = DiscoveryAdminViewModel();", context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.model.state.platforms.value)), [{ id: "website", label: "网页", icon: "" }]);
  return context.model;
}

test("订阅源列表和编辑头像保留新的公开对象路径，并兼容旧 API 地址", async () => {
  const urls = ["/public/avatar/one/object-1", "/api/avatar/two?v=123"];
  const model = modal_model(async () => Response.json({ sources: urls.map((avatar_url, index) => ({
    id: String(index), title: "源", feed_url: "https://example.com/feed/" + index, avatar_url,
  })) }));
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.sources.value, source => source.avatar_url), urls);
  model.methods.edit_source("0");
  assert.equal(model.editing_source.value.avatar_url, urls[0]);
});

test("社媒主页新增保存、编辑回填与清空，关闭表单清除草稿，关键词可检索主页", async () => {
  const writes = [];
  const notifications = [];
  let source = { id: "one", title: "源", feed_url: "{{hostname}}/rss/example/one", enabled: true };
  const model = modal_model(async (url, options) => {
    if (!options?.body) return Response.json(url.includes("/scripts") ? { scripts: [] } : { sources: [source] });
    const body = JSON.parse(options.body);
    writes.push({ method: options.method, body });
    source = { ...source, ...body };
    return Response.json({ source });
  }, { notify: message => notifications.push(message) });
  model.methods.create_source();
  model.methods.set_draft("title", "源");
  model.methods.set_draft("feed_url", source.feed_url);
  model.methods.set_draft("social_url", " https://x.com/unique-home ");
  await model.methods.save_source();
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].body.require_token, true);
  assert.equal(writes[0].body.credit_cost, 1);
  assert.deepEqual(notifications, ["源 已保存。"]);
  assert.equal(writes[0].body.social_url, "https://x.com/unique-home");
  assert.equal(model.state.draft_social_url.value, "");
  await model.methods.set_filter("query", "unique-home");
  assert.equal(model.visible_sources.value.length, 1);
  model.methods.edit_source("one");
  assert.equal(model.state.draft_social_url.value, "https://x.com/unique-home");
  model.methods.set_draft("social_url", "");
  await model.methods.save_source();
  assert.equal(writes[1].method, "PATCH");
  assert.deepEqual(notifications, ["源 已保存。", "源 已保存。"]);
  assert.equal(writes[1].body.social_url, "");
  assert.equal(model.visible_sources.value.length, 0);
  model.methods.create_source();
  model.methods.set_draft("social_url", "https://x.com/draft");
  model.methods.close_form();
  assert.equal(model.state.draft_social_url.value, "");
});

test("多个社媒主页保存时去空去重，编辑保留全部主页，清空后不恢复旧首项", async () => {
  const writes = [];
  let source = { id: "multi", title: "源", feed_url: "https://example.com/feed.xml", enabled: true };
  const model = modal_model(async (url, options) => {
    if (!options.body) return Response.json(url.includes("/scripts") ? { scripts: [] } : { sources: [source] });
    const body = JSON.parse(options.body);
    writes.push(body);
    source = { ...source, ...body };
    return Response.json({ source });
  });
  const social_urls = ["https://x.com/one", "https://www.douyin.com/user/two"];
  model.methods.create_source();
  model.methods.set_draft("title", source.title);
  model.methods.set_draft("feed_url", source.feed_url);
  model.methods.set_draft("social_urls", [" " + social_urls[0] + " ", "", social_urls[1], social_urls[0]]);
  await model.methods.save_source();
  assert.deepEqual(writes[0].social_urls, social_urls);
  model.methods.edit_source(source.id);
  assert.deepEqual(Array.from(model.state.draft_social_urls.value), social_urls);
  model.methods.set_draft("social_urls", []);
  await model.methods.save_source();
  assert.deepEqual(writes[1].social_urls, []);
  assert.equal(writes[1].social_url, "");
  model.methods.edit_source(source.id);
  assert.deepEqual(Array.from(model.state.draft_social_urls.value), []);
  model.methods.close_form();
  assert.deepEqual(Array.from(model.state.draft_social_urls.value), []);
});

test("多主页 JSON 导出后重新导入保留全部地址和顺序", async () => {
  const social_urls = ["https://x.com/one", "https://www.douyin.com/user/two"];
  let sources = [{ id: "multi", title: "源", feed_url: "https://example.com/feed.xml", social_urls }];
  const writes = [];
  let downloaded;
  const document = { querySelector: () => null, createElement: () => ({
    setAttribute() {}, click() { downloaded = resolveObjectURL(this.href).text(); },
  }) };
  const model = modal_model(async (_, options) => {
    if (!options.body) return Response.json({ sources });
    const source = JSON.parse(options.body);
    writes.push(source);
    sources.push({ ...source, id: "imported" });
    return Response.json({ source: sources.at(-1) });
  }, { document });
  await model.methods.export_sources();
  assert.equal(model.state.list_error.value, "");
  const text = await downloaded;
  assert.deepEqual(JSON.parse(text).sources[0].social_urls, social_urls);
  sources = [];
  model.methods.open_import();
  model.methods.set_import_text(text);
  await model.methods.import_sources();
  assert.deepEqual(writes[0].social_urls, social_urls);
  assert.equal(writes[0].social_url, social_urls[0]);
});

function task_timers() {
  const pending = new Map(), realtime = realtime_fixture();
  return { pending, realtime,
    setTimeout() { assert.fail("任务状态不能启动轮询"); }, clearTimeout() {},
    tick() { return realtime.emit({ type: "background-tasks.changed", ids: [] }); },
  };
}

test("重新进入、翻页、修改条数和搜索后批量恢复当前页的任务 loading", async t => {
  const sources = Array.from({ length: 25 }, (_, index) => ({ id: "source-" + index, title: "源 " + index, enabled: true }));
  const calls = [], timers = task_timers();
  const model = modal_model(async () => Response.json({ sources }), { timers,
    background_tasks: async url => {
      const ids = new URL(url, "https://admin").searchParams.get("source_ids").split(",");
      calls.push(ids);
      return Response.json({ tasks: ids.filter(id => ["source-1", "source-21"].includes(id))
        .map(source_id => ({ id: "task-" + source_id, source_id, status: source_id === "source-1" ? "queued" : "running" })) });
    },
  });
  t.after(() => model.methods.destroy());
  await model.methods.start();
  assert.deepEqual(calls[0], sources.slice(0, 20).map(source => source.id));
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["source-1"]);
  assert.equal(await model.methods.refresh_snapshot("source-1"), false);
  assert.equal(timers.pending.size, 0);
  await model.pagination.set_page(1);
  assert.deepEqual(calls[1], sources.slice(20).map(source => source.id));
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["source-21"]);
  assert.equal(timers.pending.size, 0);
  await model.pagination.set_page_size(10);
  assert.deepEqual(calls[2], sources.slice(0, 10).map(source => source.id));
  await model.methods.set_filter("query", "源 21");
  assert.deepEqual(calls[3], ["source-21"]);
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["source-21"]);
  await model.methods.set_filter("query", "无匹配");
  assert.equal(calls.length, 4);
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
  assert.equal(timers.pending.size, 0);
});

test("任务变化推送更新快照且保持页码、筛选和勾选", async t => {
  const timers = task_timers();
  let active = 2, saved_at = 10, list_calls = 0;
  const model = modal_model(async () => {
    list_calls++;
    return Response.json({ sources: Array.from({ length: 25 }, (_, index) => ({
      id: "source-" + index, title: "源 " + index, enabled: true,
      cache: { status: "fresh", refreshing: active > 0 }, snapshot: { saved_at, articles: [] },
    })) });
  }, { timers, background_tasks: async () => Response.json({ tasks: Array.from({ length: active }, (_, index) => ({
    id: "task-" + index, source_id: "source-21", status: "running",
  })) }) });
  t.after(() => model.methods.destroy());
  await model.methods.start();
  await model.pagination.set_page(1);
  model.methods.toggle_selection("source-21");
  active = 1;
  await timers.tick();
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["source-21"]);
  assert.equal(list_calls, 2);
  active = 0;
  saved_at = 50;
  await timers.tick();
  assert.equal(list_calls, 3);
  assert.equal(model.pagination.page.value, 1);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["source-21"]);
  assert.equal(model.state.filter_status.value, "enabled");
  assert.equal(model.state.sources.value[1].snapshot.saved_at, 50);
  assert.equal(model.state.sources.value[1].cache.refreshing, false);
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
  assert.equal(timers.pending.size, 0);
});

test("任务推送不会清除本页未完成的刷新请求，失败后下次推送可重试", async t => {
  const timers = task_timers();
  let finish, offline = false, active = true;
  const model = modal_model(async url => url.endsWith("/snapshot") ? new Promise(resolve => { finish = resolve; })
    : Response.json({ sources: [{ id: "one", title: "源" }, { id: "two", title: "另一源" }] }),
  { timers, background_tasks: async () => offline ? Response.json({ error: "离线" }, { status: 503 })
    : Response.json({ tasks: active ? [{ source_id: "two", status: "running" }] : [] }) });
  t.after(() => model.methods.destroy());
  await model.methods.start();
  const pending = model.methods.refresh_snapshot("one");
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value).sort(), ["one", "two"]);
  offline = true;
  await timers.tick();
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value).sort(), ["one", "two"]);
  assert.match(model.state.list_error.value, /后台任务加载失败：离线/);
  assert.equal(timers.pending.size, 0);
  offline = false;
  active = false;
  await timers.tick();
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["one"]);
  finish(Response.json({ snapshot: { saved_at: 100, articles: [], error: "" } }));
  await pending;
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
});

test("搜索和卸载时忽略迟到的任务响应，卸载取消订阅", async () => {
  const timers = task_timers(), pending = [];
  const model = modal_model(async () => Response.json({ sources: [
    { id: "one", title: "第一源" }, { id: "two", title: "第二源" },
  ] }), { timers, background_tasks: () => new Promise(resolve => pending.push(resolve)) });
  const first = model.methods.start();
  await new Promise(setImmediate);
  const latest = model.methods.set_filter("query", "第二源");
  pending[0](Response.json({ tasks: [{ source_id: "one", status: "running" }] }));
  await first;
  await new Promise(setImmediate);
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
  pending[1](Response.json({ tasks: [{ source_id: "two", status: "running" }] }));
  await latest;
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["two"]);
  assert.equal(timers.pending.size, 0);
  await timers.tick();
  model.methods.destroy();
  pending[2](Response.json({ tasks: [{ source_id: "one", status: "running" }] }));
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["two"]);
  assert.equal(timers.pending.size, 0);
});

test("补抓全局逾期源只提交一次，成功后保留分页、筛选、勾选并展示计数", async () => {
  const calls = [], notifications = [];
  let finish;
  const sources = Array.from({ length: 25 }, (_, index) => ({ id: String(index), title: "源 " + index, enabled: true, source_type: "website" }));
  const model = modal_model(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/recover-overdue")) return new Promise(resolve => { finish = resolve; });
    return Response.json({ sources });
  }, { notify: message => notifications.push(message) });
  await model.methods.set_filter("query", "源");
  await model.pagination.set_page(1);
  model.methods.toggle_selection("20");
  const pending = model.methods.recover_overdue();
  assert.equal(model.state.recovery_busy.value, true);
  assert.equal(await model.methods.recover_overdue(), false);
  const submitted = calls.filter(call => call.options.method === "POST");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].url, "/admin/api/discovery/sources/recover-overdue");
  assert.equal(submitted[0].options.body, undefined, "由后端筛选全局逾期源，不提交当前页或勾选 ID");
  finish(Response.json({ matched_count: 3, queued_count: 2, skipped_count: 1 }, { status: 202 }));
  assert.equal(await pending, true);
  assert.equal(model.state.recovery_busy.value, false);
  assert.equal(model.pagination.page.value, 1);
  assert.equal(model.state.query.value, "源");
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["20"]);
  assert.match(model.state.recovery_message.value, /已提交 2 个补抓任务，跳过 1 个/);
  assert.equal(notifications.at(-1), model.state.recovery_message.value);
});

test("补抓提交失败显示错误并允许重试，没有匹配时显示空结果", async () => {
  let fail = true;
  const model = modal_model(async url => url.endsWith("/recover-overdue")
    ? fail ? Response.json({ error: "服务不可用" }, { status: 503 })
      : Response.json({ matched_count: 0, queued_count: 0, skipped_count: 0 }, { status: 202 })
    : Response.json({ sources: [] }));
  assert.equal(await model.methods.recover_overdue(), false);
  assert.equal(model.state.recovery_busy.value, false);
  assert.equal(model.state.list_error.value, "补抓提交失败：服务不可用");
  assert.equal(model.state.recovery_message.value, "");
  fail = false;
  assert.equal(await model.methods.recover_overdue(), true);
  assert.equal(model.state.list_error.value, "");
  assert.equal(model.state.recovery_message.value, "没有逾期 5 小时以上的订阅源。");
});

test("手动刷新保持加载状态，完成后更新当前记录的快照、缓存与头像", async () => {
  const snapshot = { saved_at: 123, articles: [{ title: "旧文章" }] };
  let finish;
  const model = modal_model(async (url, options) => {
    if (!url.endsWith("/snapshot")) return Response.json({ sources: [{ id: "one", title: "源", snapshot }, { id: "two", title: "其他源", snapshot }] });
    assert.equal(options.headers.Prefer, undefined);
    return new Promise(resolve => { finish = resolve; });
  });
  await model.methods.refresh_list();
  const pending = model.methods.refresh_snapshot("one");
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["one"]);
  assert.equal(model.state.sources.value[0].snapshot.saved_at, 123);
  finish(Response.json({ snapshot: { saved_at: 456, articles: [{ title: "新文章" }], error: "" },
    avatar_url: "/api/avatar/one?v=456",
    cache: { status: "fresh", saved_at: 456 }, next_snapshot_at: 789, poll_effective: { mode: "interval", interval: 300 } }));
  assert.equal(await pending, true);
  assert.equal(model.state.sources.value[0].snapshot.saved_at, 456);
  assert.equal(model.state.sources.value[0].snapshot.articles[0].title, "新文章");
  assert.equal(model.state.sources.value[0].cache.saved_at, 456);
  assert.equal(model.state.sources.value[0].avatar_url, "/api/avatar/one?v=456");
  assert.equal(model.state.sources.value[0].next_snapshot_at, 789);
  assert.equal(model.state.sources.value[0].poll_effective.interval, 300);
  assert.equal(model.state.sources.value[1].snapshot.saved_at, 123);
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
});

test("刷新返回排队任务时保留旧快照与选择，推送完成后更新记录", async t => {
  for (const status of [200, 202]) {
    await t.test(String(status), async t => {
      const timers = task_timers();
      let task_status = "", posts = 0, reads = 0;
      const model = modal_model(async (url, options) => {
        if (url.endsWith("/snapshot")) {
          posts++;
          return Response.json({ task: { id: "task-one", source_id: "one", status: task_status } }, { status });
        }
        reads++;
        const saved_at = task_status === "completed" ? 456 : 123;
        return Response.json({ sources: [{ id: "one", title: "源", enabled: true,
          snapshot: { saved_at, articles: [{ title: saved_at === 456 ? "新文章" : "旧文章" }], error: "" },
          cache: { status: "fresh", saved_at }, avatar_url: "/public/avatar/one/" + saved_at,
        }] });
      }, { timers, background_tasks: async () => Response.json({ tasks: ["queued", "running"].includes(task_status)
        ? [{ id: "task-one", source_id: "one", status: task_status }] : [] }) });
      t.after(() => model.methods.destroy());
      await model.methods.start();
      task_status = "queued";
      model.methods.toggle_selection("one");
      const previous = model.state.sources.value[0];
      assert.equal(await model.methods.refresh_snapshot("one"), true);
      assert.equal(model.state.sources.value[0], previous);
      assert.equal(model.state.sources.value[0].snapshot.saved_at, 123);
      assert.equal(model.state.snapshot_errors.value.get("one"), "");
      assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["one"]);
      assert.deepEqual(Array.from(model.state.selected_ids.value), ["one"]);
      assert.equal(await model.methods.refresh_snapshot("one"), false);
      assert.equal(posts, 1);
      task_status = "running";
      await timers.tick();
      assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["one"]);
      const previous_reads = reads;
      task_status = "completed";
      await timers.tick();
      assert.equal(reads, previous_reads + 1);
      assert.equal(model.state.sources.value[0].snapshot.articles[0].title, "新文章");
      assert.equal(model.state.sources.value[0].cache.saved_at, 456);
      assert.equal(model.state.sources.value[0].avatar_url, "/public/avatar/one/456");
      assert.equal(model.state.snapshot_refreshing.value.length, 0);
      assert.deepEqual(Array.from(model.state.selected_ids.value), ["one"]);
    });
  }
});

test("刷新任务在响应返回前已完成时立即更新列表，不依赖后续推送", async () => {
  let completed = false;
  const model = modal_model(async url => {
    if (url.endsWith("/snapshot")) {
      completed = true;
      return Response.json({ task: { id: "task-one", source_id: "one", status: "queued" } });
    }
    return Response.json({ sources: [{ id: "one", snapshot: {
      saved_at: completed ? 456 : 123, articles: [], error: "",
    } }] });
  });
  await model.methods.refresh_list();
  assert.equal(await model.methods.refresh_snapshot("one"), true);
  assert.equal(model.state.sources.value[0].snapshot.saved_at, 456);
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
  assert.equal(model.state.snapshot_errors.value.get("one"), "");
});

test("刷新响应缺少快照和任务时保留旧数据并提示错误", async () => {
  const model = modal_model(async url => Response.json(url.endsWith("/snapshot") ? {} : {
    sources: [{ id: "one", snapshot: { saved_at: 123, articles: [], error: "" } }],
  }));
  await model.methods.refresh_list();
  const previous = model.state.sources.value[0];
  assert.equal(await model.methods.refresh_snapshot("one"), false);
  assert.equal(model.state.sources.value[0], previous);
  assert.equal(model.state.snapshot_errors.value.get("one"), "快照刷新响应缺少快照或任务信息");
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
});

test("公开开关只更新当前行，不重新加载列表并保留分页、筛选和选择", async () => {
  const sources = Array.from({ length: 25 }, (_, index) => ({
    id: String(index), title: "源 " + index, enabled: true, require_token: true,
  }));
  const calls = [];
  let finish;
  const model = modal_model((url, options) => {
    calls.push({ url, options });
    if (options.method !== "PATCH") return Response.json({ sources });
    const id = url.split("/").at(-1);
    return new Promise(resolve => { finish = () => resolve(Response.json({
      source: { ...sources.find(source => source.id === id), ...JSON.parse(options.body), updated_at: 123 },
    })); });
  });
  await model.methods.set_filter("visibility", "all");
  await model.pagination.set_page(1);
  model.methods.toggle_selection("20");
  const untouched = model.state.sources.value[1];
  calls.length = 0;

  for (const is_public of [true, false]) {
    const pending = model.methods.set_source_public("20", is_public);
    assert.equal(model.state.loading.value, false);
    assert.deepEqual(Array.from(model.state.source_updating.value), ["20"]);
    assert.equal(await model.methods.set_source_public("20", is_public), false, "阻止重复提交");
    finish();
    assert.equal(await pending, true);
    assert.equal(model.state.sources.value[0].require_token, !is_public);
    assert.equal(model.state.sources.value[0].updated_at, 123);
    assert.equal(model.state.sources.value[1], untouched);
    assert.equal(model.state.sources.value.length, 5);
    assert.equal(model.state.loading.value, false);
    assert.equal(model.state.source_updating.value.length, 0);
    assert.equal(model.pagination.page.value, 1);
    assert.equal(model.pagination.state.value.total, 25);
    assert.equal(model.state.filter_visibility.value, "all");
    assert.deepEqual(Array.from(model.state.selected_ids.value), ["20"]);
  }
  assert.deepEqual(calls.map(call => [call.url, call.options.method, JSON.parse(call.options.body)]), [
    ["/admin/api/discovery/sources/20", "PATCH", { require_token: false }],
    ["/admin/api/discovery/sources/20", "PATCH", { require_token: true }],
  ]);
});

test("公开开关保存失败保留原状态，显示错误并允许重试，不重新加载列表", async () => {
  let fail = true;
  const calls = [];
  const source = { id: "one", title: "源", enabled: true, require_token: true };
  const model = modal_model((url, options) => {
    calls.push(options.method || "GET");
    if (options.method !== "PATCH") return Response.json({ sources: [source] });
    return fail ? Response.json({ error: "保存失败" }, { status: 500 })
      : Response.json({ source: { ...source, require_token: false } });
  });
  await model.methods.refresh_list();
  assert.equal(await model.methods.set_source_public("one", true), false);
  assert.equal(model.state.sources.value[0].require_token, true);
  assert.equal(model.state.list_error.value, "保存失败");
  assert.equal(model.state.source_updating.value.length, 0);
  assert.equal(model.state.loading.value, false);
  fail = false;
  assert.equal(await model.methods.set_source_public("one", true), true);
  assert.equal(model.state.sources.value[0].require_token, false);
  assert.equal(model.state.list_error.value, "");
  assert.deepEqual(calls, ["GET", "PATCH", "PATCH"]);
});

test("删除只移除当前记录并更新总数和选择，失败保留原行且阻止重复请求", async () => {
  const calls = [];
  let finish, fail = true;
  const model = modal_model((url, options) => {
    calls.push(options.method || "GET");
    if (options.method !== "DELETE") return Response.json({ sources: [
      { id: "one", title: "源一", enabled: true }, { id: "two", title: "源二", enabled: true },
    ] });
    return new Promise(resolve => { finish = () => resolve(fail
      ? Response.json({ error: "删除失败" }, { status: 500 }) : Response.json({})); });
  });
  await model.methods.refresh_list();
  model.methods.toggle_page_selection();
  model.state.snapshot_errors.set(new Map([["one", "旧错误"]]));
  const untouched = model.state.sources.value[1];
  let pending = model.methods.remove_source("one");
  assert.equal(await model.methods.remove_source("one"), false);
  assert.equal(model.state.loading.value, false);
  finish();
  assert.equal(await pending, false);
  assert.equal(model.pagination.total.value, 2);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["one", "two"]);
  assert.equal(model.state.list_error.value, "删除失败");
  assert.equal(model.state.source_updating.value.length, 0);
  fail = false;
  pending = model.methods.remove_source("one");
  finish();
  assert.equal(await pending, true);
  assert.equal(model.pagination.total.value, 1);
  assert.equal(model.state.sources.value[0], untouched);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["two"]);
  assert.equal(model.state.snapshot_errors.value.has("one"), false);
  assert.equal(model.state.list_error.value, "");
  assert.equal(await model.methods.remove_source("one"), false);
  assert.deepEqual(calls, ["GET", "DELETE", "DELETE"]);
});

test("启停和公开开关直接移出不再匹配筛选的行，不重新请求列表", async () => {
  const calls = [];
  let sources = ["one", "two", "three"].map(id => ({ id, title: id, enabled: true, require_token: true }));
  const model = modal_model((url, options) => {
    calls.push(options.method || "GET");
    if (options.method !== "PATCH") return Response.json({ sources });
    const source = { ...sources.find(source => url.endsWith("/" + source.id)), ...JSON.parse(options.body) };
    return Response.json({ source });
  });
  await model.methods.set_filter("visibility", "private");
  model.methods.toggle_page_selection();
  const untouched = model.state.sources.value[2];
  assert.equal(await model.methods.toggle_source("one", false), true);
  assert.equal(await model.methods.set_source_public("two", true), true);
  assert.equal(model.state.sources.value.length, 1);
  assert.equal(model.state.sources.value[0], untouched);
  assert.equal(model.pagination.total.value, 1);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["three"]);
  assert.equal(model.state.loading.value, false);
  assert.deepEqual(calls, ["GET", "PATCH", "PATCH"]);
});

test("新增和编辑在当前页合并权威记录并维护总数，不重新请求列表", async () => {
  const sources = Array.from({ length: 25 }, (_, index) => ({ id: String(index), title: "源 " + index, enabled: true }));
  const calls = [];
  const model = modal_model((url, options) => {
    if (url.includes("/scripts")) return Response.json({ scripts: [] });
    calls.push(options.method || "GET");
    if (!options.method) return Response.json({ sources });
    return Response.json({ source: { ...JSON.parse(options.body), id: "new", updated_at: 123 } });
  });
  await model.methods.refresh_list();
  await model.pagination.set_page(1);
  const untouched = model.state.sources.value[0];
  model.methods.create_source();
  model.methods.set_draft("title", "新增");
  await model.methods.save_source();
  assert.equal(model.pagination.page.value, 1);
  assert.equal(model.pagination.total.value, 26);
  assert.equal(model.state.sources.value[0].id, "new");
  assert.equal(model.state.sources.value[1], untouched);
  model.methods.toggle_selection("new");
  model.methods.edit_source("new");
  model.methods.set_draft("title", "新名称");
  await model.methods.save_source();
  assert.equal(model.state.sources.value[0].title, "新名称");
  assert.equal(model.state.sources.value[0].updated_at, 123);
  assert.equal(model.state.sources.value[1], untouched);
  assert.equal(model.pagination.total.value, 26);
  assert.equal(model.pagination.page.value, 1);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["new"]);
  assert.equal(model.state.loading.value, false);
  assert.deepEqual(calls, ["GET", "GET", "POST", "PATCH"]);
});

test("表格选择支持本页全选和跨页保留，筛选与刷新清理过期选择", async () => {
  let sources = Array.from({ length: 25 }, (_, index) => ({ id: String(index), title: "源 " + index, enabled: true }));
  const model = modal_model(async () => Response.json({ sources }));
  await model.methods.refresh_list();
  model.methods.toggle_selection("missing");
  assert.equal(model.state.selected_ids.value.length, 0);
  model.methods.toggle_page_selection();
  assert.equal(model.state.selected_ids.value.length, 20);
  assert.equal(model.page_selection.value.all, true);
  await model.pagination.set_page(1);
  assert.equal(model.page_selection.value.all, false);
  model.methods.toggle_selection("20");
  assert.equal(model.page_selection.value.some, true);
  model.methods.toggle_page_selection();
  assert.equal(model.state.selected_ids.value.length, 25);
  model.methods.toggle_page_selection();
  assert.equal(model.state.selected_ids.value.length, 20);
  await model.methods.set_filter("query", "源");
  assert.equal(model.state.selected_ids.value.length, 0);
  model.methods.toggle_selection("0");
  model.methods.toggle_selection("1");
  sources = sources.slice(1);
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["1"]);
  model.methods.clear_selection();
  assert.equal(model.state.selected_ids.value.length, 0);
});

test("批量启停设置明确状态，保留失败项，重复提交与处理中修改选择被阻止", async () => {
  const sources = [{ id: "one", title: "源一", enabled: true }, { id: "two", title: "源二", enabled: false }];
  const writes = [];
  let finish, fail = true;
  const model = modal_model(async (url, options) => {
    if (options.method !== "PATCH") return Response.json({ sources });
    const id = url.split("/").at(-1);
    writes.push([id, JSON.parse(options.body)]);
    if (id === "one") await new Promise(resolve => { finish = resolve; });
    if (id === "two" && fail) return Response.json({ error: "写入失败" }, { status: 500 });
    const updated = { ...sources.find(source => source.id === id), ...JSON.parse(options.body) };
    sources.splice(sources.findIndex(source => source.id === id), 1, updated);
    return Response.json({ source: updated });
  });
  await model.methods.refresh_list();
  await model.methods.set_filter("status", "all");
  model.methods.toggle_page_selection();
  const pending = model.methods.bulk_action("disable");
  assert.equal(model.state.bulk_busy.value, true);
  await model.methods.bulk_action("delete");
  model.methods.clear_selection();
  model.methods.toggle_selection("one");
  await model.methods.set_filter("status", "disabled");
  model.methods.create_source();
  model.methods.open_import();
  assert.equal(model.state.selected_ids.value.length, 2);
  assert.equal(model.state.filter_status.value, "all");
  assert.equal(model.state.form_open.value, false);
  assert.equal(model.state.import_open.value, false);
  finish();
  await pending;
  assert.deepEqual(writes, [["one", { enabled: false }]]);
  assert.equal(model.state.bulk_busy.value, false);
  assert.match(model.state.bulk_message.value, /成功 2 个，失败 0 个/);

  await model.methods.set_filter("status", "all");
  model.methods.toggle_page_selection();
  const enable = model.methods.bulk_action("enable");
  finish();
  await enable;
  assert.deepEqual(writes.slice(1), [["one", { enabled: true }], ["two", { enabled: true }]]);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["two"]);
  assert.match(model.state.bulk_message.value, /成功 1 个，失败 1 个/);
  assert.match(model.state.list_error.value, /源二：写入失败/);
  fail = false;
  await model.methods.bulk_action("enable");
  assert.equal(model.state.selected_ids.value.length, 0);
  assert.equal(model.state.list_error.value, "");
});

test("批量删除提交所选订阅源，失败保留以便重试", async () => {
  const deleted = [];
  let reads = 0;
  let sources = ["one", "two"].map(id => ({ id, title: id, enabled: true }));
  const model = modal_model(async (url, options) => {
    if (options.method === "DELETE") {
      deleted.push(url.split("/").at(-1));
      if (deleted.at(-1) !== "two") sources = sources.filter(source => source.id !== deleted.at(-1));
      return deleted.at(-1) === "two" ? Response.json({ error: "删除失败" }, { status: 500 }) : Response.json({});
    }
    reads++;
    return Response.json({ sources });
  });
  await model.methods.refresh_list();
  model.methods.toggle_page_selection();
  assert.deepEqual(deleted, []);
  assert.equal(model.state.selected_ids.value.length, 2);
  await model.methods.bulk_action("delete");
  assert.deepEqual(deleted, ["one", "two"]);
  assert.deepEqual(Array.from(model.state.sources.value, source => source.id), ["two"]);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["two"]);
  assert.match(model.state.list_error.value, /two：删除失败/);
  assert.equal(model.pagination.total.value, 1);
  assert.equal(reads, 1, "批量删除结束不重新读取列表");
});

test("批量刷新更新 XML 和快照，跳过外部私密源，失败保留选择与原内容", async () => {
  const calls = [];
  const model = modal_model(async (url, options) => {
    if (options.method === "POST") {
      const id = url.split("/").at(-2);
      calls.push(id);
      return id === "failed" ? Response.json({ error: "上游离线" }, { status: 502 })
        : Response.json({ snapshot: { saved_at: 100, articles: [], error: "" }, cache: { status: "fresh" } });
    }
    return Response.json({ sources: [
      { id: "public", title: "公开源", enabled: true },
      { id: "managed", title: "自有私密源", enabled: true, require_token: true, cache: { status: "empty" } },
      { id: "external", title: "外部私密源", enabled: true, require_token: true },
      { id: "failed", title: "失败源", enabled: true, snapshot: { saved_at: 10, articles: [{ title: "旧文章" }] } },
    ] });
  });
  await model.methods.refresh_list();
  model.methods.toggle_page_selection();
  await model.methods.bulk_action("refresh");
  assert.deepEqual(calls, ["public", "managed", "failed"]);
  assert.equal(model.state.sources.value[1].cache.status, "fresh");
  assert.equal(model.state.sources.value[3].snapshot.saved_at, 10);
  assert.deepEqual(Array.from(model.state.selected_ids.value), ["external", "failed"]);
  assert.match(model.state.bulk_message.value, /成功 2 个，失败 1 个，跳过 1 个/);
  assert.match(model.state.list_error.value, /失败源：上游离线/);
});

test("后端翻页后仍可批量刷新和停用前一页选中的订阅源", async () => {
  const sources = Array.from({ length: 21 }, (_, index) => ({ id: String(index), title: "源 " + index, enabled: true }));
  const refreshed = [], disabled = [];
  let reads = 0;
  const model = modal_model(async (url, options) => {
    if (options.method === "POST") {
      refreshed.push(url.split("/").at(-2));
      return Response.json({ snapshot: { saved_at: 100, articles: [], error: "" } });
    }
    if (options.method === "PATCH") {
      const source = sources.find(source => url.endsWith("/" + source.id));
      Object.assign(source, JSON.parse(options.body));
      disabled.push(source.id);
      return Response.json({ source });
    }
    reads++;
    return Response.json({ sources });
  });
  await model.methods.refresh_list();
  model.methods.toggle_selection("0");
  await model.pagination.set_page(1);
  model.methods.toggle_selection("20");
  await model.methods.bulk_action("refresh");
  assert.deepEqual(refreshed, ["0", "20"]);
  model.methods.toggle_selection("20");
  await model.pagination.set_page(0);
  model.methods.toggle_selection("0");
  await model.methods.bulk_action("disable");
  assert.deepEqual(disabled, ["20", "0"]);
  assert.equal(model.pagination.state.value.total, 19);
  assert.equal(model.pagination.state.value.last, 19);
  assert.equal(reads, 3, "只有首次加载和两次翻页读取列表");
});

test("后台可选标签使用脚本目录，匹配路由预填且手动修改保留，草稿和源标签不进入选项", async () => {
  let tags = ["科技", "视频", "无源标签"];
  const scripts = [{ status: "draft", routes: [{ path: "/demo/:id", tags: ["草稿标签"] }] },
    { status: "published", routes: [{ path: "/demo/:id", tags: ["科技"] }, { path: "/video/:id", tags: ["视频"] }] }];
  const model = modal_model(async url => Response.json(url.endsWith("/preview")
    ? { defaults: { title: "预览", website: "", description: "", tags: ["feed 标签"] } }
    : url.includes("scripts") ? { scripts }
    : { tags, sources: [{ id: "old", title: "源", tags: ["旧源标签"], feed_url: "{{hostname}}/rss/demo/1", enabled: true }] }));
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.tags.value), tags);
  model.methods.create_source();
  model.methods.set_draft("feed_url", "{{hostname}}/rss/demo/2");
  await new Promise(setImmediate);
  assert.equal(model.state.draft_tags.value, "科技");
  await model.methods.preview_feed();
  assert.equal(model.state.draft_tags.value, "科技");
  model.methods.set_draft("feed_url", "{{hostname}}/atom/video/2");
  assert.equal(model.state.draft_tags.value, "视频");
  model.methods.toggle_tag("无源标签");
  model.methods.set_draft("feed_url", "{{hostname}}/rss/demo/3");
  await model.methods.preview_feed();
  assert.equal(model.state.draft_tags.value, "视频, 无源标签");
  model.methods.toggle_tag("视频");
  model.methods.toggle_tag("不存在");
  assert.equal(model.state.draft_tags.value, "无源标签");
  model.methods.close_form();
  model.methods.edit_source("old");
  model.methods.set_draft("feed_url", "{{hostname}}/rss/video/3");
  await new Promise(setImmediate);
  assert.equal(model.state.draft_tags.value, "旧源标签");
  tags = [];
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.tags.value), []);
});

test("JSON 导入兼容导出格式，保留配置和模板，跳过已有及重复地址", async () => {
  const writes = [];
  let reads = 0;
  const sources = [{ id: "old", title: "已有", feed_url: "https://example.com/existing", enabled: true }];
  const model = modal_model(async (_, options) => {
    if (!options?.body) { reads++; return Response.json({ sources }); }
    const source = JSON.parse(options.body);
    writes.push(source);
    const saved = { ...source, id: "new-" + writes.length };
    sources.push(saved);
    return Response.json({ source: saved });
  });
  await model.methods.refresh_list();
  model.methods.open_import();
  const source = { id: "ignored", title: "导入源", feed_url: "https://old.example/rss/test", feed_url_template: "{{hostname}}/rss/test",
    social_url: "https://x.com/imported",
    tags: ["标签"], enabled: false, require_token: true, credit_cost: 7, source_type: "website", sort_order: 3, avatar_url: "/old-avatar", snapshot: { saved_at: 1 }, poll_policy: { mode: "manual" } };
  model.methods.set_import_text(JSON.stringify({ sources: [
    { title: "已有", feed_url: "https://example.com/existing" }, source, source,
  ] }));
  await model.methods.import_sources();
  assert.deepEqual(writes, [{ title: "导入源", social_url: "https://x.com/imported", feed_url: "{{hostname}}/rss/test", tags: ["标签"], enabled: false, require_token: true, credit_cost: 7, source_type: "website", sort_order: 3, poll_policy: { mode: "manual" } }]);
  assert.equal(model.state.sources.value.length, 1, "默认启用筛选排除导入的停用源");
  assert.equal(model.pagination.total.value, 1);
  assert.equal(reads, 2, "首次加载和导入查重各读取一次，导入后不重载");
  await model.methods.set_filter("status", "all");
  assert.equal(model.state.sources.value.length, 2);
  assert.match(model.state.import_message.value, /已导入 1 个.*跳过重复地址 2 个/);
  assert.equal(model.state.import_text.value, "");
  assert.equal(model.state.import_busy.value, false);
});

test("JSON 导入先检查结构与必填项，格式错误不发请求", async () => {
  let writes = 0;
  const model = modal_model(async () => { writes++; return Response.json({}); });
  for (const text of ["bad", "null", "{}", "[]", '[{"title":"缺地址"}]', '[{"title":"有效","feed_url":"https://example.com"},null]']) {
    model.methods.set_import_text(text);
    await model.methods.import_sources();
    assert.match(model.state.import_error.value, /JSON 格式错误/);
  }
  assert.equal(writes, 0);
});

test("访问积分新增默认 1，编辑回填并保存配置，空值和非法金额不提交，零积分可保存", async () => {
  const writes = [];
  let source = { id: "paid", title: "付费源", feed_url: "{{hostname}}/rss/demo", enabled: true, require_token: true, credit_cost: 5 };
  const model = modal_model(async (url, options) => {
    if (!options?.body) return Response.json({ sources: [source] });
    const body = JSON.parse(options.body);
    writes.push(body);
    source = { ...body, id: "paid" };
    return Response.json({ source });
  });
  await model.methods.refresh_list();
  model.methods.create_source();
  assert.equal(model.state.draft_require_token.value, true);
  assert.equal(model.state.draft_credit_cost.value, "1");
  model.methods.close_form();
  model.methods.edit_source("paid");
  assert.equal(model.state.draft_credit_cost.value, "5");
  model.methods.set_draft("credit_cost", "7");
  await model.methods.save_source();
  assert.equal(writes[0].credit_cost, 7);
  model.methods.edit_source("paid");
  for (const value of ["", " ", "-1", "1.5", "1000000001", "nope"]) {
    model.methods.set_draft("credit_cost", value);
    await model.methods.save_source();
    assert.match(model.state.form_error.value, /消耗积分必须/);
    assert.equal(writes.length, 1);
  }
  model.methods.set_draft("credit_cost", "0");
  model.methods.set_draft("require_token", false);
  await model.methods.save_source();
  assert.equal(writes[1].credit_cost, 0);
  assert.equal(writes[1].require_token, false);
  model.methods.edit_source("paid");
  assert.equal(model.state.draft_require_token.value, false);
  model.methods.create_source();
  assert.equal(model.state.draft_require_token.value, true);
  assert.equal(model.state.draft_credit_cost.value, "1");
});

test("JSON 导入中断保留结果与剩余条目，重复提交被阻止，重试不重复新增", async () => {
  const calls = [];
  let finish;
  let fail = true;
  const sources = [];
  const model = modal_model(async (_, options) => {
    if (!options.body) return Response.json({ sources });
    const source = { enabled: true, ...JSON.parse(options.body) };
    calls.push(source.title);
    if (source.title === "one") return new Promise(resolve => { finish = () => { sources.push({ ...source, id: "one" }); resolve(Response.json({ source: sources.at(-1) })); }; });
    if (fail) return Response.json({ error: "路由不存在" }, { status: 400 });
    sources.push({ ...source, id: "two" });
    return Response.json({ source: sources.at(-1) });
  });
  model.methods.open_import();
  model.methods.set_import_text(JSON.stringify(["one", "two"].map(title => ({ title, feed_url: "https://example.com/" + title }))));
  const pending = model.methods.import_sources();
  await new Promise(setImmediate);
  await model.methods.import_sources();
  model.methods.close_import();
  assert.equal(model.state.import_open.value, true);
  finish();
  await pending;
  assert.equal(model.state.sources.value.length, 1);
  assert.match(model.state.import_error.value, /第 2 项.*路由不存在/);
  assert.equal(JSON.parse(model.state.import_text.value).sources[0].title, "two");
  fail = false;
  await model.methods.import_sources();
  assert.deepEqual(calls, ["one", "two", "two"]);
  assert.equal(model.state.sources.value.length, 2);
});

test("JSON 文件读取填入文本，限制类型大小，关闭后丢弃迟到读取", async () => {
  const model = modal_model(async () => Response.json({}));
  model.methods.open_import();
  await model.methods.read_import_file([new File(['\uFEFF{"sources":[]}'], "feeds.JSON", { type: "application/json" })]);
  assert.equal(model.state.import_text.value, '{"sources":[]}');
  for (const file of [{ name: "feeds.txt", size: 1 }, { name: "feeds.json", size: 2 * 1024 * 1024 + 1 }]) {
    await model.methods.read_import_file([file]);
    assert.match(model.state.import_error.value, /JSON 文件/);
  }
  await model.methods.read_import_file([{ name: "bad.json", size: 1, async text() { throw new Error("无法读取"); } }]);
  assert.match(model.state.import_error.value, /读取失败.*无法读取/);
  let finish;
  const pending = model.methods.read_import_file([{ name: "late.json", size: 1, text: () => new Promise(resolve => { finish = resolve; }) }]);
  assert.equal(model.state.import_reading.value, true);
  model.methods.close_import();
  model.methods.open_import();
  model.methods.set_import_text("new draft");
  finish("late result");
  await pending;
  assert.equal(model.state.import_text.value, "new draft");
  assert.equal(model.state.import_reading.value, false);
});

test("后台列表与表单读取脚本平台注册，自定义路由推断平台且手动选择保留", async () => {
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 2h3v4H1z"/></svg>';
  const platform = { name: "独立平台", icon };
  const scripts = [{ kind: "rss", platform, path: "/different/:id", routes: [{ path: "/different/:id", platform }] }];
  const model = modal_model(async url => Response.json(url.endsWith("/preview") ? { feed_url: "https://example.com/rss/different/123",
    defaults: { title: "预览", website: "", description: "", tags: [], source_type: "website" } } : url.includes("scripts") ? { scripts } : {
    sources: [], platforms: [{ id: "website", label: "网页" }, { id: "独立平台", label: "独立平台", icon }],
  }));
  await model.methods.refresh_list();
  assert.deepEqual(Array.from(model.state.platforms.value, platform => platform.id), ["website", "独立平台"]);
  assert.equal(model.state.platforms.value[1].icon, icon);
  assert.equal(platform_helpers.discovery_platform_icon_url("独立平台", model.state.platforms.value), "data:image/svg+xml," + encodeURIComponent(icon));
  model.methods.create_source();
  await new Promise(setImmediate);
  model.methods.set_draft("feed_url", "{{hostname}}/rss/different/123");
  assert.equal(model.state.draft_source_type.value, "独立平台");
  await model.methods.preview_feed();
  assert.equal(model.state.draft_source_type.value, "独立平台", "预览不覆盖脚本声明的平台");
  model.methods.set_draft("source_type", "website");
  model.methods.set_draft("feed_url", "{{hostname}}/atom/different/123");
  assert.equal(model.state.draft_source_type.value, "website");
});

test("后台接口列表替换默认平台并保留名称，脚本加载不改写列表，刷新移除旧平台", async () => {
  let platforms = [{ id: "custom", label: "接口名称" }, { id: "zhihu", label: "接口知乎名称" }];
  const model = modal_model(async url => Response.json(url.includes("scripts")
    ? { scripts: [{ platform: "脚本平台", path: "/demo", routes: [{ platform: "脚本平台", path: "/demo" }] }] }
    : { sources: [{ id: "a", source_type: "x", feed_url: "https://example.com/feed" }], platforms }));
  await model.methods.refresh_list();
  assert.deepEqual(JSON.parse(JSON.stringify(model.state.platforms.value)), platforms);
  model.methods.create_source();
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(model.state.platforms.value)), platforms);
  platforms = [];
  await model.methods.refresh_list();
  assert.equal(model.state.platforms.value.length, 0);
});

test("后台刷新快照合并重复点击，保留失败前的快照并展示错误，外部私密源不刷新", async () => {
  const calls = [];
  let finish;
  const model = modal_model(async (url, options) => {
    calls.push([url, options?.method]);
    if (url.endsWith("/snapshot")) return new Promise(resolve => { finish = resolve; });
    return Response.json({ sources: [{ id: "one", title: "源", enabled: true, feed_url: "https://example.com/feed",
      snapshot: { saved_at: 10, articles: [{ title: "上次文章" }], error: "" } },
      { id: "private", title: "私有源", enabled: true, require_token: true, feed_url: "https://example.com/private" }] });
  });
  await model.methods.refresh_list();
  const pending = model.methods.refresh_snapshot("one");
  await model.methods.refresh_snapshot("one");
  await model.methods.refresh_snapshot("private");
  assert.equal(calls.length, 2);
  assert.deepEqual(Array.from(model.state.snapshot_refreshing.value), ["one"]);
  finish(Response.json({ snapshot: { saved_at: 10, articles: [{ title: "上次文章" }], error: "上游离线" } }));
  await pending;
  assert.equal(model.state.sources.value[0].snapshot.saved_at, 10);
  assert.equal(model.state.sources.value[0].snapshot.articles[0].title, "上次文章");
  assert.equal(model.state.snapshot_errors.value.get("one"), "上游离线");
  assert.equal(model.state.list_error.value, "");
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
});

test("快照请求失败按源展示，重试仅清除当前源错误，成功后恢复", async () => {
  const pending = new Map();
  const model = modal_model(url => new Promise(resolve => pending.set(url.split("/").at(-2), resolve)));
  model.state.sources.as(["one", "two"].map(id => ({ id, require_token: false })));
  model.state.list_error.set("列表错误");
  const first = model.methods.refresh_snapshot("one");
  const second = model.methods.refresh_snapshot("two");
  pending.get("one")(Response.json({ error: "设备离线" }, { status: 503 }));
  pending.get("two")(Response.json({ error: "上游超时" }, { status: 502 }));
  await Promise.all([first, second]);
  assert.equal(model.state.snapshot_errors.value.get("one"), "设备离线");
  assert.equal(model.state.snapshot_errors.value.get("two"), "上游超时");
  assert.equal(model.state.snapshot_refreshing.value.length, 0);
  const retry = model.methods.refresh_snapshot("one");
  assert.equal(model.state.snapshot_errors.value.get("one"), "");
  assert.equal(model.state.snapshot_errors.value.get("two"), "上游超时");
  pending.get("one")(Response.json({ snapshot: { saved_at: 20, articles: [], error: "" } }));
  await retry;
  assert.equal(model.state.snapshot_errors.value.get("one"), "");
  assert.equal(model.state.sources.value[0].snapshot.saved_at, 20);
  assert.equal(model.state.list_error.value, "列表错误");
});

test("后台可强制刷新自有私密源 XML，并更新快照状态而不显示文章", async () => {
  const calls = [];
  const model = modal_model(async (url, options) => {
    calls.push([url, options?.method]);
    return url.endsWith("/snapshot") ? Response.json({ snapshot: { saved_at: 0, articles: [], error: "" },
      cache: { status: "fresh", saved_at: 100, expires_at: 600100, persistent: true } }) : Response.json({ sources: [
      { id: "private", title: "私密源", require_token: true, feed_url: "{{hostname}}/rss/private",
        cache: { status: "empty", saved_at: 0 }, snapshot: { saved_at: 0, articles: [] } },
    ] });
  });
  await model.methods.refresh_list();
  await model.methods.refresh_snapshot("private");
  assert.deepEqual(calls[1], ["/admin/api/discovery/sources/private/snapshot", "POST"]);
  assert.equal(model.state.sources.value[0].cache.status, "fresh");
  assert.equal(model.state.sources.value[0].snapshot.articles.length, 0);
});

test("打开订阅源表单只请求 kind rss 的脚本；加载失败保留地址并可重新打开重试", async () => {
  let fail = false;
  const calls = [];
  const scripts = [{ kind: "rss", path: "/zhihu/answer", enabled: false, routes: [{ path: "/zhihu/answer" }, { path: "/zhihu/hot" }] }];
  const model = modal_model(async url => {
    calls.push(url);
    return fail ? Response.json({ error: "路由列表不可用" }, { status: 500 }) : Response.json({ scripts });
  });
  model.methods.create_source();
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(model.state.scripts.value)), scripts);
  assert.equal(model.state.scripts_loading.value, false);
  assert.deepEqual(calls, ["/admin/api/scripts?kind=rss"]);
  model.methods.close_form();
  fail = true;
  model.methods.create_source();
  model.methods.set_draft("feed_url", "{{hostname}}/rss/z");
  await new Promise(setImmediate);
  assert.match(model.state.scripts_error.value, /路由列表不可用/);
  assert.equal(model.state.draft_feed_url.value, "{{hostname}}/rss/z");
  assert.equal(model.state.form_open.value, true);
  model.methods.close_form();
  fail = false;
  model.methods.create_source();
  await new Promise(setImmediate);
  assert.equal(model.state.scripts_error.value, "");
  assert.equal(calls.length, 3);
});

test("新增与编辑共用弹窗，取消清空草稿，保存失败保留表单，成功关闭", async () => {
  let fail = false;
  let finish;
  const calls = [];
  const source = { id: "one", title: "科技日报", feed_url: "https://example.com/rss/demo",
    feed_url_template: "{{hostname}}/rss/demo", tags: ["科技"], category: "science", enabled: false,
    website: "https://example.com", description: "科技资讯", sort_order: 0, require_token: false };
  const { state, methods } = modal_model((url, options) => {
    if (!options?.method) return Response.json({ sources: [source] });
    calls.push({ url, options });
    return new Promise(resolve => { finish = () => resolve(fail
      ? Response.json({ error: "保存失败" }, { status: 500 }) : Response.json({ source })); });
  });
  assert.equal(state.form_open.value, false);
  methods.create_source();
  assert.equal(state.form_open.value, true);
  assert.equal(state.draft_enabled.value, true);
  methods.set_draft("title", "草稿");
  methods.close_form();
  assert.equal(state.form_open.value, false);
  assert.equal(state.draft_title.value, "");
  state.sources.as([source]);
  methods.edit_source("one");
  assert.equal(state.form_open.value, true);
  assert.equal(state.draft_feed_url.value, "{{hostname}}/rss/demo");
  fail = true;
  let pending = methods.save_source();
  methods.close_form();
  assert.equal(state.form_open.value, true, "保存期间不可关闭");
  finish();
  await pending;
  assert.equal(state.form_open.value, true);
  assert.equal(state.draft_title.value, "科技日报");
  assert.equal(state.form_error.value, "保存失败");
  fail = false;
  pending = methods.save_source();
  finish();
  await pending;
  assert.equal(calls.at(-1).options.method, "PATCH");
  assert.equal(JSON.parse(calls.at(-1).options.body).enabled, false);
  assert.equal(state.form_open.value, false);
  assert.equal(state.editing_id.value, "");
  assert.equal(state.form_message.value, "科技日报 已保存。");
  methods.create_source();
  pending = methods.save_source();
  finish();
  await pending;
  assert.equal(calls.at(-1).options.method, "POST");
  assert.equal(JSON.parse(calls.at(-1).options.body).enabled, true);
});

test("头像上传失败保留弹窗，重试更新已创建源而不重复新增", async () => {
  const calls = [];
  let avatar_fails = true;
  const { state, methods } = modal_model(async (url, options) => {
    if (!options.method) return Response.json({ sources: [{ id: "created", title: "示例源", enabled: true }] });
    calls.push({ url, options });
    if (url.endsWith("/avatar") && avatar_fails) return Response.json({ error: "上传失败" }, { status: 500 });
    return Response.json({ source: { id: "created", title: "示例源", enabled: true } });
  });
  methods.create_source();
  methods.set_draft("title", "示例源");
  methods.set_avatar_file(new File(["icon"], "avatar.png", { type: "image/png" }));
  await methods.save_source();
  assert.equal(state.form_open.value, true);
  assert.equal(state.editing_id.value, "created");
  assert.ok(state.avatar_file.value);
  assert.match(state.form_error.value, /已保存，但头像上传失败/);
  avatar_fails = false;
  await methods.save_source();
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.options.method === "PATCH").length, 1);
  assert.equal(state.sources.value.length, 1);
  assert.equal(state.form_open.value, false);
});

test("RSS 地址输入及失焦不读取订阅源，点击按钮才读取", () => {
  const nodes = [];
  const component = (props, children) => { nodes.push({ props, children }); return {}; };
  const calls = [];
  const ref = (value) => ({ value, set(next) { this.value = next; }, as(next) { this.value = next; } });
  const context = vm.createContext({ ...platform_helpers, PollPolicyView, poll_policy_label, PollPolicyModel, RssRoutePatternModel, ListPaginationModel, PaginationModel, PaginationView, URL, document: { querySelector: () => null }, window: {
    Timeless: { ...list_runtime, DOM: {}, ref, refarr: ref, computed: (source, map) => ({ get value() { return map(source.value); } }),
      combine: (sources, map) => ({ get value() { return map(Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.value]))); } }),
      View: component, Input: component, FeedAddressEditor: component, Button: component, Select: component, Textarea: component, Dialog: component, Icon: component,
      Show: () => ({}), For: () => ({}),
    },
    FindRSSAdminShell: {}, FindRSSAdminPages: {}, FindRSSAdminAuth: { fetch() {} },
  } });
  context.window.FindRSSAdminUI = context.window.Timeless;
  context.window.FindRSSAdminUI.Card = context.window.Timeless.View;
  context.window.FindRSSAdminUI.Field = context.window.Timeless.View;
  context.window.FindRSSAdminUI.FilePicker = context.window.Timeless.Input;
  vm.runInContext(page_source("discovery.js") + '\nglobalThis.model = DiscoveryAdminViewModel();', context);
  context.model.methods.preview_feed = () => calls.push(context.model.state.draft_feed_url.value);
  vm.runInContext('SourceFormView({ store: model });', context);
  const input = nodes.find((node) => node.props.attributes?.n === 'discovery-source-feed-input');
  const button = nodes.find((node) => node.props.attributes?.n === 'discovery-source-preview-button');
  input.props.onInput({ target: { value: 'https://example.com/rss' } });
  assert.equal(context.model.state.draft_feed_url.value, 'https://example.com/rss');
  assert.equal(input.props.onChange, undefined);
  assert.equal(input.props.onBlur, undefined);
  assert.equal(button.props.disabled.value, false);
  context.model.state.editing_id.set("existing-source");
  assert.equal(button.props.disabled.value, false, "编辑订阅源时也能主动读取信息");
  context.model.state.saving.set(true);
  assert.equal(button.props.disabled.value, true);
  context.model.state.saving.set(false);
  context.model.state.previewing.set(true);
  assert.equal(button.props.disabled.value, true);
  context.model.state.previewing.set(false);
  assert.deepEqual(calls, []);
  button.props.onClick();
  assert.deepEqual(calls, ['https://example.com/rss']);
});

test("编辑订阅源可重复读取同一地址，只更新草稿并保留读取过程中修改的字段", async () => {
  const source = { id: "existing", title: "原名称", feed_url: "https://example.com/rss", website: "https://example.com",
    description: "原简介", tags: ["原标签"], sort_order: 0, enabled: false, require_token: true, source_type: "website" };
  const calls = [];
  let finish;
  const { state, methods } = modal_model((url, options) => {
    if (url === "/admin/api/scripts?kind=rss") return Promise.resolve(Response.json({ scripts: [] }));
    calls.push({ url, options });
    return new Promise(resolve => { finish = () => resolve(Response.json({ feed_url: source.feed_url,
      defaults: { title: "读取的名称", website: "https://example.com/new", description: "读取的简介", tags: ["新标签"], source_type: "zhihu" } })); });
  });
  state.sources.as([source]);
  methods.edit_source(source.id);
  const first = methods.preview_feed();
  assert.equal(state.previewing.value, true);
  await methods.preview_feed();
  assert.equal(calls.length, 1, "读取期间不重复发送请求");
  methods.set_draft("title", "手动修改的名称");
  methods.set_draft("source_type", "website");
  finish();
  await first;
  assert.equal(calls[0].url, "/admin/api/discovery/preview");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(JSON.parse(calls[0].options.body).feed_url, source.feed_url);
  assert.equal(state.draft_title.value, "手动修改的名称");
  assert.equal(state.draft_description.value, "读取的简介");
  assert.equal(state.draft_website.value, "https://example.com/new");
  assert.equal(state.draft_tags.value, "新标签");
  assert.equal(state.draft_source_type.value, "website");
  assert.equal(state.editing_id.value, source.id);
  assert.equal(state.draft_enabled.value, false);
  assert.equal(state.draft_require_token.value, true);
  assert.equal(state.sources.value[0].title, "原名称", "读取不保存订阅源");
  assert.equal(state.previewing.value, false);
  const second = methods.preview_feed();
  assert.equal(calls.length, 2, "读取成功后允许再次读取同一地址");
  finish();
  await second;
  assert.equal(state.draft_title.value, "读取的名称");
  assert.equal(state.sources.value[0].title, "原名称");
});

test("新增源回填默认值，异步旧地址不覆盖新草稿，头像随源保存上传", async () => {
  const calls = [];
  let finish;
  const ref = (value) => ({ value, set(next) { this.value = next; }, as(next) { this.value = next; } });
  const context = vm.createContext({ ...platform_helpers, PollPolicyView, poll_policy_label, PollPolicyModel, RssRoutePatternModel, ListPaginationModel, PaginationModel, PaginationView, URL, File, Uint8Array, atob, document: { querySelector: () => null }, window: {
    Timeless: { ...list_runtime, DOM: {}, ref, refarr: ref, computed: () => ({}), combine: () => ({}) },
    FindRSSAdminShell: {}, FindRSSAdminPages: {}, FindRSSAdminAuth: { fetch(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/preview')) return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve(Response.json({ source: { id: 'new', title: '源', enabled: true } }));
    } },
  } });
  context.window.FindRSSAdminUI = context.window.Timeless;
  context.window.FindRSSAdminUI.Card = context.window.Timeless.View;
  context.window.FindRSSAdminUI.Field = context.window.Timeless.View;
  context.window.FindRSSAdminUI.FilePicker = context.window.Timeless.Input;
  vm.runInContext(page_source("discovery.js") + '\nglobalThis.model = DiscoveryAdminViewModel();', context);
  const model = context.model;
  const payload = { feed_url: 'https://example.com/rss', defaults: { title: '源', website: 'https://example.com', description: '介绍', category: 'science', tags: ['标签'], source_type: 'website' }, avatar: { data: 'aWNvbg==', content_type: 'image/png' } };
  model.methods.set_draft('feed_url', '{{hostname}}/rss/first');
  let pending = model.methods.preview_feed();
  model.methods.set_draft('feed_url', '{{hostname}}/rss/second');
  finish(Response.json(payload));
  await pending;
  assert.equal(model.state.draft_title.value, '');
  pending = model.methods.preview_feed();
  model.methods.set_draft('title', '手动名称');
  finish(Response.json(payload));
  await pending;
  assert.equal(model.state.draft_title.value, '手动名称');
  assert.equal(model.state.draft_tags.value, '标签');
  assert.equal(model.state.draft_category, undefined);
  assert.equal(model.state.avatar_file.value.type, 'image/png');
  await model.methods.save_source();
  const saved = calls.find((call) => call.options.method === 'POST' && call.url.endsWith('/sources'));
  assert.equal(JSON.parse(saved.options.body).feed_url, '{{hostname}}/rss/second');
  assert.ok(calls.some((call) => call.url.endsWith('/new/avatar') && call.options.method === 'PUT'));
});

test("读取信息时拦截非 RSS/Atom 模板地址，修正后及外部地址仍可读取", async () => {
  const calls = [];
  const model = modal_model(async (_url, options) => {
    const { feed_url } = JSON.parse(options.body);
    calls.push(feed_url);
    return Response.json({ feed_url, defaults: { title: "源", tags: [] } });
  });
  for (const address of ["{{hostname}}", "{{hostname}}/feed.xml", "{{hostname}}/admin",
    "{{hostname}}/rss-other/test", "{{hostname}}/atom.xml", "{{hostname}}.example.com/rss/test",
    "{{hostname}}/rss/../../admin", "{{hostname}}/atom/%2e%2e/feed.xml"]) {
    model.methods.set_draft("feed_url", address);
    await model.methods.preview_feed();
    assert.equal(model.state.form_error.value, "模板订阅源地址必须以 {{hostname}}/rss/ 或 {{hostname}}/atom/ 开头");
    assert.equal(model.state.form_message.value, "");
    assert.equal(model.state.previewing.value, false);
  }
  assert.deepEqual(calls, []);
  for (const address of ["{{hostname}}/rss/demo?offset=1", "{{hostname}}/atom/demo", "https://example.com/feed.xml"]) {
    model.methods.set_draft("feed_url", address);
    await model.methods.preview_feed();
    assert.equal(model.state.form_error.value, "");
    assert.equal(calls.at(-1), address);
  }
});

test("读取订阅源信息失败时展示具体错误描述，清除读取中提示且允许重试", async () => {
  const message = "脚本执行失败：脚本异常：小红书笔记缺少有效的 noteId";
  let calls = 0;
  const ref = value => ({ value, set(next) { this.value = next; }, as(next) { this.value = next; } });
  const context = vm.createContext({ ...platform_helpers, PollPolicyView, poll_policy_label, PollPolicyModel, RssRoutePatternModel, ListPaginationModel, PaginationModel, PaginationView, URL, document: { querySelector: () => null }, window: {
    Timeless: { ...list_runtime, DOM: {}, ref, refarr: ref, computed: () => ({}), combine: () => ({}) }, FindRSSAdminShell: {}, FindRSSAdminPages: {},
    FindRSSAdminAuth: { fetch: async () => { calls++; return Response.json({ error: message }, { status: 502 }); } },
  } });
  context.window.FindRSSAdminUI = context.window.Timeless;
  vm.runInContext(page_source("discovery.js") + "\nglobalThis.model = DiscoveryAdminViewModel();", context);
  const model = context.model;
  model.methods.set_draft("feed_url", "{{hostname}}/rss/xiaohongshu/user/profile/5756ecbb5e87e74222938eac");
  await model.methods.preview_feed();
  assert.equal(model.state.form_error.value, message);
  assert.equal(model.state.form_message.value, "");
  assert.equal(model.state.previewing.value, false);
  await model.methods.preview_feed();
  assert.equal(calls, 2);
});

test("新增保存携带读取缓存标识，修改地址、重新读取失败或关闭表单后不复用旧标识", async () => {
  for (const mode of ["matching", "changed", "failed", "closed"]) {
    let saved, saved_source, preview_body, fail = false;
    const snapshot = { saved_at: 123, articles: [{ title: "已读取文章" }] };
    const model = modal_model(async (url, options) => {
      if (url.endsWith("/preview")) {
        preview_body = JSON.parse(options.body);
        return fail ? Response.json({ error: "读取失败" }, { status: 502 })
          : Response.json({ preview_id: "preview-id", defaults: { title: "源", website: "", description: "", tags: [], source_type: "website" } });
      }
      if (options?.method === "POST") {
        saved = options;
        saved_source = { ...JSON.parse(options.body), id: "new", snapshot, cache: { status: "fresh" } };
        return Response.json({ source: saved_source });
      }
      return Response.json({ scripts: [], sources: saved_source ? [saved_source] : [] });
    });
    model.methods.set_draft("feed_url", "https://example.com/feed.xml");
    await model.methods.preview_feed();
    assert.equal(preview_body.cache_snapshot, true);
    if (mode === "changed") model.methods.set_draft("feed_url", "https://example.com/other.xml");
    if (mode === "failed") { fail = true; await model.methods.preview_feed(); }
    if (mode === "closed") {
      model.methods.close_form();
      model.methods.set_draft("feed_url", "https://example.com/feed.xml");
      model.methods.set_draft("title", "源");
    }
    await model.methods.save_source();
    assert.equal(saved.headers?.["X-Feed-Preview-ID"], mode === "matching" ? "preview-id" : undefined);
    assert.equal(model.state.sources.value[0].snapshot.saved_at, 123);
    assert.equal(model.state.sources.value[0].cache.status, "fresh");
  }
});


test("后台编辑将旧分类带入标签，保存不再设置分类，新增地址识别平台", async () => {
  let saved;
  const source = { id: "old", title: "旧源", feed_url: "https://example.com/feed", category: "technology", tags: ["文章"], enabled: true, source_type: "x" };
  const model = modal_model(async (url, options) => {
    if (options?.method === "PATCH") saved = JSON.parse(options.body);
    return Response.json({ sources: [source], source, scripts: [{ kind: "rss", platform: "douyin", path: "/douyin/user/:id" }] });
  });
  model.methods.start();
  await new Promise(setImmediate);
  model.methods.edit_source("old");
  assert.equal(model.state.draft_tags.value, "文章, 科技");
  await model.methods.save_source();
  assert.equal(saved.category, "");
  assert.deepEqual(saved.tags, ["文章", "科技"]);
  assert.equal(saved.source_type, "x");
  model.methods.create_source();
  await new Promise(setImmediate);
  model.methods.set_draft("feed_url", "{{hostname}}/atom/douyin/user/a");
  assert.equal(model.state.draft_source_type.value, "douyin");
  model.methods.set_draft("source_type", "zhihu");
  model.methods.set_draft("feed_url", "{{hostname}}/rss/x/a");
  assert.equal(model.state.draft_source_type.value, "zhihu");
});


test("操作后刷新列表时较早的读取迟到不会覆盖最新订阅源或重设加载状态", async () => {
  const pending = [];
  const model = modal_model(() => new Promise(resolve => pending.push(resolve)));
  const first = model.methods.refresh_list();
  const latest = model.methods.refresh_list();
  pending[0](Response.json({ sources: [{ id: "old", title: "旧源", feed_url: "https://example.com/old" }] }));
  await first;
  assert.equal(model.state.sources.value.length, 0);
  assert.equal(model.state.loading.value, true);
  pending[1](Response.json({ sources: [{ id: "new", title: "最新源", feed_url: "https://example.com/new" }] }));
  await latest;
  assert.equal(model.state.sources.value[0].id, "new");
  assert.equal(model.state.loading.value, false);
});
