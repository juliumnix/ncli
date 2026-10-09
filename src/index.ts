import { join } from "node:path";
import { loadConfig } from "./config";
import { Hub } from "./hub";
import { serve } from "./server";

const cfg = loadConfig();
const root = join(import.meta.dir, "..");
const hub = new Hub(cfg, join(root, "views"), join(root, "fixtures/gh"));
await hub.start();
const server = serve(hub, cfg, join(root, "public"));
console.log(`NCLI on http://127.0.0.1:${server.port}`);
console.log(`harness=${hub.harness.id} viewBudget=${cfg.viewBytes} node=${cfg.nodeBytes}`);
console.log(`views: ${hub.views.list().map((v) => v.id).join(", ") || "(none)"}`);
console.log(`bus: ${hub.bus.socketPath}`);
