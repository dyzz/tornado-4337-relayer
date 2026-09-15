# Kohaku integration

`@kohaku-eth/tornado-cash` already has a `mode: 'paymaster'` unshield path built for the trustless
PrivacyPaymaster (the proof is executed *during* paymaster validation, no relayer). This package adds a
second sponsorship style to the same API: **relayer-signed**, for the thin relayer in this repo.

## The patch (`patches/0001-tornado-cash-relayer-signed-paymaster.patch`)

Against `ethereum/kohaku` @ `patches/KOHAKU_COMMIT`. It applies cleanly with `git apply`.

| File | Change |
| --- | --- |
| `packages/tornado-cash/src/plugin/interfaces/protocol-params.interface.ts` | `IPaymasterConfig.relayer?: { url }` — the only host-facing config change. |
| `packages/tornado-cash/src/paymaster/relayer-paymaster-client.ts` | New. ERC-7677 client (`pm_getPaymasterStubData`, `pm_getPaymasterData`) plus `tornado_quote`. |
| `packages/tornado-cash/src/state/thunks/relayerPaymasterWithdrawThunk.ts` | New. Quote → prove (relayer = `quote.relayer`: the paymaster, or the master EOA of the relayer it works for; fee = quote) → bundler estimate → re-quote/re-prove → relayer signature → sender signature. The sponsoring note is withdrawn by `paymaster.relayWithdraw(...)` in the userOp callData (executed by the 7702 sender, forwarded through the DAO's TornadoRouter so the RelayerRegistry burn applies), followed by the direct withdraws of the other consolidated notes and the tail calls. |
| `packages/tornado-cash/src/state/thunks/paymasterWithdrawThunk.ts` | Dispatches the new thunk when `paymasterConfig[chainId].relayer` is set; otherwise unchanged. |
| `packages/plugins/src/base.ts` | `tailCalls(address, context?: { amount, asset })` — the tail now learns how much the sender holds (denomination − fee) and of which asset (ERC-20 address, undefined for ETH), so "supply everything" tail calls are possible. Backwards compatible. |
| `packages/tornado-cash/src/index.ts` | Exports. |

Host usage is one config line:

```ts
const paymasterConfig = {
  [chainId]: {
    bundlerUrl: 'https://public.pimlico.io/v2/11155111/rpc',
    entryPointAddress: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
    paymasterAddress: '<the relayer's paymaster: its worker EOA (EIP-7702) or a standalone TornadoRelayerPaymaster>',
    poolsAccountsMap: {},
    relayer: { url: 'https://relayer.example/' },   // <- thin relayer (ERC-7677 + tornado_quote)
  },
};
const protocol = new TornadoCashProtocol(host, { protocolConfig, paymasterConfig });
const broadcaster = createTCBroadcaster(host, { paymasterConfig });

const op = await protocol.prepareUnshield(asset, recipient, {
  mode: 'paymaster',
  tailCalls: async (sender, ctx) => [{ to: zap, value: ctx!.amount!, data: wrapEthAndSupply(recipient) }],
});
await broadcaster.broadcast(op);
```

## The CLI patch (`patches/0002-kohaku-cli-relayer-paymaster.patch`)

Against `dmarzzz/kohaku-cli` @ `patches/KOHAKU_CLI_COMMIT`. Adds `KOHAKU_TORNADO_RELAYER_URL`,
`KOHAKU_TORNADO_PAYMASTER` (and `KOHAKU_BUNDLER_URL`) so `kohaku unshield --tail-calls target:calldata:max`
goes through the relayer; `max` spends everything the sender holds after the fee.

## Layout

- `scripts/setup.sh` — clone Kohaku at the pinned commit into `vendor/`, apply the patch, build.
- `scripts/export-patch.sh` — regenerate the patch after editing `vendor/kohaku`.
- `e2e/kohaku-sdk.test.ts` — Sepolia fork: shield with the SDK, unshield in paymaster mode with a
  wrap-and-supply-to-Aave tail call, sponsored by this repo's relayer + paymaster, bundled by alto;
  plus the DAI-100 pool: fee paid and refunded in DAI, tail = Uniswap DAI→LINK + Aave supply.
- `example/withdraw-with-relayer.ts` — a minimal live host (Pimlico public bundler).

```bash
pnpm --filter @tornado-4337/kohaku-integration setup
SEPOLIA_RPC_URL=… pnpm --filter @tornado-4337/kohaku-integration e2e
```

The e2e syncs the SDK from Kohaku's bundled Sepolia state snapshot up to the fork head, so the RPC
must return complete `eth_getLogs` results for that range (several public endpoints silently drop
logs; the test then fails root verification before it ever reaches the relayer).
