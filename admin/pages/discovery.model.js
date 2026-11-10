import { format_datetime } from "../../server/lib/datetime.js";
import { ListPaginationModel } from "../components/pagination.js";
import { PollPolicyModel } from "../components/poll_policy.model.js";
import {
  discovery_platforms,
  discovery_platform_id,
} from "../components/discovery_platform.js";
import { RssRoutePatternModel } from "../../server/domain/rss_route.js";

const Timeless = window.FindRSSAdminUI;
const fetch = window.FindRSSAdminAuth.fetch;
const { combine, computed, ref, refarr } = Timeless;

const legacy_category_tags = {
  technology: "科技",
  development: "开发",
  business: "商业",
  science: "科学",
  design: "设计",
  life: "生活",
};

const feed_host_token = "{{hostname}}";

const feed_host_placeholder = "https://template.invalid";

function is_template_feed_url(value) {
  return String(value || "").startsWith(feed_host_token);
}

function is_managed_rss_url(value) {
  const text = String(value || "");
  const candidate = is_template_feed_url(text)
    ? feed_host_placeholder + text.slice(feed_host_token.length)
    : text;
  try {
    const url = new URL(candidate);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.pathname.startsWith("/rss/") || url.pathname.startsWith("/atom/"))
    );
  } catch {
    return false;
  }
}

/**
 * 自有 RSS/Atom 地址按匹配的脚本路由预填来源，其余归为网页。
 */
function infer_source_route(feed_url, scripts) {
  const text = String(feed_url || "");
  const candidate = is_template_feed_url(text)
    ? feed_host_placeholder + text.slice(feed_host_token.length)
    : text;
  let pathname;
  try {
    pathname = new URL(candidate).pathname;
  } catch {
    return null;
  }
  const match = /^\/(?:rss|atom)(\/.*)$/.exec(pathname);
  if (!match) return null;
  return scripts
    .filter((script) => script.status !== "draft")
    .flatMap((script) => script.routes || [script])
    .find((entry) =>
      RssRoutePatternModel.fromValue(entry.path)?.match(match[1]),
    );
}

function infer_source_type(feed_url, scripts) {
  return discovery_platform_id(infer_source_route(feed_url, scripts)?.platform);
}

function infer_source_tags(feed_url, scripts) {
  return infer_source_route(feed_url, scripts)?.tags || [];
}

/** @param {unknown} value 头像只接受站内相对路径（服务端返回 `/public/avatar/...`）。*/
function safe_avatar_url(value) {
  if (typeof value !== "string") return "";
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2048)
    return "";
  return path;
}

function normalize_source(source) {
  const social_urls = Array.isArray(source.social_urls) ? source.social_urls.map(String)
    : source.social_url ? [String(source.social_url)] : [];
  return {
    id: String(source.id || ""),
    title: String(source.title || ""),
    description: String(source.description || ""),
    website: String(source.website || ""),
    social_url: social_urls[0] || "",
    social_urls,
    feed_url: String(source.feed_url || ""),
    // 服务端已把 {{hostname}} 展开成当前环境的绝对地址；这里留着存储原文供编辑回填。
    feed_url_template: String(source.feed_url_template || ""),
    tags: [
      ...new Set(
        [
          ...(Array.isArray(source.tags) ? source.tags.map(String) : []),
          legacy_category_tags[source.category],
        ].filter(Boolean),
      ),
    ],
    enabled: source.enabled === true,
    require_token: source.require_token === true,
    credit_cost: Number(source.credit_cost ?? 1),
    sort_order: Number(source.sort_order || 0),
    source_type: String(source.source_type || "website"),
    poll_policy: source.poll_policy || { mode: "inherit" },
    poll_effective: source.poll_effective || null,
    next_snapshot_at: source.next_snapshot_at ?? null,
    avatar_url: safe_avatar_url(source.avatar_url),
    created_at: Number(source.created_at || 0),
    updated_at: Number(source.updated_at || 0),
    cache: source.cache || null,
    snapshot: source.snapshot || { saved_at: 0, articles: [], error: "" },
  };
}

async function request_json(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "请求失败：HTTP " + response.status);
  }
  return payload;
}

