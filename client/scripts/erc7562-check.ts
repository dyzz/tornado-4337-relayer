/**
 * Strict ERC-7562 (bundler mempool) check of the paymaster's validation phase, run the way the
 * eth-infinitism reference bundler runs it — `debug_traceCall` of `EntryPoint.handleOps` with its
 * `bundlerCollectorTracer` JS tracer, then its `tracerResultParser` rule engine — but against a
 * live archive node with state overrides, so nothing has to be deployed:
 *   - the worker paymaster's runtime code (taken from the Sepolia deployment: same bytecode, same
 *     EntryPoint immutable) and its storage (owner, verifyingSigner, gas params, router);
 *   - its EntryPoint deposit and stake;
 *   - a fresh EIP-7702 sender (Simple7702Account) authorised in the operation itself.
 * Anything a strict bundler would reject (banned opcodes, foreign storage, unstaked self-storage …)
 * comes back as a rule violation. Needs a node with `debug_traceCall` JS tracers (reth, geth) and a
 * checkout of https://github.com/eth-infinitism/bundler built with `yarn preprocess`.
 *
 *   MAINNET_RPC_URL=http://… AA_BUNDLER_DIR=…/bundler npx tsx scripts/erc7562-check.ts
 *   … scripts/erc7562-check.ts --unstaked      negative control: the same op with an unstaked paymaster
 *                                              must be rejected (STO-031: self-storage needs a stake)
 */
import { createRequire } from 'node:module';
import {
  encodeDeployData,
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { encodePaymasterData, paymasterArtifact, paymasterHash, withdrawalHash, type FeeTerms } from '@tornado-4337/relayer';
import { paymasterAdminAbi } from '../src/abi.js';
import { CHAINS } from '../src/chains.js';
import { AA_BUNDLER_COMMIT, resolveBundlerDir } from '../src/aa-bundler.js';

const rpc = process.env.MAINNET_RPC_URL ?? 'http://10.200.200.1:8545';
// Pinned checkout (see src/aa-bundler.ts): the rule set these results refer to is one specific commit.
const bundlerDir = resolveBundlerDir();
const require = createRequire(import.meta.url);
const { bundlerCollectorTracer } = require(`${bundlerDir}/packages/validation-manager/dist/src/BundlerCollectorTracer.js`);
const { getTracerBodyString } = require(`${bundlerDir}/packages/validation-manager/dist/src/GethTracer.js`);
const { tracerResultParser } = require(`${bundlerDir}/packages/validation-manager/dist/src/TracerResultParser.js`);

const setup = CHAINS.mainnet;
const ENTRY_POINT = setup.entryPoint;
const SIMPLE_7702 = setup.simple7702Implementation;
const POOL = setup.tornadoEth['100']!;
const MASTER: Address = '0xb69e1e65142d293035323470d2B3c0c5d4E03F8e';

const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const accountAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function executeBatch(Call[] calls)',
]);

const client = createPublicClient({ chain: setup.chain, transport: http(rpc, { timeout: 120_000 }) });

// --- entities -------------------------------------------------------------------------------
const relayer = privateKeyToAccount(generatePrivateKey());
const user = privateKeyToAccount(generatePrivateKey());
const paymaster: Address = '0x00000000000000000000000000000000000ca7e5'; // any empty address; code + storage are overridden
// Runtime code of the worker contract the relayer software deploys (the embedded artifact), with its
// immutables set exactly as a mainnet deployment would: an eth_call of the creation code returns it.
const { data: code } = await client.call({
  account: relayer.address,
  data: encodeDeployData({ abi: paymasterArtifact.abi, bytecode: paymasterArtifact.bytecode as Hex, args: [ENTRY_POINT, relayer.address, 1_000n, 45_000n] }),
});
if (!code || code === '0x') throw new Error('could not derive the worker paymaster runtime code');

