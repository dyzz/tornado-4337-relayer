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
- `paymasterAndData` layout: `paymaster(20) | verifGas(16) | postOpGas(16) | validUntil(6) | validAfter(6) | fee(32) | serviceFee(32) | refundTo(20) | sig(65)`.

**Relayer** (`relayer/src/service.ts`)

1. `tornado_quote({ instance, tailCallsGas?, gas?, maxFeePerGas? })` → conservative gas ceilings,
   bundler gas price (`pimlico_getUserOperationGasPrice`), and the minimum `fee`
   `= prefund × (1 + margin) + denomination × serviceFeeBps`. Over-quoting is free for the user
   because the excess is refunded on-chain.
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

Kohaku SDK integration (Sepolia fork, real Tornado pools, real Kohaku SDK with the patch):

```bash
pnpm --filter @tornado-4337/kohaku-integration setup   # clone kohaku @ pinned commit, apply patch, build
SEPOLIA_RPC_URL=<archive-capable sepolia rpc> pnpm --filter @tornado-4337/kohaku-integration e2e
```

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

## Economics (from the mainnet-fork e2e)

| | wei |
| --- | --- |
| fee bound in the proof | 1 604 324 488 614 492 |
| actual gas cost | 899 983 318 112 160 |
| refund to user | 259 890 266 176 116 |
| paymaster net (margin + 0.3 % service fee) | +385 582 723 203 636 |

## Notes and limits

- ETH instances only for now (fee in ETH). ERC-20 instances need a fee-token path in `postOp`.
- The relayer is stateless except for an in-memory nullifier lock (one live sponsorship per note).
- Unlike the trustless PrivacyPaymaster shipped with Kohaku, the paymaster here trusts the
  relayer's off-chain checks. In exchange the account is unrestricted, validation needs no stake,
  and a registered relayer can keep its economic role. Routing through `TornadoRouter` so the
  paymaster acts as a registered relayer worker (TORN burn) is a follow-up.
- The EIP-7702 authorization is signed by the ephemeral sender key; the relayer never sees it.