function DiscoveryAdminViewModel() {
  const poll_editor = PollPolicyModel({ ui: Timeless });
  const sources_ = refarr([]);
  const source_updating_ = ref([]);
  const platforms_ = ref(discovery_platforms());
  const tags_ = ref([]);
  const snapshot_refreshing_ = ref([]);
  const local_refreshing = new Set();
  let background_refreshing = new Set();
  let task_generation = 0;
  let stop_realtime = null;
  let active = true, sync_pending = false, sync_sources = false, syncing = null;
  let task_error = "";
  let disposed = false;
  const snapshot_errors_ = ref(new Map());
  const catalog_errors_ = ref(new Map());
  const scripts_ = ref([]);
  const scripts_error_ = ref("");
  const scripts_loading_ = ref(false);
  const query_ = ref("");
  const filter_platform_ = ref("all");
  const filter_status_ = ref("enabled");
  const filter_visibility_ = ref("all");
  const selected_sources = new Map();
  const known_sources = new Map();
  let loaded_page = -1;
  const draft_title_ = ref("");
  const draft_feed_url_ = ref("");
  const draft_website_ = ref("");
  const draft_social_urls_ = ref([]);
  const draft_social_url_ = computed(draft_social_urls_, values => values[0] || "");
  const draft_description_ = ref("");
  const draft_tags_ = ref("");
  const draft_sort_order_ = ref("0");
  const draft_enabled_ = ref(true);
  const draft_require_token_ = ref(true);
  const draft_credit_cost_ = ref("1");
  const draft_source_type_ = ref("website");
  // 手改过「来源」之后就不再按地址自动预判（否则用户的选择会被下一次输入覆盖）。
  const source_type_touched_ = ref(false);
  const tags_touched_ = ref(false);
  const avatar_file_ = ref(null);
  // 记住 file input 的 DOM 节点：上传成功后要把它的 value 清空，否则同一个文件选不了第二次。
  let avatar_input_node = null;
  const editing_id_ = ref("");
  const form_open_ = ref(false);
  const loading_ = ref(false);
  const selected_ids_ = ref([]);
  const bulk_busy_ = ref(false);
  const bulk_message_ = ref("");
  const recovery_busy_ = ref(false);
  const recovery_message_ = ref("");
  const saving_ = ref(false);
  const previewing_ = ref(false);
  const preview_avatar_ = ref("");
  let preview_generation = 0;
  let preview_id = "";
  const list_error_ = ref("");
  const form_error_ = ref("");
  const form_message_ = ref("");
  const import_open_ = ref(false);
  const import_text_ = ref("");
  const import_error_ = ref("");
  const import_message_ = ref("");
  const import_busy_ = ref(false);
  const import_reading_ = ref(false);
  let import_generation = 0;

  const state = {
    sources: sources_,
    source_updating: source_updating_,
    platforms: platforms_,
    tags: tags_,
    platform_options: computed(platforms_, (platforms) =>
      platforms.map((type) => ({ value: type.id, label: type.label })),
    ),
    filter_platform_options: computed(platforms_, (platforms) => [
      { value: "all", label: "全部来源" },
      ...platforms.map((type) => ({ value: type.id, label: type.label })),
    ]),
    snapshot_refreshing: snapshot_refreshing_,
    snapshot_errors: snapshot_errors_,
    catalog_errors: catalog_errors_,
    scripts: scripts_,
    scripts_error: scripts_error_,
    scripts_loading: scripts_loading_,
    query: query_,
    filter_platform: filter_platform_,
    filter_status: filter_status_,
    filter_visibility: filter_visibility_,
    draft_title: draft_title_,
    draft_feed_url: draft_feed_url_,
    draft_website: draft_website_,
    draft_social_url: draft_social_url_,
    draft_social_urls: draft_social_urls_,
    draft_description: draft_description_,
    draft_tags: draft_tags_,
    draft_sort_order: draft_sort_order_,
    draft_enabled: draft_enabled_,
    draft_require_token: draft_require_token_,
    draft_credit_cost: draft_credit_cost_,
    draft_source_type: draft_source_type_,
    avatar_file: avatar_file_,
    editing_id: editing_id_,
    form_open: form_open_,
    loading: loading_,
    selected_ids: selected_ids_,
    bulk_busy: bulk_busy_,
    bulk_message: bulk_message_,
    recovery_busy: recovery_busy_,
    recovery_message: recovery_message_,
    saving: saving_,
    previewing: previewing_,
    preview_avatar: preview_avatar_,
    list_error: list_error_,
    form_error: form_error_,
    form_message: form_message_,
    import_open: import_open_,
    import_text: import_text_,
    import_error: import_error_,
    import_message: import_message_,
    import_busy: import_busy_,
    import_reading: import_reading_,
  };

  async function load() {
    return pagination.load();
  }

  function sync_refreshing() {
    snapshot_refreshing_.set([...new Set([...local_refreshing, ...background_refreshing])]);
  }

  function invalidate_tasks() {
    task_generation++;
  }

  async function load_background_tasks({ reload_completed = false } = {}) {
    invalidate_tasks();
    const generation = task_generation;
    const source_ids = sources_.value.map(source => source.id);
    if (disposed || !active) return;
    if (!source_ids.length) {
      background_refreshing.clear();
      sync_refreshing();
      return;
    }
    try {
      const payload = await request_json("/admin/api/background-tasks?source_ids=" + encodeURIComponent(source_ids.join(",")));
      if (disposed || generation !== task_generation) return;
      if (task_error && list_error_.value === task_error) list_error_.set("");
      task_error = "";
      const visible_ids = new Set(source_ids);
      const running = new Set((payload.tasks || [])
        .filter(task => ["queued", "running"].includes(task.status) && visible_ids.has(task.source_id))
        .map(task => task.source_id));
      const completed = [...background_refreshing].some(id => visible_ids.has(id) && !running.has(id));
      background_refreshing = running;
      sync_refreshing();
      if (reload_completed && completed) {
        await pagination.load(pagination.page.value, { background: true });
        return;
      }
    } catch (error) {
      if (disposed || generation !== task_generation) return;
      task_error = "后台任务加载失败：" + (error.message || String(error));
      list_error_.set(task_error);
    }
  }

  function receive_change(event) {
    if (disposed || !active || event.type === "realtime.disconnected" || (event.type === "realtime.connected" && !event.reconnected)) return;
    if (event.ids?.length && sources_.value.length && !sources_.value.some(source => event.ids.includes(source.id))) return;
    sync_sources ||= event.type === "discovery.changed" || event.type === "realtime.connected";
    sync_pending = true;
    if (syncing) return;
    syncing = Promise.resolve().then(async () => {
      while (sync_pending && active && !disposed) {
        sync_pending = false;
        const reload = sync_sources; sync_sources = false;
        if (reload) await pagination.load(pagination.page.value, { background: true });
        else await load_background_tasks({ reload_completed: true });
      }
    }).finally(() => { syncing = null; });
  }

  async function load_scripts() {
    if (scripts_loading_.value) return;
    scripts_loading_.set(true);
    scripts_error_.set("");
    try {
      const payload = await request_json("/admin/api/scripts?kind=rss");
      scripts_.set(Array.isArray(payload.scripts) ? payload.scripts : []);
      if (editing_id_.value === "" && !tags_touched_.value)
        draft_tags_.set(infer_source_tags(draft_feed_url_.value, scripts_.value).join(", "));
      if (editing_id_.value === "" && !source_type_touched_.value)
        draft_source_type_.set(
          infer_source_type(draft_feed_url_.value, scripts_.value),
        );
    } catch (error) {
      scripts_error_.set(
        "脚本路由提示加载失败：" +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      scripts_loading_.set(false);
    }
  }

  function draft_payload() {
    const sort_order = Number(draft_sort_order_.value);
    const credit_cost = Number(draft_credit_cost_.value);
    if (!draft_credit_cost_.value.trim() || !Number.isInteger(credit_cost) || credit_cost < 0 || credit_cost > 1_000_000_000) {
      throw new Error("每次访问消耗积分必须为 0 到 1000000000 的整数");
    }
    const social_urls = [...new Set(draft_social_urls_.value.map(value => value.trim()).filter(Boolean))];
    return {
      title: draft_title_.value.trim(),
      feed_url: draft_feed_url_.value.trim(),
      website: draft_website_.value.trim(),
      social_url: social_urls[0] || "",
      social_urls,
      description: draft_description_.value.trim(),
      category: "",
      tags: draft_tags_.value
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
      enabled: draft_enabled_.value === true,
      require_token: draft_require_token_.value === true,
      credit_cost,
      sort_order: Number.isInteger(sort_order) ? sort_order : 0,
      source_type: draft_source_type_.value || "website",
      poll_policy: poll_editor.methods.value(),
    };
  }

  function matches_filters(source) {
    if (filter_status_.value === "enabled" && !source.enabled) return false;
    if (filter_status_.value === "disabled" && source.enabled) return false;
    if (filter_visibility_.value === "public" && source.require_token) return false;
    if (filter_visibility_.value === "private" && !source.require_token) return false;
    if (filter_platform_.value !== "all" && source.source_type !== filter_platform_.value) return false;
    const query = query_.value.trim().slice(0, 100).toLowerCase();
    return !query || [source.title, source.description, source.website, source.social_url,
      ...(source.social_urls || []), source.feed_url_template || source.feed_url,
      JSON.stringify(source.tags)].some(value => String(value || "").toLowerCase().includes(query));
  }

  /** 用接口返回值更新当前页及总数；不再匹配筛选的记录直接移出。 */
  function apply_source(source, { created = false } = {}) {
    const previous = known_sources.get(source.id) || sources_.value.find(item => item.id === source.id) || selected_sources.get(source.id);
    const matches = matches_filters(source);
    if (created || previous) {
      const delta = Number(matches) - Number(!created && previous && matches_filters(previous));
      pagination.total.set(Math.max(0, pagination.total.value + delta));
    }
    known_sources.set(source.id, source);
    if (selected_ids_.value.includes(source.id)) selected_sources.set(source.id, source);
    if (!matches) {
      sources_.as(sources_.value.filter(item => item.id !== source.id));
      selected_ids_.set(selected_ids_.value.filter(id => id !== source.id));
      selected_sources.delete(source.id);
      return;
    }
    sources_.as(created
      ? [source, ...sources_.value.filter(item => item.id !== source.id)].slice(0, pagination.page_size.value)
      : sources_.value.map(item => item.id === source.id ? source : item));
  }

  async function fill_empty_page() {
    if (sources_.value.length || !pagination.total.value) {
      pagination.page.set(pagination.state.value.page);
      loaded_page = pagination.page.value;
      return;
    }
    // 只有当前页已空才读取有效页；普通操作保留其余行，不触发整表加载态。
    await pagination.load(pagination.state.value.page, { background: true });
  }

  function show_list_message(message) {
    form_message_.set(message);
    if (!bulk_busy_.value) Timeless.notify(message);
  }

  async function set_source_flag(source_id, field, value) {
    const source = sources_.value.find(item => item.id === source_id) || selected_sources.get(source_id);
    if (!source || source_updating_.value.includes(source_id)) return false;
    if (source[field] === value) return true;
    source_updating_.set([...source_updating_.value, source_id]);
    list_error_.set("");
    try {
      const result = await request_json("/admin/api/discovery/sources/" + encodeURIComponent(source_id), {
        method: "PATCH", body: JSON.stringify({ [field]: value }),
      });
      const updated = normalize_source(result.source);
      apply_source(updated);
      if (!bulk_busy_.value) await fill_empty_page();
      show_list_message(updated.title + (field === "enabled"
        ? updated.enabled ? " 已启用。" : " 已停用。"
        : updated.require_token ? " 已设为需要 token 访问。" : " 已设为公开。"));
      return true;
    } catch (error) {
      // 重建当前行，使 Switch 恢复服务端已保存的状态。
      const current = sources_.value.find(item => item.id === source_id);
      if (current) apply_source({ ...current });
      list_error_.set(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      source_updating_.set(source_updating_.value.filter(id => id !== source_id));
    }
  }

  /**
   * 头像上传不能走 `request_json`：它会给任何带 body 的请求硬塞
   * `Content-Type: application/json`（见其实现）。直接把 `File` 交给 fetch，
   * 浏览器会带上正确的 Content-Type 与 Content-Length。
   */
  async function put_avatar(source_id, file) {
    const response = await fetch(
      "/admin/api/discovery/sources/" +
        encodeURIComponent(source_id) +
        "/avatar",
      {
        method: "PUT",
        body: file,
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "头像上传失败：HTTP " + response.status);
    }
    return normalize_source(payload.source);
  }

  function clear_avatar_file() {
    avatar_file_.set(null);
    if (avatar_input_node) avatar_input_node.value = "";
  }

  async function save_source() {
    if (saving_.value || previewing_.value) return;
    saving_.set(true);
    form_error_.set("");
    form_message_.set("");
    const was_editing = editing_id_.value;
    const pending_avatar = avatar_file_.value;
    try {
      const payload = draft_payload();
      const result = await request_json(
        was_editing === ""
          ? "/admin/api/discovery/sources"
          : "/admin/api/discovery/sources/" + encodeURIComponent(was_editing),
        {
          method: was_editing === "" ? "POST" : "PATCH",
          ...(was_editing === "" && preview_id ? { headers: { "X-Feed-Preview-ID": preview_id } } : {}),
          body: JSON.stringify(payload),
        },
      );
      let source = normalize_source(result.source);
      apply_source(source, { created: was_editing === "" });
      if (pending_avatar) {
        // 源本身已经存下来了：头像失败只提示，不回滚（否则用户丢掉刚填的其它字段）。
        try {
          source = await put_avatar(source.id, pending_avatar);
          apply_source(source);
        } catch (error) {
          editing_id_.set(source.id);
          form_error_.set(
            source.title +
              " 已保存，但头像上传失败：" +
              (error instanceof Error ? error.message : String(error)),
          );
          return;
        }
      }
      methods.reset_draft();
      saving_.set(false);
      form_open_.set(false);
      show_list_message(source.title + " 已保存。");
      await fill_empty_page();
    } catch (error) {
      form_error_.set(error instanceof Error ? error.message : String(error));
    } finally {
      saving_.set(false);
    }
  }

  const methods = {
    open_import() {
      if (loading_.value || saving_.value || import_busy_.value || bulk_busy_.value) return;
      import_generation++;
      import_text_.set("");
      import_error_.set("");
      import_message_.set("");
      import_open_.set(true);
    },
    close_import() {
      if (import_busy_.value) return;
      import_generation++;
      import_open_.set(false);
      import_text_.set("");
      import_reading_.set(false);
    },
    set_import_text(text) {
      if (import_busy_.value || import_reading_.value) return;
      import_text_.set(text);
      import_error_.set("");
      import_message_.set("");
    },
    async read_import_file(files) {
      const file = files?.[0];
      if (!file || import_busy_.value || import_reading_.value) return;
      import_error_.set("");
      import_message_.set("");
      if (!/\.json$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
        import_error_.set("请选择不超过 2 MB 的 JSON 文件");
        return;
      }
      const generation = ++import_generation;
      import_reading_.set(true);
      try {
        const text = await file.text();
        if (generation === import_generation)
          import_text_.set(text.replace(/^\uFEFF/, ""));
      } catch (error) {
        if (generation === import_generation)
          import_error_.set("读取失败：" + (error.message || String(error)));
      } finally {
        if (generation === import_generation) import_reading_.set(false);
      }
    },
    async import_sources() {
      if (import_busy_.value || import_reading_.value || loading_.value) return;
      import_error_.set("");
      import_message_.set("");
      let sources;
      try {
        if (import_text_.value.length > 2 * 1024 * 1024)
          throw new Error("JSON 内容过大");
        const parsed = JSON.parse(import_text_.value.replace(/^\uFEFF/, ""));
        sources = Array.isArray(parsed) ? parsed : parsed?.sources;
        if (
          !Array.isArray(sources) ||
          !sources.length ||
          sources.length > 1000
        ) {
          throw new Error(
            '请提供包含 1–1000 个订阅源的数组或 { "sources": [...] }',
          );
        }
        sources = sources.map((source, index) => {
          if (
            !source ||
            typeof source !== "object" ||
            Array.isArray(source) ||
            typeof source.title !== "string" ||
            !source.title.trim() ||
            typeof source.feed_url !== "string" ||
            !source.feed_url.trim()
          ) {
            throw new Error(
              "第 " + (index + 1) + " 项必须包含 title 和 feed_url 字符串",
            );
          }
          return Object.fromEntries(
            [
              "title",
              "description",
              "website",
              "social_url",
              "social_urls",
              "feed_url",
              "category",
              "tags",
              "enabled",
              "require_token",
              "credit_cost",
              "sort_order",
              "source_type",
              "poll_policy",
            ]
              .filter((key) => source[key] !== undefined)
              .map((key) => [
                key,
                key === "feed_url"
                  ? (typeof source.feed_url_template === "string" &&
                    source.feed_url_template
                      ? source.feed_url_template
                      : source.feed_url
                    ).trim()
                  : source[key],
              ]),
          );
        });
      } catch (error) {
        import_error_.set("JSON 格式错误：" + (error.message || String(error)));
        return;
      }
      import_busy_.set(true);
      const existing = new Set();
      let imported = 0,
        skipped = 0,
        processed = 0;
      try {
        const current_sources = await request_json("/admin/api/discovery/sources");
        for (const source of current_sources.sources || []) {
          if (source.feed_url) existing.add(source.feed_url);
          if (source.feed_url_template) existing.add(source.feed_url_template);
        }
        for (const source of sources) {
          if (existing.has(source.feed_url)) skipped++;
          else {
            const result = await request_json("/admin/api/discovery/sources", {
              method: "POST",
              body: JSON.stringify(source),
            });
            const saved = normalize_source(result.source);
            apply_source(saved, { created: true });
            existing.add(source.feed_url);
            imported++;
          }
          processed++;
          import_message_.set(
            "已导入 " + imported + " 个，跳过重复地址 " + skipped + " 个。",
          );
        }
        import_text_.set("");
      } catch (error) {
        import_error_.set(
          "第 " +
            (processed + 1) +
            " 项导入失败：" +
            (error.message || String(error)) +
            "。已保存的订阅源保留，可重试剩余内容。",
        );
        import_text_.set(
          JSON.stringify({ sources: sources.slice(processed) }, null, 2),
        );
      } finally {
        import_busy_.set(false);
        await fill_empty_page();
      }
    },
    async export_sources() {
      if (loading_.value) return;
      list_error_.set("");
      let object_url = "";
      try {
        const payload = await request_json("/admin/api/discovery/sources");
        const sources = (payload.sources || []).map(normalize_source).map(
          ({
            cache,
            snapshot,
            feed_url_template,
            poll_effective,
            next_snapshot_at,
            ...source
          }) => ({
            ...source,
            feed_url: feed_url_template || source.feed_url,
          }),
        );
        const blob = new Blob([JSON.stringify({ sources }, null, 2)], {
          type: "application/json;charset=utf-8",
        });
        object_url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.setAttribute("data-n", "discovery-source-export-download");
        anchor.href = object_url;
        anchor.download =
          "findrss-sources-" + format_datetime(Date.now(), { format: "YYYY-MM-DD" }) + ".json";
        anchor.click();
      } catch (error) {
        list_error_.set("导出失败：" + (error.message || "无法下载 JSON 文件"));
      } finally {
        if (object_url)
          window.setTimeout(() => URL.revokeObjectURL(object_url), 1000);
      }
    },
    async copy_url(url) {
      list_error_.set("");
      try {
        await window.navigator.clipboard.writeText(url);
      } catch (error) {
        list_error_.set("复制失败，请检查浏览器剪贴板权限后重试。");
        throw error;
      }
    },
    refresh_list() {
      return load();
    },
    async recover_overdue() {
      if (recovery_busy_.value || loading_.value || bulk_busy_.value || saving_.value) return false;
      recovery_busy_.set(true);
      recovery_message_.set("");
      list_error_.set("");
      try {
        const result = await request_json("/admin/api/discovery/sources/recover-overdue", { method: "POST" });
        const message = result.matched_count
          ? "已提交 " + result.queued_count + " 个补抓任务，跳过 " + result.skipped_count + " 个运行中或已排队的源。"
          : "没有逾期 5 小时以上的订阅源。";
        recovery_message_.set(message);
        Timeless.notify(message);
        await pagination.load(pagination.page.value, { background: true });
        return true;
      } catch (error) {
        list_error_.set("补抓提交失败：" + (error.message || String(error)));
        return false;
      } finally {
        recovery_busy_.set(false);
      }
    },
    async refresh_snapshot(source_id) {
      const source = sources_.value.find((item) => item.id === source_id) || selected_sources.get(source_id);
      if (
        !source ||
        (source.require_token && !source.cache) ||
        snapshot_refreshing_.value.includes(source_id)
      )
        return false;
      local_refreshing.add(source_id);
      sync_refreshing();
      snapshot_errors_.set(new Map(snapshot_errors_.value).set(source_id, ""));
      catalog_errors_.set(new Map(catalog_errors_.value).set(source_id, ""));
      try {
        const result = await request_json(
          "/admin/api/discovery/sources/" +
            encodeURIComponent(source_id) +
            "/snapshot",
          { method: "POST" },
        );
        if (!result.snapshot) {
          if (!result.task) throw new Error("快照刷新响应缺少快照或任务信息");
          background_refreshing.add(source_id);
          await load_background_tasks({ reload_completed: true });
          return true;
        }
        if (selected_ids_.value.includes(source_id)) selected_sources.set(source_id, { ...source,
          snapshot: result.snapshot, cache: result.cache || source.cache,
          ...(result.avatar_url === undefined ? {} : { avatar_url: result.avatar_url }) });
        sources_.as(
          sources_.value.map((item) =>
            item.id === source_id
              ? {
                  ...item,
                  snapshot: result.snapshot,
                  ...(result.avatar_url === undefined ? {} : { avatar_url: result.avatar_url }),
                  cache: result.cache || item.cache,
                  ...(result.next_snapshot_at === undefined
                    ? {}
                    : { next_snapshot_at: result.next_snapshot_at }),
                  ...(result.poll_effective
                    ? { poll_effective: result.poll_effective }
                    : {}),
                }
              : item,
          ),
        );
        catalog_errors_.set(new Map(catalog_errors_.value).set(source_id, result.catalog_error || ""));
        snapshot_errors_.set(
          new Map(snapshot_errors_.value).set(
            source_id,
            result.snapshot.error || "",
          ),
        );
        return !result.snapshot.error;
      } catch (error) {
        snapshot_errors_.set(
          new Map(snapshot_errors_.value).set(
            source_id,
            error.message || "快照更新失败",
          ),
        );
        return false;
      } finally {
        local_refreshing.delete(source_id);
        sync_refreshing();
      }
    },
    create_source() {
      if (saving_.value || bulk_busy_.value) return;
      methods.reset_draft();
      form_open_.set(true);
      load_scripts();
    },
    close_form() {
      if (saving_.value) return;
      form_open_.set(false);
      methods.reset_draft();
    },
    async preview_feed() {
      const address = draft_feed_url_.value.trim();
      if (saving_.value || previewing_.value || !address) return;
      if (
        is_template_feed_url(address) &&
        (!/^\{\{hostname\}\}\/(rss|atom)\//.test(address) ||
          !is_managed_rss_url(address))
      ) {
        form_message_.set("");
        form_error_.set(
          "模板订阅源地址必须以 {{hostname}}/rss/ 或 {{hostname}}/atom/ 开头",
        );
        return;
      }
      const generation = ++preview_generation;
      const fields = {
        title: draft_title_,
        website: draft_website_,
        description: draft_description_,
        tags: draft_tags_,
        source_type: draft_source_type_,
      };
      const before = Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [key, field.value]),
      );
      previewing_.set(true);
      preview_id = "";
      form_error_.set("");
      form_message_.set("正在读取订阅源…");
      try {
        const result = await request_json("/admin/api/discovery/preview", {
          method: "POST",
          body: JSON.stringify({ feed_url: address, cache_snapshot: editing_id_.value === "" }),
        });
        if (generation !== preview_generation) return;
        preview_id = result.preview_id || "";
        for (const [key, field] of Object.entries(fields)) {
          if (
            field.value !== before[key] ||
            (key === "tags" && tags_touched_.value) ||
            (key === "source_type" &&
              (source_type_touched_.value || editing_id_.value !== ""))
          )
            continue;
          if (key === "source_type" && is_managed_rss_url(address)) {
            field.set(infer_source_type(address, scripts_.value));
            continue;
          }
          if (key === "tags" && infer_source_route(address, scripts_.value)) {
            field.set(infer_source_tags(address, scripts_.value).join(", "));
            continue;
          }
          field.set(
            key === "tags"
              ? result.defaults.tags.join(", ")
              : result.defaults[key],
          );
        }
        preview_avatar_.set("");
        if (result.avatar && !avatar_file_.value) {
          const bytes = Uint8Array.from(atob(result.avatar.data), (char) =>
            char.charCodeAt(0),
          );
          avatar_file_.set(
            new File([bytes], "feed-avatar", {
              type: result.avatar.content_type,
            }),
          );
          preview_avatar_.set(
            "data:" +
              result.avatar.content_type +
              ";base64," +
              result.avatar.data,
          );
        }
        form_message_.set(
          "已从 " +
            result.feed_url +
            " 填入默认值，可修改后保存。" +
            (result.avatar_error ? "头像未读取：" + result.avatar_error : ""),
        );
      } catch (error) {
        if (generation === preview_generation) {
          form_message_.set("");
          form_error_.set(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (generation === preview_generation) previewing_.set(false);
      }
    },
    start() {
      active = true;
      if (!stop_realtime) stop_realtime = window.FindRSSAdminRealtime?.subscribe(["discovery.changed", "background-tasks.changed"], receive_change);
      return load();
    },
    stop() {
      active = false; sync_pending = false; sync_sources = false;
      stop_realtime?.(); stop_realtime = null;
      invalidate_tasks();
    },
    destroy() {
      disposed = true;
      methods.stop();
      pagination.destroy();
    },
    set_filter(name, value) {
      if (bulk_busy_.value) return;
      selected_ids_.set([]);
      selected_sources.clear();
      known_sources.clear();
      bulk_message_.set("");
      pagination.reset();
      if (name === "query") query_.set(String(value));
      if (name === "platform") filter_platform_.set(String(value));
      if (name === "status") filter_status_.set(String(value));
      if (name === "visibility") filter_visibility_.set(String(value));
      return load();
    },
    set_draft(name, value) {
      if (name === "title") draft_title_.set(String(value));
      if (name === "feed_url") {
        preview_id = "";
        preview_generation++;
        previewing_.set(false);
        if (preview_avatar_.value) clear_avatar_file();
        preview_avatar_.set("");
        draft_feed_url_.set(String(value));
        if (editing_id_.value === "" && !tags_touched_.value)
          draft_tags_.set(infer_source_tags(String(value), scripts_.value).join(", "));
        // 只有「新增」且用户没手改过来源时才自动预判；编辑已有源时不覆盖已保存的选择。
        if (editing_id_.value === "" && !source_type_touched_.value) {
          draft_source_type_.set(
            infer_source_type(String(value), scripts_.value),
          );
        }
      }
      if (name === "website") draft_website_.set(String(value));
      if (name === "social_url") draft_social_urls_.set(value ? [String(value)] : []);
      if (name === "social_urls") draft_social_urls_.set(value.map(String));
      if (name === "description") draft_description_.set(String(value));
      if (name === "tags") {
        tags_touched_.set(true);
        draft_tags_.set(String(value));
      }
      if (name === "sort_order") draft_sort_order_.set(String(value));
      if (name === "require_token") draft_require_token_.set(value === true);
      if (name === "credit_cost") draft_credit_cost_.set(String(value));
      if (name === "source_type") {
        source_type_touched_.set(true);
        draft_source_type_.set(String(value));
      }
    },
    toggle_tag(tag) {
      if (!tags_.value.includes(tag)) return;
      const selected = draft_tags_.value.split(",").map(value => value.trim()).filter(Boolean);
      methods.set_draft("tags", [...new Set(selected.includes(tag)
        ? selected.filter(value => value !== tag) : [...selected, tag])].join(", "));
    },
    set_avatar_file(file, input_node) {
      preview_avatar_.set("");
      if (input_node) avatar_input_node = input_node;
      avatar_file_.set(file instanceof File ? file : null);
      form_error_.set("");
      form_message_.set("");
    },
    edit_source(source_id) {
      if (saving_.value) return;
      const source = sources_.value.find((item) => item.id === source_id);
      if (!source) return;
      preview_id = "";
      preview_generation++;
      previewing_.set(false);
      preview_avatar_.set("");
      editing_id_.set(source.id);
      draft_title_.set(source.title);
      draft_feed_url_.set(source.feed_url_template || source.feed_url);
      draft_website_.set(source.website);
      draft_social_urls_.set([...normalize_source(source).social_urls]);
      draft_description_.set(source.description);
      draft_tags_.set(source.tags.join(", "));
      draft_sort_order_.set(String(source.sort_order));
      draft_enabled_.set(source.enabled);
      draft_require_token_.set(source.require_token);
      draft_credit_cost_.set(String(source.credit_cost ?? 1));
      draft_source_type_.set(source.source_type || "website");
      poll_editor.methods.reset(source.poll_policy);
      source_type_touched_.set(false);
      tags_touched_.set(false);
      clear_avatar_file();
      form_error_.set("");
      form_message_.set("");
      form_open_.set(true);
      load_scripts();
    },
    reset_draft() {
      preview_id = "";
      preview_generation++;
      previewing_.set(false);
      preview_avatar_.set("");
      editing_id_.set("");
      draft_title_.set("");
      draft_feed_url_.set("");
      draft_website_.set("");
      draft_social_urls_.set([]);
      draft_description_.set("");
      draft_tags_.set("");
      tags_touched_.set(false);
      draft_sort_order_.set("0");
      draft_enabled_.set(true);
      draft_require_token_.set(true);
      draft_credit_cost_.set("1");
      draft_source_type_.set("website");
      poll_editor.methods.reset();
      source_type_touched_.set(false);
      clear_avatar_file();
      form_error_.set("");
      form_message_.set("");
    },
    async remove_avatar() {
      const source_id = editing_id_.value;
      if (source_id === "") return;
      form_error_.set("");
      form_message_.set("");
      try {
        const result = await request_json(
          "/admin/api/discovery/sources/" +
            encodeURIComponent(source_id) +
            "/avatar",
          { method: "DELETE" },
        );
        const source = normalize_source(result.source);
        apply_source(source);
        clear_avatar_file();
        form_message_.set(source.title + " 的头像已移除。");
      } catch (error) {
        form_error_.set(error instanceof Error ? error.message : String(error));
      }
    },
    save_source() {
      return save_source();
    },
    toggle_selection(source_id) {
      if (bulk_busy_.value || loading_.value || !sources_.value.some(source => source.id === source_id)) return;
      selected_sources.set(source_id, sources_.value.find(source => source.id === source_id));
      selected_ids_.set(selected_ids_.value.includes(source_id)
        ? selected_ids_.value.filter(id => id !== source_id)
        : [...selected_ids_.value, source_id]);
      bulk_message_.set("");
    },
    toggle_page_selection() {
      if (bulk_busy_.value || loading_.value) return;
      for (const source of paged_sources.value) selected_sources.set(source.id, source);
      const page_ids = paged_sources.value.map(source => source.id);
      const all_selected = page_ids.length > 0 && page_ids.every(id => selected_ids_.value.includes(id));
      selected_ids_.set(all_selected
        ? selected_ids_.value.filter(id => !page_ids.includes(id))
        : [...new Set([...selected_ids_.value, ...page_ids])]);
      bulk_message_.set("");
    },
    clear_selection() {
      if (bulk_busy_.value) return;
      selected_ids_.set([]);
      selected_sources.clear();
    },
    async bulk_action(action) {
      if (bulk_busy_.value || loading_.value || source_updating_.value.length || !["enable", "disable", "refresh", "delete"].includes(action)) return;
      const selected = selected_ids_.value.map(id => sources_.value.find(source => source.id === id) || selected_sources.get(id)).filter(Boolean);
      if (!selected.length) return;
      bulk_busy_.set(true);
      bulk_message_.set("");
      list_error_.set("");
      let succeeded = 0, skipped = 0;
      const errors = [];
      try {
        for (const source of selected) {
          if (action === "refresh" && ((source.require_token && !source.cache) || snapshot_refreshing_.value.includes(source.id))) {
            skipped++;
            continue;
          }
          const success = action === "refresh" ? await methods.refresh_snapshot(source.id)
            : action === "delete" ? await methods.remove_source(source.id)
            : await methods.toggle_source(source.id, action === "enable");
          if (success) {
            succeeded++;
            selected_ids_.set(selected_ids_.value.filter(id => id !== source.id));
          } else {
            errors.push(source.title + "：" + (action === "refresh" ? snapshot_errors_.value.get(source.id) : list_error_.value));
          }
          bulk_message_.set("已处理 " + (succeeded + errors.length + skipped) + " / " + selected.length + " 个订阅源…");
        }
      } finally {
        if (action !== "refresh") await fill_empty_page();
        bulk_busy_.set(false);
        form_message_.set("");
        bulk_message_.set("批量操作完成：成功 " + succeeded + " 个，失败 " + errors.length + " 个，跳过 " + skipped + " 个。"
          + (skipped ? "外部私密源或正在刷新的源已跳过。" : ""));
        list_error_.set(errors.join("\n"));
      }
    },
    toggle_source(source_id, enabled) {
      const source = sources_.value.find((item) => item.id === source_id);
      return set_source_flag(source_id, "enabled", enabled ?? !source?.enabled);
    },
    set_source_public(source_id, is_public) {
      if (bulk_busy_.value) return false;
      return set_source_flag(source_id, "require_token", !is_public);
    },
    async remove_source(source_id) {
      const source = sources_.value.find((item) => item.id === source_id) || selected_sources.get(source_id);
      if (!source || source_updating_.value.includes(source_id)) return false;
      source_updating_.set([...source_updating_.value, source_id]);
      list_error_.set("");
      try {
        await request_json(
          "/admin/api/discovery/sources/" + encodeURIComponent(source_id),
          {
            method: "DELETE",
          },
        );
        sources_.as(sources_.value.filter((item) => item.id !== source_id));
        if (matches_filters(source)) pagination.total.set(Math.max(0, pagination.total.value - 1));
        selected_ids_.set(selected_ids_.value.filter(id => id !== source_id));
        selected_sources.delete(source_id);
        known_sources.delete(source_id);
        const errors = new Map(snapshot_errors_.value);
        errors.delete(source_id);
        snapshot_errors_.set(errors);
        const catalog_errors = new Map(catalog_errors_.value);
        catalog_errors.delete(source_id);
        catalog_errors_.set(catalog_errors);
        if (editing_id_.value === source_id) methods.reset_draft();
        show_list_message(source.title + " 已删除。");
        if (!bulk_busy_.value) await fill_empty_page();
        return true;
      } catch (error) {
        list_error_.set(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        source_updating_.set(source_updating_.value.filter(id => id !== source_id));
      }
    },
  };

  const pagination = ListPaginationModel(Timeless, {
    fetch, url: "/admin/api/discovery/sources", key: "sources", normalize: normalize_source,
    loading: loading_, error: list_error_,
    visible_count: computed(sources_, sources => sources.length),
    filters: () => {
      invalidate_tasks();
      return { q: query_.value.trim(), source_type: filter_platform_.value === "all" ? "" : filter_platform_.value,
        status: filter_status_.value, visibility: filter_visibility_.value };
    },
    on_data(sources, payload) {
      if (loaded_page === pagination.page.value) {
        const previous_ids = new Set(sources_.value.map(source => source.id));
        const current_ids = new Set(sources.map(source => source.id));
        selected_ids_.set(selected_ids_.value.filter(id => !previous_ids.has(id) || current_ids.has(id)));
      }
      loaded_page = pagination.page.value;
      sources_.as(sources);
      for (const source of sources) known_sources.set(source.id, source);
      for (const source of sources) if (selected_ids_.value.includes(source.id)) selected_sources.set(source.id, source);
      tags_.set(Array.isArray(payload.tags) ? [...new Set(payload.tags.filter(tag => typeof tag === "string"))] : []);
      platforms_.set(Array.isArray(payload.platforms)
        ? payload.platforms.map(({ id, name, label, icon }) => ({ id, label: name || label, ...(icon === undefined ? {} : { icon }) }))
        : discovery_platforms());
      return load_background_tasks();
    },
  });
  const visible_sources = sources_;
  const paged_sources = sources_;
  const page_selection = combine({ sources: paged_sources, selected: selected_ids_ }, ({ sources, selected }) => ({
    all: sources.length > 0 && sources.every(source => selected.includes(source.id)),
    some: sources.some(source => selected.includes(source.id)),
  }));

  // 编辑态下用于回显当前头像（`?v=` 带版本号，换图后地址会变）。
  const editing_source = computed(
    editing_id_,
    (source_id) => sources_.value.find((item) => item.id === source_id) || null,
  );

  return {
    state,
    methods,
    poll_editor,
    visible_sources,
    paged_sources,
    page_selection,
    pagination,
    editing_source,
  };
}

export {
  normalize_source,
  is_template_feed_url,
  is_managed_rss_url,
  DiscoveryAdminViewModel,
};
