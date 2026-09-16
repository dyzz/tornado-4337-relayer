/**
 * Captures the mainnet deployment transactions of the canonical ERC-4337 v0.8 contracts — EntryPoint
 * (0x4337…) and Simple7702Account (0xe6Ca…) — both created through the deterministic deployment proxy
 * (0x4e59b44847b379578588920cA78FbF26c0B4956C, salt ‖ initCode), so replaying the same calldata on any
 * chain that has the proxy yields the same addresses. Output: e2e/fork-cache/canonical-4337.json.
 *
 *   MAINNET_RPC_URL=http://… npx tsx scripts/fetch-canonical-4337.ts
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, getContractAddress, http, keccak256, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';

const DETERMINISTIC_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const TARGETS: Record<string, Address> = {
  entryPoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  simple7702Account: '0xe6Cae83BdE06E4c305530e199D7217f42808555B',
};
const rpc = process.env.MAINNET_RPC_URL ?? 'http://10.200.200.1:8545';
const client = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 120_000 }) });

async function creationBlock(address: Address, hi: bigint): Promise<bigint> {
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await client.getCode({ address, blockNumber: mid });
    if (!code || code === '0x') lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

// The proxy itself: Nick's presigned, chain-agnostic creation transaction (needs 0.1 ETH at its sender).
const PROXY_TX_HASH: Hex = '0xeddf9e61fb9d8f5111840daef55e5fde0041f5702856532cdbb5a02998033d26';
const proxyRaw = (await client.request({ method: 'eth_getRawTransactionByHash' as never, params: [PROXY_TX_HASH] as never })) as Hex;
const proxyTx = await client.getTransaction({ hash: PROXY_TX_HASH });

const head = await client.getBlockNumber();
const out: Record<string, { address: Address; block: number; txHash: Hex; salt: Hex; initCode: Hex; data: Hex; gas: string }> = {};
for (const [name, address] of Object.entries(TARGETS)) {
  const block = await creationBlock(address, head);
  const { transactions } = await client.getBlock({ blockNumber: block, includeTransactions: true });
  const tx = transactions.find((t) => {
    if (!t.to || t.to.toLowerCase() !== DETERMINISTIC_DEPLOYER.toLowerCase() || t.input.length < 2 + 64) return false;
    const salt = `0x${t.input.slice(2, 66)}` as Hex;
    const initCode = `0x${t.input.slice(66)}` as Hex;
    const predicted = getContractAddress({ opcode: 'CREATE2', from: DETERMINISTIC_DEPLOYER, salt, bytecode: initCode });
    return predicted.toLowerCase() === address.toLowerCase();
  });
  if (!tx) throw new Error(`${name}: no deterministic-deployer transaction found in block ${block}`);
  const salt = `0x${tx.input.slice(2, 66)}` as Hex;
  const initCode = `0x${tx.input.slice(66)}` as Hex;
  out[name] = { address, block: Number(block), txHash: tx.hash, salt, initCode, data: tx.input, gas: tx.gas.toString() };
  console.log(`${name}: block ${block} tx ${tx.hash} initCode ${(initCode.length - 2) / 2} bytes (hash ${keccak256(initCode).slice(0, 10)}…)`);
}
// Tornado's Groth16 verifier (a pure, stateless contract): its runtime code is redeployed as-is on the
// dev chain through a minimal "return this runtime" init code.
const TORNADO_VERIFIER: Address = '0xce172ce1F20EC0B3728c9965470eaf994A03557A';
const verifierRuntime = (await client.getCode({ address: TORNADO_VERIFIER }))!;
console.log(`tornadoVerifier: runtime ${(verifierRuntime.length - 2) / 2} bytes`);

const file = new URL('../e2e/fork-cache/canonical-4337.json', import.meta.url);
writeFileSync(
  file,
  JSON.stringify(
    {
      deterministicDeployer: DETERMINISTIC_DEPLOYER,
      deterministicDeployerTx: { from: proxyTx.from, raw: proxyRaw, txHash: PROXY_TX_HASH },
      ...out,
      tornadoVerifier: { mainnetAddress: TORNADO_VERIFIER, runtime: verifierRuntime },
    },
    null,
    2,
  ),
);
console.log(`wrote ${file.pathname}`);
