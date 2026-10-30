import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start_local_worker } from "./local_worker.js";

// 显式运行：node --test scripts/log_storage_smoke.test.mjs，隔离本地存储，模拟官方日志查询响应。
test("真实 Worker 输出托管日志且 D1 写入为零，R2 仅保存小状态，重建后通过官方协议查询", {
  timeout: 120000
}, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "findrss-log-storage-"));
  let worker;
  t.after(async () => {
    await worker?.stop();
    await rm(temp, {
      recursive: true,
      force: true
    });
  });
  const contents = `
    import { Application } from ${JSON.stringify(join(root, "server/application.js"))};
    export { RealtimeHubDO, APIDurableObject, ApplicationEntrypoint } from ${JSON.stringify(join(root, "index.js"))};
    import { RepositoryWorkersLogs } from ${JSON.stringify(join(root, "server/repository/workers_logs.js"))};
    import { WorkersLogs } from ${JSON.stringify(join(root, "server/infra/workers_logs.js"))};
    import { RepositoryDevice } from ${JSON.stringify(join(root, "server/repository/device.js"))};
    import { RepositoryScriptLog } from ${JSON.stringify(join(root, "server/repository/script_log.js"))};
    export default {
      async fetch(request,env,ctx) {
        const application = new Application(env,ctx);
        const events = [];
        for(const level of ['info','error']) {
          const original = console[level].bind(console);
          console[level] = value => {
            if(value?.log_version === 1) events.push({source:structuredClone(value),timestamp:Date.now(),$metadata:{id:'event-'+events.length,service:'smoke-worker'}});
            original(value);
          };
        }
        const telemetry = new WorkersLogs({CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_WORKER_NAME:'smoke-worker',CLOUDFLARE_API_TOKEN:'isolated-token'}, {
          fetch: async (url,options) => {
            const query = JSON.parse(options.body);
            const matches = events.toReversed().filter(event => event.timestamp>=query.timeframe.from && event.timestamp<=query.timeframe.to
              && query.parameters.filters.every(({key,operation,value}) => {
                const actual = key==='$metadata.service' ? event.$metadata.service : event.source[key];
                return operation==='eq' ? actual===value : operation==='lt' ? actual<value : actual>value;
              }));
            const start = query.offset ? matches.findIndex(event=>event.$metadata.id===query.offset)+1 : 0;
            return Response.json({success:true,result:{events:{events:matches.slice(start,start+query.limit)}}});
          }
        });
        const native = application.storage, cursors = [];
        const sql = { async exec(query, ...args) { const cursor = await native.exec(query,...args); cursors.push(cursor); return cursor; } };
        const device = { device_id:'device',connection_id:null,category:'heartbeat',event_type:'heartbeat',direction:'inbound',level:'info',
          task_id:null,method:null,message:'test',metadata_json:'{}',created_at:Date.now() };
        const script = { route:'script',path:'/test',source:'request',method:'GET',pathname:'/test',status:'error',phase:'runtime',level:'error',
          message:'test',error_text:'',params_json:'{}',query_json:'{}',lines_json:'[]',elapsed_ms:0,invoked:0,device_id:null,created_at:Date.now() };
        await new RepositoryDevice({sql}).insert_log(device);
        await new RepositoryScriptLog({sql}).insert(script);
        const old_rows_written = cursors.reduce((sum,cursor)=>sum+cursor.rowsWritten,0);
        await native.exec('DELETE FROM device_logs'); await native.exec('DELETE FROM script_logs');
        cursors.length = 0;
        application.repo.devices.sql = sql;
        const pending = [];
        for(let i=0;i<100;i++) {
          pending.push(application.app.devices.record_device_log('device','heartbeat','heartbeat','log '+i));
          pending.push(application.app.scripts.record_log({...script,message:'error '+i}));
        }
        await Promise.all(pending);
        const new_rows_written = cursors.reduce((sum,cursor)=>sum+cursor.rowsWritten,0);
        const device_count = (await native.exec('SELECT COUNT(*) AS n FROM device_logs')).toArray()[0].n;
        const script_count = (await native.exec('SELECT COUNT(*) AS n FROM script_logs')).toArray()[0].n;
        const restarted = new RepositoryWorkersLogs({object_store:application.logs.object_store,telemetry});
        const devices = await restarted.devices.list_logs('device','heartbeat',null,101);
        const scripts = await restarted.scripts.list_errors(null,101);
        await restarted.scripts.delete_errors_through(scripts[0].id);
        return Response.json({old_rows_written,new_rows_written,device_count,script_count,devices:devices.length,scripts:scripts.length,
          latest_device:devices[0].message,latest_error:scripts[0].message,unread:(await restarted.scripts.list_errors(null,101)).length,
          objects:(await application.logs.object_store.list({prefix:'logs/'})).objects.map(object=>object.key),events:events.length});
      }
    };

  `;
  const entry = join(temp, "worker.mjs");
  await writeFile(entry, contents);
  worker = await start_local_worker(entry, {
    config: join(root, "wrangler.jsonc"),
    assets: join(root, "dist/assets"),
    persistTo: join(temp, "state"),
    temp_dir: temp,
    local: true,
    port: 0,
    watch: false,
    initialize_database: true,
    vars: {
      ADMIN_PASSWORD: "isolated-log-test"
    }
  });
  const response = await fetch(`http://${worker.address}:${worker.port}/_internal/log-test`);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  const {
    old_rows_written,
    ...actual
  } = result;
  assert.ok(old_rows_written > 0);
  assert.deepEqual(actual, {
    new_rows_written: 0,
    device_count: 0,
    script_count: 0,
    devices: 100,
    scripts: 100,
    latest_device: "log 99",
    latest_error: "error 99",
    unread: 0,
    objects: ["logs/workers/state.json"],
    events: 200
  });
  console.log(JSON.stringify(result));
});
