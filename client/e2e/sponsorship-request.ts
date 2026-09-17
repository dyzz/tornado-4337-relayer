/**
 * Shared pieces for the fork suites that talk to the relayer the way a client does: shield a note,
 * build a complete, valid sponsorship request for it, send it, and stand in for the bundler or the
 * node when a test needs one of them to misbehave.
 */
import { createServer } from 'node:http';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { paymasterAdminAbi, tornadoAbi } from '../src/abi.js';
import { merklePath, syncLeaves } from '../src/merkle.js';
import { commitmentHex, createNote, type Note } from '../src/note.js';
import type { TornadoProver } from '../src/prover.js';
import { RelayerRpc } from '../src/relayerClient.js';
import { freePort, type Harness } from './harness.js';

/** Shield a note into the harness pool and return it with the pool's leaves. */
export async function shield(h: Harness): Promise<{ note: Note; leaves: (bigint | string)[] }> {
  const depositor = await h.newFundedAccount(parseEther('10'));
  const wallet = createWalletClient({ account: depositor, chain: h.setup.chain, transport: http(h.rpcUrl) });
  const note = createNote();
  const hash = await wallet.writeContract({
    address: h.instance,
    abi: tornadoAbi,
    functionName: 'deposit',
    args: [commitmentHex(note)],
    value: h.denomination,
  });
  const receipt = await h.publicClient.waitForTransactionReceipt({ hash });
  // Sync up to the deposit's own block: the node's reported head can still lag the receipt.
  const { leaves } = await syncLeaves(h.publicClient, h.instance, {
    fromBlock: h.instanceDeployBlock,
    toBlock: receipt.blockNumber,
    log: () => {},
  });
  return { note, leaves };
}

/**
 * A complete, valid sponsorship request for `note`, as the client would build it: a real proof naming
 * `sender` as recipient and the master as relayer, wrapped in the account's `executeBatch` calldata.
 * `senderImplementation` decides what the op's EIP-7702 authorization points at.
 */
export async function sponsorshipRequest(
  h: Harness,
  prover: TornadoProver,
  note: Note,
  leaves: (bigint | string)[],
  owner: ReturnType<typeof privateKeyToAccount>,
  senderImplementation: Address,
): Promise<{ op: Record<string, unknown>; fee: bigint }> {
  const rpc = new RelayerRpc(h.relayerUrl);
  const quote = await rpc.quote({ instance: h.instance, tailCallsGas: 60_000n });
  const path = merklePath(leaves, note.commitment);
  const proof = await prover.prove({
    nullifier: note.nullifier,
    secret: note.secret,
    pathElements: path.pathElements,
    pathIndices: path.pathIndices,
    root: path.root,
    nullifierHash: note.nullifierHash,
    recipient: BigInt(owner.address),
    relayer: BigInt(quote.relayer),
    fee: quote.fee,
    refund: 0n,
  });
  const [root, nullifierHash, recipient, relayerArg, feeArg] = proof.args;
  const withdraw = {
    target: h.paymaster,
    value: 0n,
    data: encodeFunctionData({
      abi: paymasterAdminAbi,
      functionName: 'relayWithdraw',
      args: [h.instance, proof.proof, root, nullifierHash, recipient, relayerArg, BigInt(feeArg)],
    }),
  };
  const callData = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'executeBatch',
        stateMutability: 'nonpayable',
        inputs: [
          {
            name: 'calls',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
        outputs: [],
      },
    ],
    functionName: 'executeBatch',
    args: [[withdraw]],
  });
  const authorization = await owner.signAuthorization({
    address: senderImplementation,
    chainId: h.setup.chain.id,
    nonce: await h.publicClient.getTransactionCount({ address: owner.address }),
  });
  return {
    fee: quote.fee,
    op: {
      sender: owner.address,
      nonce: toHex(0n),
      factory: '0x7702',
      callData,
      callGasLimit: toHex(quote.gas.callGasLimit),
      verificationGasLimit: toHex(quote.gas.verificationGasLimit),
      preVerificationGas: toHex(quote.gas.preVerificationGas),
      paymasterVerificationGasLimit: toHex(quote.gas.paymasterVerificationGasLimit),
      paymasterPostOpGasLimit: toHex(quote.gas.paymasterPostOpGasLimit),
      maxFeePerGas: toHex(quote.maxFeePerGas),
      maxPriorityFeePerGas: toHex(quote.maxPriorityFeePerGas),
      eip7702Auth: {
        address: senderImplementation,
        chainId: toHex(authorization.chainId),
        nonce: toHex(authorization.nonce),
        r: authorization.r,
        s: authorization.s,
        yParity: toHex(authorization.yParity!),
      },
    },
  };
}

/** `pm_getPaymasterData` as a client would call it, returning the JSON-RPC error when refused. */
export async function askForSponsorship(h: Harness, op: Record<string, unknown>) {
  const res = await fetch(h.relayerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [op, h.setup.entryPoint, toHex(BigInt(h.setup.chain.id)), {}],
    }),
  });
  return (await res.json()) as { result?: { paymasterData?: Hex }; error?: { code: number; message: string } };
}

/** A one-request JSON-RPC server standing in for the bundler. */
export async function startStubBundler(handler: () => Promise<Response>): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const server = createServer(async (_req, res) => {
    const out = await handler();
    const body = await out.text();
    res.writeHead(out.status, { 'content-type': out.headers.get('content-type') ?? 'text/plain' }).end(body);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * A JSON-RPC proxy in front of the fork that fails selected `eth_call`s — the node or transport going
 * wrong for one read, which the relayer must treat as "unknown", never as an on-chain zero.
 * `failing` can be switched while the proxy runs.
 */
export async function startFailingRpc(
  upstream: string,
  failSignatures: string[],
): Promise<{ url: string; failing: boolean; stop(): Promise<void> }> {
  const selectors = failSignatures.map((sig) => toFunctionSelector(sig).toLowerCase());
  const state = { failing: true };
  const shouldFail = (req: { method?: string; params?: unknown[] }) => {
    if (!state.failing || req.method !== 'eth_call') return false;
    const data = String((req.params?.[0] as { data?: string; input?: string } | undefined)?.data ??
      (req.params?.[0] as { input?: string } | undefined)?.input ?? '').toLowerCase();
    return selectors.some((sel) => data.startsWith(sel));
  };
  const port = await freePort();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      const one = async (r: { id: unknown; method?: string; params?: unknown[] }) => {
        if (shouldFail(r)) return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'injected node failure' } };
        const up = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
        return up.json();
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`,
    get failing() {
      return state.failing;
    },
    set failing(v: boolean) {
      state.failing = v;
    },
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
