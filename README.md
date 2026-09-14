# tornado-4337-relayer

A **thin Tornado Cash relayer on ERC-4337**. The relayer never submits transactions; it only signs.
A verifying paymaster pays for gas, collects the Tornado relayer fee during execution, and refunds
the excess. Users drive the flow from a Kohaku wallet (or any ERC-7677-capable wallet stack) and
send through Pimlico's bundler. Withdraw → swap → Aave supply happen in **one atomic userOp**.

```
 Kohaku wallet                     thin relayer                 Pimlico bundler (alto)        Ethereum
 ─────────────                     ────────────                 ───────────────────────       ────────
 tornado_quote ──────────────────► fee to bind in the proof
 prove(recipient=sender,
       relayer=paymaster, fee)
 pm_getPaymasterStubData ────────► stub paymasterData
 eth_estimateUserOperationGas ───────────────────────────────► simulate (dummy sigs)
 pm_getPaymasterData ────────────► validate callData + fee,
                                   simulate withdraw & op,
                                   sign(userOp, fee terms)
 sign userOp (EIP-7702 sender)
 eth_sendUserOperation ──────────────────────────────────────► bundle ─────────────────────► EntryPoint v0.8
                                                                                              ├ paymaster: verify relayer sig
                                                                                              ├ sender.executeBatch:
                                                                                              │   pool.withdraw (fee → paymaster)
                                                                                              │   zap.swapEthAndSupply (→ Aave, onBehalfOf user)
                                                                                              └ paymaster.postOp: keep gas+margin+serviceFee,
                                                                                                refund the rest, re-deposit
```

## Packages

| Path | What |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymaster.sol` (EntryPoint v0.8 verifying paymaster) and `SwapAndSupplyZap.sol` (Uniswap V3 → Aave V3 tail call). Foundry, 11 unit tests. |
| `contracts-tornado/` | Upstream `ETHTornado` (tornado-core, solc 0.7.6) compiled separately so the harness can deploy a fresh instance on a fork. |
| `relayer/` | The thin relayer: JSON-RPC server (`pm_getPaymasterStubData`, `pm_getPaymasterData` per ERC-7677, `tornado_quote`, `tornado_status`). |
| `client/` | Reference client (viem): proof generation, merkle sync, the sponsored-withdraw flow, and the e2e harness (anvil fork + alto + relayer). |
| `kohaku-integration/` | Patch for `@kohaku-eth/tornado-cash` adding relayer-signed sponsorship, an example host, and an e2e that drives the real Kohaku SDK. |

## How it works

**Paymaster** (`contracts/src/TornadoRelayerPaymaster.sol`)

- `validatePaymasterUserOp` only recovers the relayer's EIP-191 signature over
  `(userOp fields, chainId, paymaster, validUntil, validAfter, fee, serviceFee, refundTo)`.
  No external storage is touched, so no stake is required and validation is cheap.
- The withdraw runs in the **execution phase** as a normal call from the sender. The proof binds
  `relayer = paymaster`, so the instance pays `fee` wei to the paymaster.
- `postOp` keeps `actualGasCost × (1 + gasMarginBps) + serviceFee`, refunds the remainder to
  `refundTo`, and re-deposits what it kept into the EntryPoint. If execution reverted, nothing was
  received and the paymaster eats the gas (the relayer's pre-signing simulation keeps this rare).
- **ERC-20 pools** (DAI, WBTC on mainnet; DAI on Sepolia): the instance pays the fee in its token.
  The relayer prices gas with the same 1inch `OffchainOracle` the classic tornado-relayer uses and
  signs `feeToken` + `tokenPerEth` into `paymasterData`; `postOp` converts the actual gas cost at that
  signed rate, refunds the excess **in the token**, and keeps the rest in the contract for the
  operator to `sweepERC20` and turn back into EntryPoint deposit. No on-chain oracle is needed
  because the relayer is trusted anyway. `refund` (the ETH top-up classic relayers send) stays 0:
  the 7702 sender spends the tokens inside the same userOp.
- `paymasterAndData` layout: `paymaster(20) | verifGas(16) | postOpGas(16) | validUntil(6) | validAfter(6) | fee(32) | serviceFee(32) | refundTo(20) | feeToken(20) | tokenPerEth(32) | sig(65)`.

**Relayer** (`relayer/src/service.ts`)

1. `tornado_quote({ instance, tailCallsGas?, gas?, maxFeePerGas? })` → conservative gas ceilings,
   bundler gas price (`pimlico_getUserOperationGasPrice`), and the minimum `fee`
   `= prefund × (1 + margin) [× tokenPerEth] + denomination × serviceFeeBps`, in the pool's asset.
   Over-quoting is free for the user because the excess is refunded on-chain. Instances are
   auto-detected as ETH or ERC-20 on boot (`token()`); `PRICE_SOURCE=oneinch|fixed|none`.
2. `pm_getPaymasterData` decodes `execute`/`executeBatch`, finds the one withdraw whose `relayer` is
   the paymaster, checks `fee ≥ minimum` for the op's actual gas limits, rejects double sponsorship
   of a nullifier, `eth_call`s the withdraw (proof, root, nullifier), optionally runs
   `eth_estimateUserOperationGas` on the bundler (whole op incl. tail calls), then signs with a
   short `validUntil`.
3. The relayer holds only a signing key. It is not the paymaster owner and never touches user funds.

**Client / Kohaku** — the sender is an ephemeral EOA delegated via EIP-7702 to the canonical
`Simple7702Account` (exactly what Kohaku's paymaster mode already does). It is the Tornado recipient,
executes the tail calls, and the aTokens are minted straight to the user's final address
(`onBehalfOf`). The postOp refund also goes to that final address.

## Run it

Requirements: Foundry, Node ≥ 22, pnpm.

```bash
pnpm install
(cd contracts && forge install && forge build && forge test)   # 11 tests
(cd contracts-tornado && forge build)
pnpm --filter @tornado-4337/relayer test                       # relayer unit tests
```

Full flow on a **mainnet fork** (real EntryPoint v0.8, Simple7702Account, Uniswap V3, Aave V3, a
fresh Tornado ETH instance bound to the real Groth16 verifier, alto bundler, relayer in-process):

```bash
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com pnpm --filter @tornado-4337/client e2e
```

Set `TORNADO_ARTIFACTS_DIR` to a directory holding `tornado.json` and `tornadoProvingKey.bin`
(e.g. tornado-cli's `circuits/`); otherwise they are downloaded once into `client/artifacts/`.

Kohaku SDK integration (Sepolia fork, real Tornado pools, real Kohaku SDK with the patch; shield with
the SDK, unshield in `paymaster` mode with a wrap-and-supply-to-Aave tail call):

```bash
pnpm --filter @tornado-4337/kohaku-integration setup   # clone kohaku @ pinned commit, apply patch, build
pnpm --filter @tornado-4337/kohaku-integration e2e     # ~5 min, most of it SDK sync
```

Two testnet pitfalls the harness works around: publicnode's Sepolia `eth_getLogs` silently drops about
half of the Tornado `Deposit` logs (the default fork RPC is tenderly's gateway, and the Kohaku host feeds
the SDK through a gap-checked `externalSyncProvider`), and the well-known anvil keys are EIP-7702-delegated
on Sepolia, which breaks the bundler's beneficiary accounting (the harness uses fresh keys).

## Deploy for real

```bash
cd contracts
PRIVATE_KEY=0x… RELAYER_SIGNER=0x… DEPOSIT_WEI=500000000000000000 \
DEPLOY_ZAP=true WETH=0xC02a… SWAP_ROUTER=0x68b3… AAVE_POOL=0x8787… \
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

