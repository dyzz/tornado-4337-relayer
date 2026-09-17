import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getAddress, hexToBigInt, isAddress, isHex, toHex, type Address, type Hex } from 'viem';

import type { RelayerService, SponsorContext } from './service.js';
import type { RpcUserOperation, UserOpGas } from './userop.js';
import { ValidationError } from './validate.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown[];
}

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

const hexGas = (gas: UserOpGas) => Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, toHex(v)]));

/**
 * JSON-RPC surface:
 *   pm_getPaymasterStubData(userOp, entryPoint, chainId, context)   ERC-7677
 *   pm_getPaymasterData(userOp, entryPoint, chainId, context)       ERC-7677
 *   tornado_quote({ instance, tailCallsGas?, gas?, maxFeePerGas? })  fee to bind into the proof
 *   tornado_status()
 */
export function createRelayerApp(service: RelayerService) {
  const app = new Hono();
  app.use('*', cors());

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/status', async (c) => c.json(await service.status()));

  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    if (Array.isArray(body)) {
      return c.json(await Promise.all(body.map((r) => handle(service, r as JsonRpcRequest))));
    }
    return c.json(await handle(service, body as JsonRpcRequest));
  });

  return app;
}

async function handle(service: RelayerService, req: JsonRpcRequest) {
  const id = req?.id ?? null;
  try {
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      throw new RpcError(-32600, 'Invalid Request');
    }
    const result = await dispatch(service, req.method, req.params ?? []);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (err instanceof ValidationError) return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
    if (err instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message, data: err.data } };
    }
    const message = err instanceof Error ? err.message : String(err);
    // An unexpected internal error is a bug, not a client mistake: log it with its stack so the cause
    // is visible in the relayer's own output rather than only as a one-line message to the caller.
    console.error(`[relayer] internal error in ${req?.method}:`, err);
    return { jsonrpc: '2.0', id, error: { code: -32603, message } };
  }
}

async function dispatch(service: RelayerService, method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case 'tornado_status':
      return await service.status();

    case 'tornado_quote': {
      const p = (params[0] ?? {}) as Record<string, unknown>;
      if (typeof p.instance !== 'string' || !isAddress(p.instance)) throw new RpcError(-32602, 'instance required');
      const gasIn = (p.gas ?? {}) as Record<string, Hex | undefined>;
      const gas: Partial<UserOpGas> = {};
      for (const key of [
        'callGasLimit',
        'verificationGasLimit',
        'preVerificationGas',
        'paymasterVerificationGasLimit',
        'paymasterPostOpGasLimit',
      ] as const) {
        if (gasIn[key] !== undefined) gas[key] = parseQuantity(gasIn[key], `gas.${key}`);
      }
      const quote = await service.quote({
        instance: getAddress(p.instance),
        tailCallsGas: p.tailCallsGas !== undefined ? parseQuantity(p.tailCallsGas, 'tailCallsGas') : undefined,
        gas,
        maxFeePerGas: p.maxFeePerGas !== undefined ? parseQuantity(p.maxFeePerGas, 'maxFeePerGas') : undefined,
      });
      return {
        ...quote,
        denomination: toHex(quote.denomination),
        tokenPerEth: toHex(quote.tokenPerEth),
        serviceFeeBps: toHex(quote.serviceFeeBps),
        serviceFee: toHex(quote.serviceFee),
        gasMarginBps: toHex(quote.gasMarginBps),
        gas: hexGas(quote.gas),
        maxFeePerGas: toHex(quote.maxFeePerGas),
        maxPriorityFeePerGas: toHex(quote.maxPriorityFeePerGas),
        fee: toHex(quote.fee),
      };
    }

    case 'pm_getPaymasterStubData': {
      const { op, context } = parseSponsorParams(service, params);
      return service.stubData(op, context);
    }

    case 'pm_getPaymasterData': {
      const { op, context } = parseSponsorParams(service, params);
      return service.sign(op, context);
    }

    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function parseSponsorParams(service: RelayerService, params: unknown[]): { op: RpcUserOperation; context: SponsorContext } {
  const [op, entryPoint, chainId, context] = params as [RpcUserOperation, Address, Hex, SponsorContext | null | undefined];
  if (!op || typeof op !== 'object' || !isAddress(op.sender) || !isHex(op.callData)) {
    throw new RpcError(-32602, 'invalid userOperation');
  }
  if (typeof entryPoint !== 'string' || entryPoint.toLowerCase() !== service.config.entryPoint.toLowerCase()) {
    throw new RpcError(-32602, `unsupported entryPoint; expected ${service.config.entryPoint}`);
  }
  const cid = typeof chainId === 'string' ? hexToBigInt(chainId as Hex) : BigInt(chainId as unknown as number);
  if (cid !== service.config.chainId) throw new RpcError(-32602, `unsupported chainId ${cid}`);
  return { op, context: (context ?? {}) as SponsorContext };
}

function parseQuantity(value: unknown, field: string): bigint {
  if (typeof value === 'string' && isHex(value)) return hexToBigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number') return BigInt(value);
  throw new RpcError(-32602, `${field} must be a hex or decimal quantity`);
}