// --- the operation (worker mode: relayer = master, refundTo = 0) -----------------------------
const fee = parseEther('0.3015');
const proof: Hex = `0x${'11'.repeat(256)}`;
const root: Hex = `0x${'22'.repeat(32)}`;
const nullifierHash: Hex = `0x${'33'.repeat(32)}`;
const relayCall = encodeFunctionData({
  abi: paymasterAdminAbi,
  functionName: 'relayWithdraw',
  args: [POOL, proof, root, nullifierHash, user.address, MASTER, fee],
});
const callData = encodeFunctionData({ abi: accountAbi, functionName: 'executeBatch', args: [[{ target: paymaster, value: 0n, data: relayCall }]] });
const gas = { verificationGasLimit: 150_000n, callGasLimit: 1_200_000n, preVerificationGas: 100_000n, paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 90_000n };
const maxFeePerGas = 30_000_000_000n;
const maxPriorityFeePerGas = 1_000_000_000n;
const now = Math.floor(Date.now() / 1000);
const terms: FeeTerms = {
  validUntil: now + 300,
  validAfter: 0,
  fee,
  serviceFee: 0n,
  refundTo: '0x0000000000000000000000000000000000000000',
  feeToken: '0x0000000000000000000000000000000000000000',
  tokenPerEth: 0n,
  withdrawalHash: withdrawalHash({ instance: POOL, proof, root, nullifierHash, recipient: user.address, relayer: MASTER, fee }),
  senderImplementation: SIMPLE_7702,
};
const rpcOp = {
  sender: user.address,
  nonce: '0x0' as Hex,
  factory: '0x7702' as const,
  factoryData: '0x' as Hex,
  callData,
  callGasLimit: toHex(gas.callGasLimit),
  verificationGasLimit: toHex(gas.verificationGasLimit),
  preVerificationGas: toHex(gas.preVerificationGas),
  maxFeePerGas: toHex(maxFeePerGas),
  maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
  paymasterVerificationGasLimit: toHex(gas.paymasterVerificationGasLimit),
  paymasterPostOpGasLimit: toHex(gas.paymasterPostOpGasLimit),
};
const pmHash = paymasterHash({ op: rpcOp, chainId: 1n, paymaster, terms });
const pmSig = await relayer.signMessage({ message: { raw: pmHash } });
const paymasterAndData = concatHex([paymaster, pad(toHex(gas.paymasterVerificationGasLimit), { size: 16 }), pad(toHex(gas.paymasterPostOpGasLimit), { size: 16 }), encodePaymasterData(terms, pmSig)]);
const packed = {
  sender: user.address,
  nonce: 0n,
  initCode: '0x7702' as Hex,
  callData,
  accountGasLimits: concatHex([pad(toHex(gas.verificationGasLimit), { size: 16 }), pad(toHex(gas.callGasLimit), { size: 16 })]),
  preVerificationGas: gas.preVerificationGas,
  gasFees: concatHex([pad(toHex(maxPriorityFeePerGas), { size: 16 }), pad(toHex(maxFeePerGas), { size: 16 })]),
  paymasterAndData,
  signature: '0x' as Hex,
};
const authorization = await user.signAuthorization({ address: SIMPLE_7702, chainId: 1, nonce: 0 });
// The EntryPoint computes the userOp hash from the delegated sender's state; the account checks it against its own key.
const userOpHash = await client.readContract({
  address: ENTRY_POINT,
  abi: entryPointAbi,
  functionName: 'getUserOpHash',
  args: [packed],
  stateOverride: [{ address: user.address, code: concatHex(['0xef0100', SIMPLE_7702]) }],
});
packed.signature = await user.sign({ hash: userOpHash });

// --- state overrides: paymaster code + storage, its EntryPoint deposit and stake ------------
const slot = (i: number) => pad(toHex(i), { size: 32 });
const depositSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [paymaster, 0n])); // StakeManager.deposits at slot 0
const stakeSlot = toHex(BigInt(depositSlot) + 1n, { size: 32 });
const unstaked = process.argv.includes('--unstaked');
const stake = unstaked ? 0n : parseEther('0.1');
const packedStake = unstaked ? 0n : (1n) | (stake << 8n) | (86_400n << 120n); // staked | stake(uint112) | unstakeDelaySec(uint32) | withdrawTime(uint48)
const stateOverrides = {
  [paymaster]: {
    code,
    state: {
      [slot(0)]: pad(relayer.address, { size: 32 }), // _owner
      [slot(1)]: pad(relayer.address, { size: 32 }), // _verifyingSigner
      [slot(2)]: pad(toHex(1000n), { size: 32 }), // _gasMarginBps
      [slot(3)]: pad(toHex(45_000n), { size: 32 }), // _postOpGasOverhead
      [slot(4)]: pad(setup.dao.tornadoRouter!, { size: 32 }), // _router
    },
  },
  [ENTRY_POINT]: {
    stateDiff: {
      [depositSlot]: pad(toHex(parseEther('2')), { size: 32 }),
      [stakeSlot]: pad(toHex(packedStake), { size: 32 }),
    },
  },
};

