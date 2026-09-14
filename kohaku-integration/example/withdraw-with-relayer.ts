/**
 * Minimal Kohaku host that unshields a Tornado note through the thin relayer on
 * a live network (Sepolia by default) using Pimlico's public bundler.
 *
 * Prerequisites
 *   - a deployed TornadoRelayerPaymaster + a running relayer (see ../../README.md)
 *   - the host mnemonic already holds a shielded note (shield with the SDK or import one)
 *
 * Environment
 *   RPC_URL          JSON-RPC of the chain (default: Sepolia publicnode)
 *   CHAIN_ID         default 11155111
 *   RELAYER_URL      thin relayer JSON-RPC endpoint
 *   PAYMASTER        TornadoRelayerPaymaster address
 *   BUNDLER_URL      default https://public.pimlico.io/v2/<CHAIN_ID>/rpc
 *   MNEMONIC         host keystore mnemonic
 *   RECIPIENT        final recipient (receives the funds / aTokens and the fee refund)
 *   ZAP              optional SwapAndSupplyZap address: wrap + supply to Aave instead of a plain forward
 */
import { createPublicClient, encodeFunctionData, getAddress, http, parseEther, type Address, type Hex } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

import { MemoryStorage, MnemonicKeystore, type Host } from '@kohaku-eth/plugins';
import { viem as viemProvider } from '@kohaku-eth/provider/viem';
import { createTCBroadcaster, E_ADDRESS, TornadoCashConfigs, TornadoCashProtocol } from '@kohaku-eth/tornado-cash';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const chainId = Number(env('CHAIN_ID', '11155111')) as 1 | 11155111;
const chain = chainId === 1 ? mainnet : sepolia;
const rpcUrl = env('RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com');
const relayerUrl = env('RELAYER_URL');
const paymaster = getAddress(env('PAYMASTER'));
const bundlerUrl = env('BUNDLER_URL', `https://public.pimlico.io/v2/${chainId}/rpc`);
const recipient = getAddress(env('RECIPIENT'));
const zap = process.env.ZAP ? getAddress(process.env.ZAP) : undefined;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const host: Host = {
  keystore: new MnemonicKeystore(env('MNEMONIC')),
  storage: new MemoryStorage(),
  network: { fetch },
  provider: viemProvider(publicClient),
};

const paymasterConfig = {
  [chainId]: {
    bundlerUrl,
    entryPointAddress: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as Address,
    paymasterAddress: paymaster,
    poolsAccountsMap: {},
    // The thin relayer: ERC-7677 paymaster service + tornado_quote.
    relayer: { url: relayerUrl },
  },
};

const protocol = new TornadoCashProtocol(host, { protocolConfig: TornadoCashConfigs[chainId], paymasterConfig });
const broadcaster = createTCBroadcaster(host, { paymasterConfig });

console.log('syncing ...');
await protocol.sync();
const nativeAsset = { __type: 'erc20' as const, contract: getAddress(E_ADDRESS) };
const [{ amount }] = await protocol.balance([nativeAsset]);
console.log(`shielded balance: ${amount} wei`);
if (amount < parseEther('0.1')) throw new Error('need at least one 0.1 ETH note');

const op = await protocol.prepareUnshield({ asset: nativeAsset, amount: parseEther('0.1') }, recipient, {
  mode: 'paymaster',
  ...(zap
    ? {
        tailCalls: async (_sender: Address, ctx?: { amount?: bigint }) => [
          {
            to: zap,
            value: ctx!.amount!,
            data: encodeFunctionData({
              abi: [
                {
                  type: 'function',
                  name: 'wrapEthAndSupply',
                  stateMutability: 'payable',
                  inputs: [{ name: 'onBehalfOf', type: 'address' }],
                  outputs: [],
                },
              ],
              functionName: 'wrapEthAndSupply',
              args: [recipient],
            }) as Hex,
          },
        ],
      }
    : {}),
});

const w = op.withdrawals[0]!;
if (w.mode !== 'paymaster') throw new Error('expected a paymaster withdrawal');
console.log(`userOp prepared: sender=${w.userOperation.sender} fee=${BigInt(w.proof.args[4])} wei`);

const [result] = await broadcaster.broadcast(op);
console.log(`userOp hash: ${result!.id}`);
