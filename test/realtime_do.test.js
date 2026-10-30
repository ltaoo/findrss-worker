import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { WorkerSocketHub } from '../server/infra/realtime.js';
register('./support/application_hook.js', import.meta.url);
const {
  RealtimeHubDO
} = await import('../server/infra/realtime_do.js');
const { APIDurableObject } = await import('../server/durable_object.js');
test('旧 DO 保留命名空间，待执行 Alarm 不访问存储或继续执行业务', async () => {
  const legacy = new APIDurableObject({
    get storage() {
      assert.fail('Legacy alarms must not access storage');
    }
  }, {
    get APPLICATION_SERVICE() {
      assert.fail('Legacy alarms must not run application jobs');
    }
  });
  await legacy.alarm();
});
function fixture(service = {}) {
  const pending = [],
    sent = [];
  let state = {
    kind: 'admin',
    connection_id: 'connection',
    channels: {},
    topics: []
  };
  const socket = {
    deserializeAttachment: () => state,
    serializeAttachment: value => {
      state = value;
    },
    send: value => sent.push(JSON.parse(value))
  };
  const ctx = {
    get storage() {
      assert.fail('WebSocket DO must never read or write storage');
    },
    getWebSockets: () => [socket],
    waitUntil: promise => pending.push(promise)
  };
  const hub = new RealtimeHubDO(ctx, {
    APPLICATION_SERVICE: service
  });
  return {
    hub,
    socket,
    sent,
    pending,
    set_state: value => {
      state = value;
    }
  };
}
test('取消一个设备等待器不会清理同一任务的其他等待者，完成时全部释放', async () => {
  const f = fixture({
    task_status: async () => ({
      status: 'running'
    })
  });
  const sockets = new WorkerSocketHub(f.hub),
    abort = new AbortController();
  const first = sockets.wait('one', 10000, abort.signal),
    second = sockets.wait('one', 10000);
  await new Promise(setImmediate);
  assert.equal(f.hub.waiters.get('one').size, 2);
  const rejected = assert.rejects(first, /已终止/);
  abort.abort(new Error('已终止'));
  await rejected;
  assert.equal(f.hub.waiters.get('one').size, 1);
  f.hub.resolve('one', {
    status: 'completed'
  });
  assert.equal((await second).status, 'completed');
  assert.equal(f.hub.waiters.size, 0);
});
test('完成先于等待注册时从 Worker 读取终态，连接心跳不访问业务库', async () => {
  const f = fixture({
    task_status: async () => ({
      status: 'completed'
    })
  });
  assert.equal((await f.hub.wait('one', 1000)).status, 'completed');
  f.set_state({
    kind: 'device',
    connection_id: 'device',
    methods: ['echo']
  });
  await f.hub.webSocketMessage(f.socket, JSON.stringify({
    type: 'client.heartbeat'
  }));
  assert.equal(f.sent[0].type, 'client.heartbeat.ack');
  assert.equal(f.hub.waiters.size, 0);
});
test('Agent 字节流分段后仍保持频道事件和 UTF-8 内容，执行留在 Worker', async () => {
  const encoder = new TextEncoder(),
    bytes = encoder.encode('{"type":"delta","text":"中文"}\n{"type":"done"}\n');
  const f = fixture({
    agent_settings: async () => ({
      providers: []
    }),
    agent_run: async () => new ReadableStream({
      type: 'bytes',
      start(controller) {
        controller.enqueue(bytes.slice(0, 33));
        controller.enqueue(bytes.slice(33));
        controller.close();
      }
    })
  });
  await f.hub.webSocketMessage(f.socket, JSON.stringify({
    type: 'channel.open',
    channel: 'agent',
    name: 'script-agent'
  }));
  await f.hub.webSocketMessage(f.socket, JSON.stringify({
    type: 'channel.message',
    channel: 'agent',
    data: {
      type: 'run',
      run_id: 'run'
    }
  }));
  await Promise.all(f.pending);
  assert.deepEqual(f.sent.filter(message => message.data?.type === 'delta').map(message => message.data.text), ['中文']);
  assert.equal(f.sent.at(-1).data.type, 'done');
  assert.equal(f.hub.runs.size, 0);
});
test('普通路由即使以 ws 结尾也不能升级成管理员连接', async () => {
  const f = fixture();
  for (const path of ['/unknown/ws', '/_public/feed/raw/custom/ws', '/_reader/ws']) {
    const response = await f.hub.fetch(new Request('https://internal' + path, {
      headers: {
        Upgrade: 'websocket'
      }
    }));
    assert.equal(response.status, 404);
  }
});
