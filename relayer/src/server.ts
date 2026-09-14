import { serve } from '@hono/node-server';
import { configFromEnv } from './config.js';
import { createRelayerApp } from './rpc.js';
import { RelayerService } from './service.js';

const service = await RelayerService.create(configFromEnv());
const app = createRelayerApp(service);
const port = Number(process.env.PORT ?? '8787');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[relayer] listening on http://localhost:${info.port}  (POST / for JSON-RPC, GET /status)`);
});
