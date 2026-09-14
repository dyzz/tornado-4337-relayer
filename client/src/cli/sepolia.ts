/**
 * Drive the flow on a live network (Sepolia by default) with a running relayer
 * and Pimlico's public bundler.
 *
 *   pnpm --filter @tornado-4337/client sepolia deposit            # shield 0.1 ETH, prints + saves the note
 *   pnpm --filter @tornado-4337/client sepolia withdraw <note>    # unshield via relayer paymaster -> zap -> Aave WETH
 *   pnpm --filter @tornado-4337/client sepolia status             # relayer status
 *
 * Environment
 *   RPC_URL         default: chain's public RPC (tenderly gateway on Sepolia)
 *   CHAIN           mainnet | sepolia (default sepolia)
 *   PRIVATE_KEY     funder / depositor EOA (needs ETH for the deposit + gas)
 *   RELAYER_URL     default http://localhost:8787
 *   BUNDLER_URL     default https://public.pimlico.io/v2/<chainId>/rpc
 *   POOL            Tornado ETH instance (default: the chain's 0.1 ETH pool)
 *   ZAP             SwapAndSupplyZap address (omit to just forward the ETH to RECIPIENT)
 *   RECIPIENT       final recipient (default: the PRIVATE_KEY address)
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, getAddress, http, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { tornadoAbi, zapAbi } from '../abi.js';
import { DEFAULT_ARTIFACTS_DIR, loadArtifacts } from '../artifacts.js';
import { CHAINS } from '../chains.js';
import { sponsoredWithdraw } from '../flow.js';
import { syncLeaves } from '../merkle.js';
import { commitmentHex, createNote, parseNoteString, toNoteString } from '../note.js';
import { createTornadoProver } from '../prover.js';
import { RelayerRpc } from '../relayerClient.js';

const chainKey = (process.env.CHAIN ?? 'sepolia') as 'mainnet' | 'sepolia';
const setup = CHAINS[chainKey];
const rpcUrl = process.env.RPC_URL ?? setup.publicRpc;
const relayerUrl = process.env.RELAYER_URL ?? 'http://localhost:8787';
const bundlerUrl = process.env.BUNDLER_URL ?? setup.pimlicoPublicBundler;
const pool = getAddress(process.env.POOL ?? setup.tornadoEth['0.1']!);
// Tornado Sepolia pools were deployed around block 5.59M; mainnet 0.1 ETH pool at 9.11M.
const POOL_DEPLOY_BLOCK: Record<string, bigint> = { sepolia: 5_594_000n, mainnet: 9_116_966n };

const publicClient = createPublicClient({ chain: setup.chain, transport: http(rpcUrl, { timeout: 120_000 }) });
const log = (m: string) => console.log(m);

const [cmd, arg] = process.argv.slice(2);

async function deposit() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const wallet = createWalletClient({ account, chain: setup.chain, transport: http(rpcUrl) });
  const denomination = await publicClient.readContract({ address: pool, abi: tornadoAbi, functionName: 'denomination' });
  const note = createNote();
  const noteString = toNoteString(note, 'eth', formatEther(denomination), setup.chain.id);
  mkdirSync(DEFAULT_ARTIFACTS_DIR, { recursive: true });
  const backup = join(DEFAULT_ARTIFACTS_DIR, `notes-${chainKey}.txt`);
  appendFileSync(backup, `${noteString}\n`);
  log(`note (also appended to ${backup}):\n  ${noteString}`);

  const hash = await wallet.writeContract({
    address: pool,
    abi: tornadoAbi,
    functionName: 'deposit',
    args: [commitmentHex(note)],
    value: denomination,
  });
  log(`deposit tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  log(`status ${receipt.status} in block ${receipt.blockNumber}`);
}

async function withdraw(noteString: string) {
  const note = parseNoteString(noteString);
  if (note.chainId !== BigInt(setup.chain.id)) throw new Error(`note is for chain ${note.chainId}, CHAIN=${chainKey}`);
  const funder = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const recipient = getAddress(process.env.RECIPIENT ?? funder.address);
  const zap = process.env.ZAP ? getAddress(process.env.ZAP) : undefined;

  log(`syncing deposit leaves of ${pool} (cached under ${DEFAULT_ARTIFACTS_DIR}) ...`);
  const { leaves } = await syncLeaves(publicClient, pool, {
    fromBlock: POOL_DEPLOY_BLOCK[chainKey]!,
    chunk: 5_000n,
    cacheFile: join(DEFAULT_ARTIFACTS_DIR, `leaves-${chainKey}-${pool.toLowerCase()}.json`),
    log: (m) => process.stdout.write(`\r${m}`.padEnd(120)),
  });
  log(`\n${leaves.length} leaves`);

  const { circuit, provingKey } = await loadArtifacts();
  const prover = await createTornadoProver(circuit, provingKey);
  const owner = privateKeyToAccount(generatePrivateKey()); // ephemeral EIP-7702 sender

  const result = await sponsoredWithdraw({
    publicClient,
    chain: setup.chain,
    bundlerUrl,
    relayerUrl,
    instance: pool,
    note,
    leaves,
    prover,
    owner,
    refundTo: recipient,
    tailCallsGas: zap ? 300_000n : 60_000n,
    tailCalls: ({ amount }) =>
      zap
        ? [{ to: zap, value: amount, data: encodeFunctionData({ abi: zapAbi, functionName: 'wrapEthAndSupply', args: [recipient] }) }]
        : [{ to: recipient, value: amount }],
    log,
  });
  log(`done: userOp ${result.userOpHash} in tx ${result.receipt.receipt.transactionHash}, success=${result.receipt.success}`);
}

switch (cmd) {
  case 'deposit':
    await deposit();
    break;
  case 'withdraw':
    if (!arg) throw new Error('usage: sepolia withdraw <note>');
    await withdraw(arg);
    break;
  case 'status':
    console.log(JSON.stringify(await new RelayerRpc(relayerUrl).status(), null, 2));
    break;
  case 'keygen': {
    for (const role of ['owner/deployer', 'relayer signer', 'user/depositor']) {
      const pk = generatePrivateKey();
      console.log(`${role.padEnd(16)} ${privateKeyToAccount(pk).address}  ${pk}`);
    }
    break;
  }
  default:
    console.log('usage: sepolia keygen | deposit | withdraw <note> | status');
}