Then run the relayer (`relayer/.env.example`):

```bash
cd relayer && cp .env.example .env   # PAYMASTER_ADDRESS, RELAYER_PRIVATE_KEY, RPC_URL, BUNDLER_URL …
pnpm start
```

Point a Kohaku host at it by adding `relayer: { url }` to the chain's `paymasterConfig`
(see `kohaku-integration/example/withdraw-with-relayer.ts`). Any viem/permissionless wallet can use
the relayer as an ERC-7677 paymaster client: `createPaymasterClient({ transport: http(RELAYER_URL) })`.

## Economics (from the e2e runs, ~1.1 gwei)

| | 0.1 ETH note, mainnet fork (swap + Aave) | 100 DAI note, mainnet fork (Aave) | 0.1 ETH note, Sepolia fork via Kohaku SDK |
| --- | --- | --- | --- |
| fee bound in the proof | 0.001604 ETH | 3.09 DAI (1inch: 2504 DAI/ETH) | 0.001428 ETH |
| actual gas cost | 0.000907 ETH | 0.000755 ETH | — |
| refund to user | 0.000253 ETH | 0.57 DAI | 0.000217 ETH |
| paymaster keeps | +0.000385 ETH net | 2.52 DAI (≈ 0.0010 ETH) for 0.0008 ETH of gas | — |
| landed on the user | 246.96 aUSDC | 96.91 aDAI | 0.098572 aWETH |

Run `pnpm --filter @tornado-4337/client e2e` for both mainnet-fork cases (the 1inch oracle's first
call on a fork takes ~1 minute of state fetching).

## Notes and limits

- ERC-20 fees accumulate in the paymaster; the operator has to sweep and convert them to keep the
  EntryPoint deposit funded (a keeper, not `postOp`, should do the swap). Mainnet USDC/USDT pools are
  frozen by their issuers, so DAI, cDAI and WBTC are the practical ERC-20 pools.
- The relayer is stateless except for an in-memory nullifier lock (one live sponsorship per note).
- Unlike the trustless PrivacyPaymaster shipped with Kohaku, the paymaster here trusts the
  relayer's off-chain checks. In exchange the account is unrestricted, validation needs no stake,
  and a registered relayer can keep its economic role. Routing through `TornadoRouter` so the
  paymaster acts as a registered relayer worker (TORN burn) is a follow-up.
- The EIP-7702 authorization is signed by the ephemeral sender key; the relayer never sees it.
