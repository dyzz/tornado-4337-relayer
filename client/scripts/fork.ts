/**
 * Dress rehearsal environment: an anvil fork of a live chain plus a local alto
 * bundler, kept alive until Ctrl-C. Run the real deploy / relayer / wallet
 * commands against it with only the RPC and bundler URLs swapped.
 *
 *   pnpm --filter @tornado-4337/client fork            # Sepolia (default)
 *   CHAIN=mainnet pnpm --filter @tornado-4337/client fork
 *
 * Prints RPC_URL / BUNDLER_URL and funds any FUND_ADDRESSES (comma-separated) with 10 ETH.
 */
import { Instance } from 'prool';
import { createPublicClient, createTestClient, http, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from '../src/chains.js';

const chainKey = (process.env.CHAIN ?? 'sepolia') as 'mainnet' | 'sepolia';
const setup = CHAINS[chainKey];
const forkUrl = process.env.FORK_URL ?? setup.publicRpc;
const anvilPort = Number(process.env.ANVIL_PORT ?? 8545);
const altoPort = Number(process.env.ALTO_PORT ?? 4337);

const anvil = Instance.anvil({ forkUrl, port: anvilPort, hardfork: 'Prague', chainId: setup.chain.id, blockTime: 1 });
await anvil.start();
const rpcUrl = `http://127.0.0.1:${anvilPort}`;
const testClient = createTestClient({ chain: setup.chain, mode: 'anvil', transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: setup.chain, transport: http(rpcUrl) });
console.log(`anvil: forked ${forkUrl} at block ${await publicClient.getBlockNumber()} -> ${rpcUrl}`);

const executorKey = generatePrivateKey();
const utilityKey = generatePrivateKey();
for (const k of [executorKey, utilityKey]) {
  await testClient.setBalance({ address: privateKeyToAccount(k).address, value: parseEther('1000') });
}
for (const a of (process.env.FUND_ADDRESSES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  await testClient.setBalance({ address: a as Address, value: parseEther('10') });
  console.log(`funded ${a} with 10 ETH`);
}

const alto = Instance.alto({
  rpcUrl,
  entrypoints: [setup.entryPoint],
  executorPrivateKeys: [executorKey],
  utilityPrivateKey: utilityKey,
  safeMode: false,
  port: altoPort,
});
await alto.start();
console.log(`alto:  http://127.0.0.1:${altoPort}`);
console.log(`\nexport RPC_URL=${rpcUrl} BUNDLER_URL=http://127.0.0.1:${altoPort}\nCtrl-C to stop.`);

const stop = async () => {
  await alto.stop();
  await anvil.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
