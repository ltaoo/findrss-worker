import { DurableObject } from "cloudflare:workers";

export { RealtimeHubDO } from "./infra/realtime_do.js";

// Preserve legacy namespace data while letting pending alarms finish without running old jobs.
export class APIDurableObject extends DurableObject {
  async alarm() {}
}
