import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { serve } from '@hono/node-server';
import { configFromEnv, setupConfigFromEnv } from './config.js';
import { createRelayerApp } from './rpc.js';
import { RelayerService } from './service.js';
import { ensurePaymasterSetup } from './setup.js';

// Load ./.env (relayer/.env) for keys not already set in the environment.
try {
  const parsed = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
} catch {
  // no .env file: rely on the process environment
}

const log = {
  info: (msg: string, meta?: Record<string, unknown>) => console.log(`[relayer] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[relayer] ${msg}`, meta ?? ''),
};
// 7702 mode: delegate the relayer address to the paymaster implementation, stake and fund it if needed.
const paymaster = await ensurePaymasterSetup(setupConfigFromEnv(), log);
const service = await RelayerService.create(configFromEnv(paymaster), log);
const app = createRelayerApp(service);
const port = Number(process.env.PORT ?? '8787');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[relayer] listening on http://localhost:${info.port}  (POST / for JSON-RPC, GET /status)`);
});
