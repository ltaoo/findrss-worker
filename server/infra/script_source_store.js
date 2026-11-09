import { sha256_hex } from "../lib/crypto.js";
import { MAX_SCRIPT_BYTES } from "../lib/constants.js";
import { script_type } from "../lib/script_type.js";
import { ScriptVersionModel } from "../domain/script_version.js";

/** 源码对象不可变；缓存按估计的字符串内存限额，同一对象的冷读合并。 */
export class ScriptSourceStore {
  constructor(object_store, max_bytes = 24 * 1024 * 1024) {
    this.object_store = object_store;
    this.max_bytes = max_bytes;
    this.bytes = 0;
    this.cache = new Map();
    this.loading = new Map();
    this.writing = new Map();
    this.deleting = new Map();
    this.touched = new Map();
  }
  get available() { return this.object_store?.available === true; }
  remember(key, value) {
    const cost = value.source.length * 2;
    const old = this.cache.get(key);
    if (old !== undefined) this.bytes -= old.source.length * 2;
    this.cache.delete(key);
    if (cost > this.max_bytes) return;
    this.cache.set(key, value);
    this.bytes += cost;
    while (this.bytes > this.max_bytes) {
      const first = this.cache.keys().next().value;
      this.bytes -= this.cache.get(first).source.length * 2;
      this.cache.delete(first);
    }
  }
  async put(script_id, source, version = "") {
    const parsed = ScriptVersionModel.parse(version);
    if (!parsed.ok || parsed.model.version !== version) throw Object.assign(new Error("脚本源码版本号无效"), { status: 400 });
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > MAX_SCRIPT_BYTES) throw new Error("脚本超过 10MB 限制");
    const hash = await sha256_hex(source);
    const key = version ? `scripts/${script_id}/${version}.js` : `scripts/${script_id}/objects/${hash}.js`;
    const conflict = () => Object.assign(new Error("此版本号已用于其他源码，请使用新的版本号"), { status: 409 });
    if (!this.available) throw new Error("脚本 R2 存储不可用");
    this.touched.set(key, Date.now());
    await this.deleting.get(key);
    const cached = this.cache.get(key);
    if (cached && cached.hash !== hash) throw conflict();
    if (!cached) {
      let pending = this.writing.get(key);
      if (!pending) {
        pending = (async () => {
          const result = await this.object_store.put(key, source, { onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: { contentType: "application/javascript; charset=utf-8" } });
          if (result === null) {
            const object = await this.object_store.get(key);
            if (!object) throw new Error("脚本源码不存在");
            if (object.size !== bytes || await sha256_hex(await object.text()) !== hash) throw conflict();
          }
          const value = { source, hash, bytes };
          this.remember(key, value);
          return value;
        })().finally(() => this.writing.delete(key));
        this.writing.set(key, pending);
      }
      if ((await pending).hash !== hash) throw conflict();
    }
    return { key, hash, bytes };
  }
  async read(script_id, ref) {
    const prefix = `scripts/${script_id}/`;
    const version = typeof ref?.key === "string" && ref.key.startsWith(prefix) && ref.key.endsWith(".js")
      ? ref.key.slice(prefix.length, -3) : "";
    const parsed = ScriptVersionModel.parse(version, { required: true });
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.hash)
        || (ref.key !== `${prefix}objects/${ref.hash}.js` && !(parsed.ok && version === parsed.model.version))
        || !Number.isInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_SCRIPT_BYTES) throw new Error("脚本源码指针无效");
    // 已指向 R2 的脚本不能在缺少绑定时悄悄改用空源码。
    if (!this.available) throw new Error("脚本 R2 存储不可用");
    const cached = this.cache.get(ref.key);
    if (cached) {
      if (cached.bytes !== ref.bytes) throw new Error("脚本源码不存在或大小不符");
      if (cached.hash !== ref.hash) throw new Error("脚本源码完整性校验失败");
      this.remember(ref.key, cached);
      return cached.source;
    }
    let pending = this.loading.get(ref.key);
    if (!pending) {
      pending = (async () => {
        const object = await this.object_store.get(ref.key);
        if (!object) throw new Error("脚本源码不存在或大小不符");
        const source = await object.text();
        const bytes = new TextEncoder().encode(source).byteLength;
        if (bytes !== object.size) throw new Error("脚本源码完整性校验失败");
        const value = { source, bytes, hash: await sha256_hex(source) };
        this.remember(ref.key, value);
        return value;
      })().finally(() => this.loading.delete(ref.key));
      this.loading.set(ref.key, pending);
    }
    const value = await pending;
    if (value.bytes !== ref.bytes) throw new Error("脚本源码不存在或大小不符");
    if (value.hash !== ref.hash) throw new Error("脚本源码完整性校验失败");
    return value.source;
  }
  async hydrate(row) {
    const metadata = JSON.parse(row.metadata_json || "{}");
    const script = metadata.source_ref ? await this.read(row.route, metadata.source_ref) : String(row.script || "");
    if (metadata.published_source_ref) metadata.published_script = await this.read(row.route, metadata.published_source_ref);
    if (metadata.draft?.source_ref) metadata.draft.script = await this.read(row.route, metadata.draft.source_ref);
    return { ...row, script, source_loaded: true, metadata_json: JSON.stringify(metadata) };
  }
  async prune(script_id, referenced, before = Date.now() - 86400000) {
    if (!this.available) return;
    let cursor;
    do {
      const page = await this.object_store.list({ prefix: `scripts/${script_id}/`, cursor, limit: 100 });
      let references;
      for (const object of page.objects) {
        if (new Date(object.uploaded).getTime() >= before || (this.touched.get(object.key) || 0) >= before || (references ??= await referenced()).has(object.key)) continue;
        const cached = this.cache.get(object.key);
        if (cached !== undefined) { this.bytes -= cached.source.length * 2; this.cache.delete(object.key); }
        const pending = this.object_store.delete(object.key).finally(() => this.deleting.delete(object.key));
        this.deleting.set(object.key, pending);
        await pending;
        // await 期间可能发布新版本；再次检查引用，避免删除新产生的引用。
        references = undefined;
        this.touched.delete(object.key);
      }
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
  }
  async pack(row) {
    const metadata = JSON.parse(row.metadata_json || "{}");
    let script = row.script;
    metadata.kind = metadata.kind || metadata.script_type || script_type(script);
    if (this.available) {
      // 旧脚本可能尚无合法版本号，继续保留 hash 路径；新正式版本必须已通过发布校验。
      const published_version = ScriptVersionModel.parse(metadata.published_version || metadata.version, { required: true });
      const version = published_version.ok ? published_version.model.version : "";
      if (script || !metadata.source_ref) {
        metadata.source_ref = await this.put(row.route, String(script || ""), metadata.status === "draft" ? "" : version);
        metadata.script_hash = metadata.source_ref.hash;
        script = "";
      }
      if (typeof metadata.published_script === "string") {
        metadata.published_source_ref = await this.put(row.route, metadata.published_script, version);
        delete metadata.published_script;
      }
      if (typeof metadata.draft?.script === "string") {
        metadata.draft.source_ref = await this.put(row.route, metadata.draft.script);
        delete metadata.draft.script;
      }
    }
    const metadata_json = JSON.stringify(metadata);
    if (new TextEncoder().encode(metadata_json + String(script || "")).byteLength > 1800000) {
      throw Object.assign(new Error(this.available ? "脚本元数据过大，请缩小内嵌图标或路由声明" : "大脚本保存需要配置 API_STORAGE R2 存储"),
        { status: this.available ? 413 : 503 });
    }
    return { ...row, script, metadata_json };
  }
}