// --- trace handleOps with the reference bundler's collector tracer ------------------------------
const handleOpsData = encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[packed], '0x0000000000000000000000000000000000000000'] });
const tx = {
  from: '0x0000000000000000000000000000000000000000',
  to: ENTRY_POINT,
  data: handleOpsData,
  gas: toHex(gas.preVerificationGas + gas.verificationGasLimit + gas.paymasterVerificationGasLimit + gas.callGasLimit + gas.paymasterPostOpGasLimit + 200_000n),
  authorizationList: [{
    chainId: toHex(authorization.chainId),
    address: authorization.address,
    nonce: toHex(authorization.nonce),
    yParity: toHex(authorization.yParity ?? 0),
    r: authorization.r,
    s: authorization.s,
  }],
};
const trace = (await client.request({
  method: 'debug_traceCall' as never,
  params: [tx, 'latest', { tracer: getTracerBodyString(bundlerCollectorTracer), stateOverrides }] as never,
})) as { calls: { type: string; data?: Hex; to?: string; method?: string }[]; callsFromEntryPoint: unknown[] };
if (process.env.DUMP_TRACE) {
  console.log(JSON.stringify(trace.calls.map((c) => ({ ...c, data: c.data?.slice(0, 10), return: (c as { return?: string }).return?.slice(0, 20) }))));
}
const last = trace.calls[trace.calls.length - 1];
if (last?.type === 'REVERT') throw new Error(`handleOps reverted in the trace: ${last.data?.slice(0, 200)}`);

// --- the rule engine: stake info as the EntryPoint would report it under the overrides ---------
const validationResult = {
  returnInfo: { sigFailed: false, validAfter: 0, validUntil: terms.validUntil },
  senderInfo: { addr: user.address, stake: 0, unstakeDelaySec: 0 },
  paymasterInfo: { addr: paymaster, stake: stake.toString(), unstakeDelaySec: unstaked ? 0 : 86_400 },
};
let contracts: string[];
try {
  [contracts] = tracerResultParser({ sender: user.address, paymaster, factory: undefined }, trace, validationResult, ENTRY_POINT);
} catch (err) {
  const message = (err as Error).message;
  if (unstaked) {
    // The negative control must fail for exactly the expected reason (ERC-7562 STO-031: an unstaked
    // paymaster reading/writing its own storage), not for any incidental error.
    if (/unstaked paymaster accessed/i.test(message) && /slot/i.test(message)) {
      console.log(`ERC-7562 negative control (bundler ${AA_BUNDLER_COMMIT.slice(0, 7)}): unstaked paymaster rejected for the expected reason — ${message}`);
      process.exit(0);
    }
    console.error(`ERC-7562 negative control FAILED: rejected for an unexpected reason — ${message}`);
    process.exit(1);
  }
  console.error(`ERC-7562 violation: ${message}`);
  process.exit(1);
}
if (unstaked) {
  console.error('ERC-7562 negative control FAILED: an unstaked paymaster touching its own storage was not rejected');
  process.exit(1);
}
console.log(`ERC-7562: validation of the sponsored operation passes the reference bundler rules (bundler ${AA_BUNDLER_COMMIT.slice(0, 7)})`);
console.log('  entities: sender (Simple7702Account, EIP-7702 in-op authorization), paymaster (worker contract, staked)');
console.log('  contracts referenced during validation:', contracts);
console.log('  top-level calls from the EntryPoint:', Object.keys(trace.callsFromEntryPoint as object).length);
process.exit(0);
