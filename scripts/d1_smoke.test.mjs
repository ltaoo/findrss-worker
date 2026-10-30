import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start_local_worker } from './local_worker.js';
import { request as http_request } from 'node:http';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
test('real Workers D1/KV/Queue and WS-only DO application', {
  timeout: 120000
}, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'findrss-d1-smoke-'));
  let worker;
  t.after(async () => {
    await worker?.stop();
    await rm(directory, {
      recursive: true,
      force: true
    });
  });
  const entry = join(directory, 'worker.js');
  await writeFile(entry, `
    import { Application } from ${JSON.stringify(join(root, 'server/application.js'))};
    import application from ${JSON.stringify(join(root, 'index.js'))};
    export { RealtimeHubDO, APIDurableObject, ApplicationEntrypoint } from ${JSON.stringify(join(root, 'index.js'))};
    export default { ...application, async fetch(request,env,ctx) {
      if(new URL(request.url).pathname==='/_smoke/consume') {
        const jobs=await env.DB.prepare("SELECT id FROM jobs WHERE status='queued'").all();
        await application.queue({messages:jobs.results.map(row=>({body:row,ack(){},retry(){throw Error('retry')}}))},env,ctx);
        return Response.json(await env.DB.prepare('SELECT status,error FROM jobs').all());
      }
      if(new URL(request.url).pathname==='/_smoke/read-budget') {
        await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO discovery_sources(id,title,feed_url,route_pathname,category,created_at,updated_at) SELECT 'budget-'||i,'Budget '||i,'{{hostname}}/rss/other/'||i,'/other/'||i,'',0,0 FROM n WHERE true ON CONFLICT DO NOTHING").run();
        const counters={rows_read:0,rows_written:0};
        const record=result=>{counters.rows_read+=result.meta?.rows_read||0;counters.rows_written+=result.meta?.rows_written||0;return result;};
        const wrap=statement=>({native:statement,bind:(...values)=>wrap(statement.bind(...values)),all:async()=>record(await statement.all())});
        const DB={prepare:sql=>wrap(env.DB.prepare(sql)),batch:async statements=>(await env.DB.batch(statements.map(statement=>statement.native))).map(record)};
        const app=new Application({...env,DB},ctx);
        const response=await app.fetch(new Request('https://internal/_public/feed/rss/d1-smoke',{headers:{'X-Feed-Public-URL':new URL(request.url).origin+'/rss/d1-smoke'}}));
        return Response.json({...counters,status:response.status,body:await response.text()});
      }
      if(new URL(request.url).pathname==='/_smoke/preview') return Response.json(await new Application(env,ctx).app.scripts.preview_assets.get(new URL(request.url).searchParams.get('id')));
      if(new URL(request.url).pathname==='/_smoke/agent') {
        return new Response(await env.APPLICATION_SERVICE.agent_run({run_id:'smoke',script:'',revision:0,request_url:'',messages:[{role:'user',content:'test'}]},'script-agent'));
      }
      if(new URL(request.url).pathname==='/_smoke/disable') { await env.DB.prepare("UPDATE scripts SET enabled=0").run(); return Response.json({ok:true}); }
      return application.fetch(request,env,ctx);
    }};
  `);
  worker = await start_local_worker(entry, {
    config: join(root, 'wrangler.jsonc'),
    assets: join(root, 'dist/assets'),
    persistTo: join(directory, 'state'),
    temp_dir: directory,
    local: true,
    port: 0,
    watch: false,
    initialize_database: true,
    vars: {
      ADMIN_PASSWORD: 'd1-smoke-password'
    }
  });
  const origin = `http://${worker.address}:${worker.port}`;
  let response;
  const headers = {
    Authorization: 'Bearer d1-smoke-password',
    'Content-Type': 'application/json'
  };
  for (const route of ['scripts', 'discovery/sources', 'settings/snapshots', 'clips', 'detections', 'users']) {
    response = await fetch(origin + '/admin/api/' + route, {
      headers
    });
    assert.equal(response.status, 200, route + ': ' + (await response.text()));
  }
  response = await fetch(origin + '/admin/api/access-tokens', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'D1 smoke',
      credits: 2
    })
  });
  assert.equal(response.status, 201, await response.clone().text());
  const token = await response.json();
  assert.equal(token.access_token.credit_balance, 2);
  const upgrade = (path, authentication, extra = {}) => new Promise((resolve, reject) => {
    const request = http_request(origin + path, {
      headers: {
        Authorization: authentication,
        ...extra,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    request.once('upgrade', (response, socket) => {
      assert.equal(response.statusCode, 101);
      socket.destroy();
      resolve();
    });
    request.once('response', response => reject(new Error('WS returned ' + response.statusCode)));
    request.once('error', reject);
    request.end();
  });
  await upgrade('/admin/api/events/ws', headers.Authorization);
  response = await fetch(origin + '/_smoke/agent');
  assert.equal(response.status, 200, await response.clone().text());
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'start');
  assert.ok(events.some(event => event.type === 'error'), 'unconfigured agent must report an error over the RPC byte stream');
  response = await fetch(origin + '/admin/api/device-tokens', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'smoke-device'
    })
  });
  assert.equal(response.status, 201, await response.clone().text());
  const credential = await response.json();
  response = await fetch(origin + '/admin/api/device-tokens/' + credential.device_token.id + '/reveal', {
    method: 'POST',
    headers
  });
  assert.equal(response.status, 200, await response.clone().text());
  const revealed = await response.json();
  const device = new WebSocket(origin.replace('http:', 'ws:') + '/v1/connect', {
    headers: {
      Authorization: 'Bearer ' + revealed.token,
      'X-Api-Device-ID': 'smoke-device',
      'X-Api-Methods': 'echo'
    }
  });
  t.after(() => device.terminate());
  let assigned;
  const ready = new Promise((resolve, reject) => {
    device.once('error', reject);
    device.on('message', data => {
      const event = JSON.parse(data.toString());
      if (event.type === 'device.connected') resolve();
      if (event.type === 'task.assigned') {
        assigned = event;
        device.send(JSON.stringify({
          type: 'task.accept',
          task_id: event.task.id,
          lease_token: event.lease_token
        }));
      }
      if (event.type === 'task.accepted') device.send(JSON.stringify({
        type: 'task.complete',
        task_id: assigned.task.id,
        lease_token: assigned.lease_token,
        result: {
          echo: 'ok'
        }
      }));
    });
  });
  await ready;
  response = await fetch(origin + '/v1/invoke', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      method: 'echo',
      args: {
        value: 'ok'
      }
    }),
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    echo: 'ok'
  });
  const script = "export const route={name:'D1 smoke feed',path:'/d1-smoke',example:'/d1-smoke',public:true,handler:()=>Result.Ok({title:'D1 Feed',link:'https://example.com',items:[{id:'a',title:'Article A',link:'https://example.com/a'}]})};";
  response = await fetch(origin + '/admin/api/scripts', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      script,
      status: 'published',
      version: '1.0.0'
    })
  });
  assert.equal(response.status, 201, await response.clone().text());
  response = await fetch(origin + '/rss/d1-smoke');
  assert.equal(response.status, 503, await response.clone().text());
  let jobs;
  for (let attempt = 0; attempt < 30; attempt++) {
    response = await fetch(origin + '/_smoke/consume');
    assert.equal(response.status, 200, await response.clone().text());
    jobs = (await response.json()).results;
    if (jobs.length && jobs.every(job => job.status === 'completed')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(jobs.length && jobs.every(job => job.status === 'completed'), JSON.stringify(jobs));
  response = await fetch(origin + '/rss/d1-smoke');
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /Article A/);
  const draft = "export const routes=[{path:'/draft-feed',name:'draft',example:'/draft-feed',handler:()=>Result.Ok({title:'draft',link:'https://example.com',items:[]})},{path:'/img/draft',name:'image',allowed_hosts:['example.com'],handler:()=>Result.Ok({url:'https://example.com/image.png'})}];";
  response = await fetch(origin + '/admin/api/scripts/debug', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      script: draft,
      request_url: origin + '/rss/draft-feed'
    })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const debug = await response.json(),
    preview_id = debug.rss_debug.preview_assets.endpoint.split('/').pop();
  const preview = await (await fetch(origin + '/_smoke/preview?id=' + preview_id)).json();
  assert.equal(preview.script, draft, 'debug preview survives a fresh Worker through private R2 storage');
  assert.equal((await fetch(origin + '/rss/draft-feed')).status, 404, 'debug must not publish draft routes');
  const budget = await (await fetch(origin + '/_smoke/read-budget')).json();
  assert.equal(budget.status, 200, JSON.stringify(budget));
  assert.match(budget.body, /Article A/);
  assert.equal(budget.rows_written, 0, 'snapshot reads must never write schedule or business rows');
  assert.ok(budget.rows_read <= 10, JSON.stringify(budget));
  await fetch(origin + '/_smoke/disable');
  assert.equal((await fetch(origin + '/rss/d1-smoke')).status, 404, 'stale KV and cached XML cannot authorize a disabled script');
});
