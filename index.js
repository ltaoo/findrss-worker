import api from "./api.js";
import { handle_admin_request } from "./admin.js";
import { handle_discovery_request } from "./discover.js";
import { handle_rank_request, enqueue_rank_snapshot } from "./rank.js";
import { create_worker } from "./router.js";
export { RealtimeHubDO, APIDurableObject } from "./server/durable_object.js";
export { ApplicationEntrypoint } from "./server/application.js";
import { Application } from "./server/application.js";
const website = create_worker({
  api,
  admin: handle_admin_request,
  discovery: handle_discovery_request,
  rank: handle_rank_request,
  rank_snapshot: enqueue_rank_snapshot
});
export default {
  async fetch(request, env, ctx) {
    let application;
    const application_env = {
      ...env,
      APPLICATION: {
        fetch(input, init) {
          application ||= new Application(env, ctx);
          return application.fetch(new Request(input, init));
        }
      }
    };
    return website.fetch(request, application_env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const application = new Application(env, ctx);
    await application.jobs.scheduled(controller.scheduledTime || Date.now());
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        const result = await new Application(env, ctx).jobs.consume(message.body.id);
        if (result?.retry) message.retry({
          delaySeconds: 30
        });else message.ack();
      } catch (error) {
        console.warn('队列消费失败', error.message);
        message.retry();
      }
    }
  }
};
