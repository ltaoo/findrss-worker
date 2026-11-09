import { async_map } from "../server/lib/async_array.js";
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { snapshot_store } from "./support/snapshot_store.js";
import { RepositoryScript } from "../server/repository/script.js";
import { RepositoryScriptRelease } from "../server/repository/script_release.js";
import { RepositoryRssCookieGrant } from "../server/repository/rss_cookie_grant.js";
import { RepositoryDiscoverySource } from "../server/repository/discovery_source.js";
import { ServiceDiscovery } from "../server/service/application/discovery.js";
import { ScriptSourceStore } from "../server/infra/script_source_store.js";
import { RssRouteCache, rss_route_cache_key } from "../server/infra/rss_cache.js";
import api from "../api.js";
register("./support/quickjs_wasm_hook.js", import.meta.url);
const {
  ServiceScript
} = await import("../server/service/application/scripts.js");
const {
  route
} = await import("../application_router.js");
const source = (name, path = "/stored") => `export const route = { path: ${JSON.stringify(path)}, name: ${JSON.stringify(name)},
  handler() { return { title: ${JSON.stringify(name)}, items: [] }; } };`;
const edit = body => new Request("https://internal/_admin/scripts", {
  method: "POST",
  body: JSON.stringify(body)
});
function fixture(t) {
  const storage = snapshot_store();
  t.after(async () => await storage.db.close());
  const repo = {
    scripts: new RepositoryScript(storage),
    script_releases: new RepositoryScriptRelease(storage),
    rss_cookie_grants: new RepositoryRssCookieGrant(storage),
    rss_cookies: {
      get: () => []
    },
    discovery: {
      list_public_routes: () => [],
      list_private_routes: () => []
    },
    rss_route_cache: storage.repo,
    script_logs: {
      delete_for_route() {}
    }
  };
  const ports = {
    transaction: async fn => await storage.storage.transaction(fn),
    object_store: storage.object_store,
    route_cache: new RssRouteCache(60000, 100, {
      store: storage.repo,
      object_store: storage.object_store
    })
  };
  const service = new ServiceScript({
    repo,
    ports,
    app: {}
  });
  service.record_log = () => {};
  const create = async (script, version = "1.0.0", extra = {}) => (await service.create_script(edit({
    script,
    version,
    status: "published",
    ...extra
  }))).data.script;
  const generate = () => service.serve_rss_route("rss", "/stored", new Request("https://internal/_admin/feed/rss/stored"), {
    refresh: true
  });
  return {
    ...storage,
    repo,
    ports,
    service,
    create,
    generate
  };
}
test("正式源码和独立草稿保存在 R2；列表和快照命中不下载源码，详情按需读取", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  const row = await f.repo.scripts.find(first.id);
  assert.equal(row.script, "");
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.source_ref.key, "scripts/" + first.id + "/1.0.0.js");
  assert.equal(metadata.published_script, undefined);
  assert.equal((await f.repo.script_releases.list(first.id)).length, 1);
  assert.equal(f.sql.exec("SELECT script FROM script_releases").toArray()[0].script, "");
  const draft = source("未发布草稿");
  await f.service.update_script(edit({
    script: draft,
    status: "draft",
    version: "1.0.1"
  }), first.id);
  const saved = JSON.parse((await f.repo.scripts.find(first.id)).metadata_json);
  assert.equal(saved.draft.script, undefined);
  assert.equal(saved.source_ref.key, metadata.source_ref.key);
  assert.equal(saved.draft.source_ref.key, `scripts/${first.id}/objects/${saved.draft.source_ref.hash}.js`);
  assert.equal(await f.object_store.get(`scripts/${first.id}/1.0.1.js`), null);
  f.service.source_store = new ScriptSourceStore(f.object_store);
  const before = f.bucket.calls.get;
  const listed = (await f.service.list_scripts(new URL("https://internal/scripts?limit=10"))).scripts[0];
  assert.equal(listed.source_loaded, false);
  assert.equal(listed.script, "");
  assert.equal(listed.draft.script, "");
  assert.equal(f.bucket.calls.get, before);
  const detail = (await f.service.get_script(first.id)).script;
  assert.equal(detail.script, source("第一版"));
  assert.equal(detail.published_script, source("第一版"));
  assert.equal(detail.draft.script, draft);
  await f.generate();
  f.service.source_store = new ScriptSourceStore(f.object_store);
  const reads = f.bucket.calls.get;
  assert.match((await f.service.serve_rss_route("rss", "/stored", new Request("https://internal/_public/feed/rss/stored", {
    headers: {
      "X-Api-Access-Token-ID": "reader"
    }
  }))).body, /第一版/);
  assert.equal(f.bucket.calls.get, reads);
});
test("回退切换历史版本并保留草稿，后续新版本须高于历史最高版本", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  const first_id = first.current_release_id;
  await f.service.update_script(edit({
    script: source("第二版"),
    status: "published",
    version: "2.0.0"
  }), first.id);
  await f.service.update_script(edit({
    script: "// 未完成草稿",
    status: "draft",
    version: "3.0.0"
  }), first.id);
  const reverted = (await f.service.rollback_script(edit({
    release_id: first_id
  }), first.id)).script;
  assert.equal(reverted.version, "1.0.0");
  assert.equal(reverted.max_published_version, "2.0.0");
  assert.equal(reverted.draft.script, "// 未完成草稿");
  assert.equal(reverted.script, source("第一版"));
  assert.match((await f.generate()).body, /第一版/);
  assert.equal((await (await f.service.list_script_versions(first.id)).versions.find(value => value.id === first_id)).current, true);
  assert.equal((await f.service.list_script_versions(first.id)).events[0].action, "rollback");
  await assert.rejects(f.service.update_script(edit({
    script: source("中间版"),
    status: "published",
    version: "1.5.0"
  }), first.id), /版本号必须高于/);
  const next = (await f.service.update_script(edit({
    script: source("第三版"),
    status: "published",
    version: "3.0.0"
  }), first.id)).script;
  assert.equal(next.version, "3.0.0");
  assert.equal((await f.service.list_script_versions(first.id)).versions.length, 3);
  await assert.rejects(f.service.rollback_script(edit({
    release_id: first_id,
    expected_release_id: first_id
  }), first.id), /当前版本已变化/);
});
test("回退前校验路由冲突、配置和源码完整性，失败时不切换正式版本", async t => {
  const f = fixture(t);
  const first = await f.create(source("旧路径"));
  await f.service.update_script(edit({
    script: source("新路径", "/new"),
    status: "published",
    version: "2.0.0"
  }), first.id);
  const other = await f.create(source("占用旧路径"));
  await assert.rejects(f.service.rollback_script(edit({
    release_id: first.current_release_id
  }), first.id), /route.path 已存在/);
  assert.equal((await f.service.get_script(first.id)).script.version, "2.0.0");
  await f.service.delete_script(other.id);
  const release = await f.repo.script_releases.find(first.id, first.current_release_id);
  const ref = JSON.parse(release.metadata_json).source_ref;
  await f.bucket.put(ref.key, "被修改的对象");
  f.service.source_store = new ScriptSourceStore(f.object_store);
  await assert.rejects(f.service.rollback_script(edit({
    release_id: first.current_release_id
  }), first.id), /不存在或大小不符/);
  assert.equal(JSON.parse((await f.repo.scripts.find(first.id)).metadata_json).version, "2.0.0");
});
test("上传失败或上传期间发生并发修改时，旧正式版本和历史索引保持一致", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  f.bucket.fail_next({
    op: "put"
  });
  await assert.rejects(f.service.update_script(edit({
    script: source("失败版"),
    status: "published",
    version: "2.0.0"
  }), first.id), /put failed/);
  assert.equal((await f.repo.script_releases.list(first.id)).length, 1);
  assert.equal((await f.service.get_script(first.id)).script.version, "1.0.0");
  const put = await f.object_store.put.bind(f.object_store);
  f.object_store.put = async (...args) => {
    const result = await put(...args);
    const row = await f.repo.scripts.find(first.id);
    await f.repo.scripts.update({
      ...row,
      enabled: 0
    });
    return result;
  };
  await assert.rejects(f.service.update_script(edit({
    script: source("并发版"),
    status: "published",
    version: "2.0.0"
  }), first.id), /脚本已更新/);
  assert.equal((await f.repo.script_releases.list(first.id)).length, 1);
  assert.equal(JSON.parse((await f.repo.scripts.find(first.id)).metadata_json).version, "1.0.0");
});
test("旧 SQLite 脚本可分批迁入 R2，重复迁移不重复建立版本且保留精确源码", async t => {
  const f = fixture(t);
  await f.repo.scripts.insert({
    route: "legacy",
    title: "旧脚本",
    path: "/stored",
    script: source("原始源码"),
    metadata_json: JSON.stringify({
      name: "旧脚本",
      path: "/stored",
      version: "1.2.3",
      status: "published"
    }),
    enabled: 1,
    created_at: 1,
    updated_at: 2
  });
  await f.service.migrate_script_storage();
  await f.service.migrate_script_storage();
  assert.equal((await f.repo.scripts.find("legacy")).script, "");
  assert.equal((await f.repo.script_releases.list("legacy")).length, 1);
  assert.equal(JSON.parse((await f.repo.scripts.find("legacy")).metadata_json).source_ref.key, "scripts/legacy/1.2.3.js");
  assert.equal((await f.service.get_script("legacy")).script.script, source("原始源码"));
  assert.equal((await f.service.list_script_versions("legacy")).events[0].action, "migrate");
});
test("数据库事务失败时同时回滚正式指针、版本索引和发布事件", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  f.repo.platforms = {
    collect() {
      throw new Error("platform write failed");
    }
  };
  await assert.rejects(f.service.update_script(edit({
    script: source("失败版"),
    status: "published",
    version: "2.0.0"
  }), first.id), /platform write failed/);
  assert.equal((await f.service.get_script(first.id)).script.version, "1.0.0");
  assert.equal((await f.repo.script_releases.list(first.id)).length, 1);
  assert.equal((await f.repo.script_releases.events(first.id)).length, 1);
});
test("源码冷读并发合并、缺少 R2 绑定失败且拒绝跨脚本对象指针", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  const ref = JSON.parse((await f.repo.scripts.find(first.id)).metadata_json).source_ref;
  const store = new ScriptSourceStore(f.object_store);
  const before = f.bucket.calls.get;
  const results = await Promise.all([store.read(first.id, ref), store.read(first.id, ref)]);
  assert.equal(results[0], source("第一版"));
  assert.equal(f.bucket.calls.get, before + 1);
  await assert.rejects(store.read("other-script", ref), /指针无效/);
  await assert.rejects(new ScriptSourceStore(null).read(first.id, ref), /R2 存储不可用/);
});
test("空草稿也能从 R2 加载，详情标记源码已加载以避免编辑器重复请求", async t => {
  const f = fixture(t);
  const created = (await f.service.create_script(edit({
    script: "",
    status: "draft"
  }))).data.script;
  assert.equal(created.source_loaded, true);
  assert.equal(created.script, "");
  assert.equal((await f.service.get_script(created.id)).script.source_loaded, true);
});
test("正式版本对象不可覆盖，冷缓存重复写入复用同源码，冲突不污染缓存", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  const ref = JSON.parse((await f.repo.scripts.find(first.id)).metadata_json).source_ref;
  const store = new ScriptSourceStore(f.object_store);
  await assert.rejects(store.put(first.id, source("其他版"), "1.0.0"), error => error.status === 409);
  assert.equal(await store.read(first.id, ref), source("第一版"));
  assert.deepEqual(await new ScriptSourceStore(f.object_store).put(first.id, source("第一版"), "1.0.0"), ref);
  await assert.rejects(store.put(first.id, source("其他版"), "1.0.0"), error => error.status === 409);
  assert.equal(await (await f.object_store.get(ref.key)).text(), source("第一版"));
  for (const version of ["../1.0.0", "01.0.0", "1.0.0/extra", " 1.0.0 "]) {
    await assert.rejects(store.put(first.id, source("第一版"), version), error => error.status === 400);
    await assert.rejects(store.read(first.id, {
      ...ref,
      key: `scripts/${first.id}/${version}.js`
    }), /指针无效/);
  }
});
test("相同版本并发写入不同源码时仅一个成功，同一 Store 和跨 Store 均不能覆盖", async t => {
  const f = fixture(t);
  for (const separate of [false, true]) {
    const store = new ScriptSourceStore(f.object_store);
    const other = separate ? new ScriptSourceStore(f.object_store) : store;
    const id = separate ? "separate" : "shared";
    const results = await Promise.allSettled([store.put(id, source("版本 A"), "1.0.0"), other.put(id, source("版本 B"), "1.0.0")]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.equal((await results.find(value => value.status === "rejected")).reason.status, 409);
    const winner = results.findIndex(value => value.status === "fulfilled");
    assert.equal(await new ScriptSourceStore(f.object_store).read(id, results[winner].value), source(winner === 0 ? "版本 A" : "版本 B"));
  }
});
test("版本路径的源码指针即使命中缓存或合并冷读也校验 hash 和字节数", async t => {
  const f = fixture(t);
  const ref = await f.service.source_store.put("checked", source("第一版"), "1.0.0");
  const wrong = {
    ...ref,
    hash: "0".repeat(64)
  };
  await assert.rejects(f.service.source_store.read("checked", wrong), /完整性校验失败/);
  await assert.rejects(f.service.source_store.read("checked", {
    ...ref,
    bytes: ref.bytes + 1
  }), /大小不符/);
  const store = new ScriptSourceStore(f.object_store);
  const results = await Promise.allSettled([store.read("checked", ref), store.read("checked", wrong)]);
  assert.equal(results[0].value, source("第一版"));
  assert.match(results[1].reason.message, /完整性校验失败/);
  await assert.rejects(store.hydrate({
    route: "checked",
    metadata_json: JSON.stringify({
      source_ref: ref,
      published_source_ref: wrong
    })
  }), /完整性校验失败/);
});
test("旧 hash 路径的正式版和历史版本仍可读取、发布新版并回退", async t => {
  const f = fixture(t);
  const first = await f.create(source("旧版"));
  const ref = await f.service.source_store.put(first.id, source("旧版"));
  for (const table of ["scripts", "script_releases"]) {
    const row = f.sql.exec(`SELECT metadata_json FROM ${table}`).toArray()[0];
    const metadata = {
      ...JSON.parse(row.metadata_json),
      source_ref: ref,
      published_source_ref: ref
    };
    f.sql.exec(`UPDATE ${table} SET metadata_json = ?`, JSON.stringify(metadata));
  }
  await f.object_store.delete(`scripts/${first.id}/1.0.0.js`);
  f.service.source_store = new ScriptSourceStore(f.object_store);
  assert.equal((await f.service.get_script(first.id)).script.script, source("旧版"));
  assert.equal((await f.service.get_script_version(first.id, first.current_release_id)).version.script, source("旧版"));
  await f.service.update_script(edit({
    script: source("新版"),
    status: "published",
    version: "2.0.0"
  }), first.id);
  const reverted = (await f.service.rollback_script(edit({
    release_id: first.current_release_id
  }), first.id)).script;
  assert.equal(reverted.version, "1.0.0");
  assert.equal(reverted.script, source("旧版"));
  assert.equal(await f.service.source_store.read(first.id, ref), source("旧版"));
});
test("反复保存和发布独立草稿、退回草稿均不占用或覆盖正式版本对象", async t => {
  const f = fixture(t);
  const first = (await f.service.create_script(edit({
    script: source("草稿 A"),
    status: "draft",
    version: "1.0.0"
  }))).data.script;
  await f.service.update_script(edit({
    script: source("草稿 B"),
    status: "draft",
    version: "1.0.0"
  }), first.id);
  assert.equal(await f.object_store.get(`scripts/${first.id}/1.0.0.js`), null);
  await f.service.update_script(edit({
    script: source("第一版"),
    status: "published",
    version: "1.0.0"
  }), first.id);
  await f.service.update_script(edit({
    script: source("草稿 C"),
    status: "draft",
    version: "2.0.0"
  }), first.id);
  await f.service.update_script(edit({
    script: source("草稿 D"),
    status: "draft",
    version: "2.0.0"
  }), first.id);
  const second = (await f.service.update_script(edit({
    status: "published",
    version: "2.0.0"
  }), first.id)).script;
  assert.equal(second.script, source("草稿 D"));
  await f.service.update_script(edit({
    status: "draft"
  }), first.id);
  const metadata = JSON.parse((await f.repo.scripts.find(first.id)).metadata_json);
  assert.equal(metadata.source_ref.key, `scripts/${first.id}/objects/${metadata.source_ref.hash}.js`);
  assert.equal(metadata.published_source_ref.key, `scripts/${first.id}/2.0.0.js`);
  assert.equal(await (await f.object_store.get(`scripts/${first.id}/1.0.0.js`)).text(), source("第一版"));
  assert.equal(await (await f.object_store.get(`scripts/${first.id}/2.0.0.js`)).text(), source("草稿 D"));
});
test("回退复用对应版本未撤销的 Cookie 授权，已撤销授权必须重新确认", async t => {
  const f = fixture(t);
  const permissions = {
    cookies: [{
      id: "session",
      origin: "https://example.com",
      path_prefix: "/",
      names: ["SID"],
      purpose: "读取内容"
    }]
  };
  const first_source = `export const permissions = ${JSON.stringify(permissions)};\n` + source("第一版");
  const second_source = first_source.replaceAll("第一版", "第二版");
  let info;
  await assert.rejects(f.create(first_source), error => {
    info = error.details?.cookie_permissions;
    return error.status === 409 && !!info;
  });
  const grant = await f.service.approve_cookie_grant(edit({
    ...info,
    script: first_source,
    confirmed: true
  }));
  const first = await f.create(first_source, "1.0.0", {
    cookie_grant_id: grant.cookie_grant_id
  });
  await assert.rejects(f.service.update_script(edit({
    script: second_source,
    status: "published",
    version: "2.0.0"
  }), first.id), error => {
    info = error.details?.cookie_permissions;
    return error.status === 409 && !!info;
  });
  const second_grant = await f.service.approve_cookie_grant(edit({
    ...info,
    script: second_source,
    confirmed: true
  }));
  const second = (await f.service.update_script(edit({
    script: second_source,
    status: "published",
    version: "2.0.0",
    cookie_grant_id: second_grant.cookie_grant_id
  }), first.id)).script;
  const reverted = (await f.service.rollback_script(edit({
    release_id: first.current_release_id
  }), first.id)).script;
  assert.equal(reverted.cookie_grant_id, grant.cookie_grant_id);
  await f.service.revoke_cookie_grant(first.id);
  await assert.rejects(f.service.rollback_script(edit({
    release_id: second.current_release_id
  }), first.id), error => {
    info = error.details?.cookie_permissions;
    return error.status === 409 && info?.version === "2.0.0";
  });
  assert.equal((await f.service.get_script(first.id)).script.version, "1.0.0");
  const renewed = await f.service.approve_cookie_grant(edit({
    ...info,
    script: second_source,
    confirmed: true
  }));
  assert.equal((await f.service.rollback_script(edit({
    release_id: second.current_release_id,
    cookie_grant_id: renewed.cookie_grant_id
  }), first.id)).script.version, "2.0.0");
});
test("回退不会用不兼容的当前配置激活旧版本", async t => {
  const f = fixture(t);
  const schema = {
    type: "object",
    properties: {
      channel: {
        type: "string",
        minLength: 1
      }
    },
    required: ["channel"],
    additionalProperties: false
  };
  const old = `export const config_schema = ${JSON.stringify(schema)};\n` + source("需配置版本");
  const first = await f.create(old, "1.0.0", {
    config: {
      channel: "example"
    }
  });
  await f.service.update_script(edit({
    script: source("不需配置版本"),
    status: "published",
    version: "2.0.0",
    config: {}
  }), first.id);
  await assert.rejects(f.service.rollback_script(edit({
    release_id: first.current_release_id
  }), first.id), /旧版本配置不兼容/);
  assert.equal((await f.service.get_script(first.id)).script.version, "2.0.0");
});
test("孤立源码延迟回收，当前正式版、历史版本及草稿对象均保留", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  await f.service.update_script(edit({
    script: source("第二版"),
    status: "published",
    version: "2.0.0"
  }), first.id);
  await f.service.update_script(edit({
    script: "// 草稿",
    status: "draft"
  }), first.id);
  const orphan = await f.service.source_store.put(first.id, "// 未提交成功的源码");
  const orphan_version = await f.service.source_store.put(first.id, "// 未提交的正式版", "3.0.0");
  const metadata = JSON.parse((await f.repo.scripts.find(first.id)).metadata_json);
  const refs = new Set([metadata.source_ref.key, metadata.draft.source_ref.key, ...(await async_map(await f.repo.script_releases.list(first.id), async release => JSON.parse((await f.repo.script_releases.find(first.id, release.id)).metadata_json).source_ref.key))]);
  await f.service.source_store.prune(first.id, () => refs);
  assert.ok(await f.object_store.get(orphan.key));
  assert.ok(await f.object_store.get(orphan_version.key));
  await f.service.source_store.prune(first.id, () => refs, Date.now() + 1000);
  assert.equal(await f.object_store.get(orphan.key), null);
  assert.equal(await f.object_store.get(orphan_version.key), null);
  for (const key of refs) assert.ok(await f.object_store.get(key));
  await f.service.delete_script(first.id);
  assert.equal((await f.object_store.list({
    prefix: `scripts/${first.id}/`
  })).objects.length, 0);
});
test("版本接口只允许管理员访问，支持历史源码查询和回退", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  const env = {
    ADMIN_PASSWORD: "test-admin",
    APPLICATION: (() => ({
      fetch: request => route(request, {
        scripts: f.service
      })
    }))()
  };
  const path = "/admin/api/scripts/" + first.id + "/versions";
  assert.equal((await api.fetch(new Request("https://feeds.example" + path), env)).status, 401);
  const headers = {
    Authorization: "Bearer test-admin"
  };
  const versions = await api.fetch(new Request("https://feeds.example" + path, {
    headers
  }), env);
  assert.equal(versions.status, 200);
  assert.equal((await versions.json()).versions.length, 1);
  const detail = await api.fetch(new Request("https://feeds.example" + path + "/" + first.current_release_id, {
    headers
  }), env);
  assert.equal((await detail.json()).version.script, source("第一版"));
  const rollback = await api.fetch(new Request("https://feeds.example/admin/api/scripts/" + first.id + "/rollback", {
    method: "POST",
    headers,
    body: JSON.stringify({
      release_id: first.current_release_id
    })
  }), env);
  assert.equal(rollback.status, 200);
});
test("切换版本后旧的快照生成任务不能覆盖新版本输出", async t => {
  const f = fixture(t);
  let finish, started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    started();
    return new Promise(resolve => {
      finish = resolve;
    });
  };
  const old = source("第一版").replace('handler() {', 'async handler(ctx) { await ctx.fetchText("https://example.com/wait");');
  const first = await f.create(old);
  const pending = f.generate();
  const rejected = assert.rejects(pending, /运行版本已切换/);
  await waiting;
  await f.service.update_script(edit({
    script: source("第二版"),
    version: "2.0.0",
    status: "published"
  }), first.id);
  assert.match((await f.generate()).body, /第二版/);
  finish(new Response("ready"));
  await rejected;
  const cached = await f.ports.route_cache.resolve("private-snapshot:" + rss_route_cache_key("/stored", []), Date.now());
  assert.match(await cached.rendered.get("rss\n"), /第二版/);
});
test("发布强制刷新关联订阅源，旧的广场文章任务迟到也不能覆盖新版文章", async t => {
  const f = fixture(t);
  const first = await f.create(source("第一版"));
  f.repo.discovery = new RepositoryDiscoverySource(f);
  let finish,
    started,
    calls = 0;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const discovery = new ServiceDiscovery({
    repo: f.repo,
    public_origin: "https://feeds.example",
    route_cache: f.ports.route_cache,
    load_snapshot: async () => {
      if (calls++ === 0) {
        started();
        return new Promise(resolve => {
          finish = resolve;
        });
      }
      return [{
        title: "新版文章"
      }];
    }
  });
  discovery.publish_catalog = async () => {};
  f.service.app.discovery = discovery;
  const source_id = (await discovery.create_discovery_source(edit({
    title: "源",
    feed_url: "{{hostname}}/rss/stored",
    require_token: false
  }))).data.source.id;
  const previous = discovery.refresh_discovery_snapshot(source_id);
  await waiting;
  const tasks = [];
  f.ports.wait_until = pending => tasks.push(pending);
  await f.service.update_script(edit({
    script: source("第二版"),
    status: "published",
    version: "2.0.0"
  }), first.id);
  await Promise.all(tasks);
  finish([{
    title: "旧版迟到文章"
  }]);
  await previous;
  const snapshot = await f.repo.discovery.snapshot_get(source_id);
  assert.equal(snapshot.error, "");
  assert.equal(JSON.parse(snapshot.articles_json)[0].title, "新版文章");
});
for (const async_references of [false, true]) test(`源码清理复用${async_references ? "异步" : "同步"}引用集合，在删除等待期间产生的新引用会重新检查`, async () => {
  let checks = 0;
  const refs = new Set(["scripts/test/retained.js"]),
    deleted = [];
  const store = new ScriptSourceStore({
    available: true,
    async list() {
      return {
        truncated: false,
        objects: ["retained.js", "orphan.js", "new.js", "retained.js"].map(name => ({
          key: "scripts/test/" + name,
          uploaded: "2000-01-01"
        }))
      };
    },
    async delete(key) {
      deleted.push(key);
      await refs.add("scripts/test/new.js");
    }
  });
  await store.prune("test", () => {
    checks++;
    return async_references ? Promise.resolve(new Set(refs)) : new Set(refs);
  });
  assert.deepEqual(deleted, ["scripts/test/orphan.js"]);
  assert.equal(checks, 2);
});
test("异步读取源码引用失败时终止清理，不删除对象", async () => {
  const deleted = [];
  const store = new ScriptSourceStore({
    available: true,
    async list() {
      return { truncated: false, objects: [{ key: "scripts/test/source.js", uploaded: "2000-01-01" }] };
    },
    async delete(key) {
      deleted.push(key);
    }
  });
  await assert.rejects(store.prune("test", async () => {
    throw new Error("引用查询失败");
  }), /引用查询失败/);
  assert.deepEqual(deleted, []);
});
