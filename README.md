# tornado-4337-relayer

**A thin Tornado Cash relayer and paymaster integration for Kohaku — keep relayers, without turning them into bundlers.**

English | [简体中文](#简体中文)

> Experimental, unaudited integration. Acceptance is limited to **mainnet forks and live Sepolia**. This is not a mainnet production release.

Existing Tornado relayers can add ERC-4337 sponsorship for atomic withdrawals while retaining their master identity, fee recipient and DAO stake. The existing pools and proving circuit stay unchanged. This is an **optional service alongside the classic relayer**, not a drop-in replacement for its HTTP API or a requirement to migrate.

## What changes for a relayer?

```text
Classic:  check withdrawal              → sign and broadcast a transaction
This:     check UserOperation + simulate → sign sponsorship; wallet submits to a bundler
```

The relayer still quotes fees, checks the withdrawal and decides whether to serve it. It does not run a bundler or manage a UserOperation mempool. The **off-chain relayer signs**; its **on-chain paymaster verifies the signature and sponsors gas**. Deployment, registration and funding are separate setup actions.

## Keep the existing DAO and relayer economy

The supported path is a **standalone `TornadoRelayerPaymaster` contract registered as a worker of an existing master**. The master registers that new contract with `RelayerRegistry.registerWorker(master, paymaster)`, just as it adds a worker today. Its existing ENS identity and TORN stake remain in place; this integration does not require changing the DAO's governance contracts.

The withdrawal proof names the **master** as `relayer` and the UserOperation's **sender** as `recipient`. In worker mode, the quoted withdrawal fee goes to the master as a fixed fee; the paymaster does not refund unused gas to the user. Each authorised `relayWithdraw` goes through `TornadoRouter` and the existing Registry/FeeManager charging rules.

| Funds | Purpose |
| --- | --- |
| Master's TORN stake in RelayerRegistry | Charged under the DAO's per-instance fee rules. |
| Worker's ETH stake in EntryPoint | Separate bundler-validation stake; not the gas balance. |
| Worker's ETH deposit in EntryPoint | Pays sponsored gas. The operator replenishes it manually. |

Execution stays in one UserOperation:

```text
Wallet → relayer: quote, build proof, request sponsorship
Wallet → bundler → EntryPoint: submit the signed UserOperation
EntryPoint validates sender and paymaster, then executes the sender's batch:
  1. worker.relayWithdraw → TornadoRouter / registry charging → Tornado pool
  2. sender's tail calls, such as wrap / swap → Aave
```

Each sponsorship authorises one exact withdrawal. The SDK uses one UserOperation per note: the withdrawal and its tail calls are atomic **within that operation**, not across a multi-note withdrawal. Checks cover top-level account calls, not everything a tail-call contract may do internally.

## Run a Sepolia test relayer

Requires **Node.js 22+** and **pnpm**. Contract development and fork tests additionally require **Foundry with Prague support** and Tornado proving artifacts.

```bash
git clone --recurse-submodules https://github.com/dyzz/tornado-4337-relayer.git
cd tornado-4337-relayer
pnpm install
cp relayer/.env.example relayer/.env
```

**The template defaults to mainnet. Edit it before starting.** For a Sepolia 0.1 ETH test, replace the network, credentials and pool settings with:

```dotenv
CHAIN_ID=11155111
RPC_URL=https://<your-sepolia-rpc>
BUNDLER_URL=https://public.pimlico.io/v2/11155111/rpc
RELAYER_PRIVATE_KEY=0x<your-test-worker-private-key>
REWARD_ACCOUNT=0x<your-registered-sepolia-sandbox-master>
TORNADO_INSTANCES=0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b
PRICE_SOURCE=none
PAYMASTER_MODE=standalone
SPONSORSHIP_STORE=./sponsorships.json
PAYMASTER_DEPOSIT_WEI=50000000000000000
MIN_DEPOSIT_WEI=10000000000000000
```

Use a dedicated test key funded with Sepolia ETH. The master must already be registered in the **project's Sepolia sandbox**; mainnet registration does not carry over. The sandbox addresses are in [`client/src/chains.ts`](client/src/chains.ts). Do not use someone else's master or the demonstration worker as your deployment.

With the template's `AUTO_SETUP=true`, startup can deploy the worker contract, set its Router, stake ETH and fund its EntryPoint deposit. It prints the worker address and waits for the master to register it. Reused deployments are checked for compatible layout, EntryPoint, signer and Router before stake/deposit transactions. `AUTO_SETUP=false` disables automatic setup transactions.

```bash
pnpm --filter @tornado-4337/relayer start
# From the master account, on the same network:
# RelayerRegistry.registerWorker(masterAddress, newPaymasterAddress)
# Then, from another terminal:
curl http://127.0.0.1:8787/status
```

`PRIVATE_KEY`, `HTTP_RPC_URL`, `NET_ID` and `RELAYER_FEE` are supported classic-relayer aliases. Prefer one naming scheme: values already exported in the process environment take precedence over `.env`. `RELAYER_FEE=0.3` means **0.3%**, equivalent to `SERVICE_FEE_BPS=30`; the latter takes precedence when both are set.

See [`.env.example`](relayer/.env.example) for all settings. `PAYMASTER_DEPOSIT_WEI` is a **startup funding target**, not continuous auto-refill. `MIN_DEPOSIT_WEI` reserves headroom when accepting new sponsorships; `MAX_SPONSORSHIP_GAS_WEI` optionally caps one operation. ERC-20 pools require a configured price source and pay the withdrawal fee in the pool's token, while sponsored gas is still paid in ETH.

Keep the paymaster state file and sponsorship store on persistent storage, with stable paths. Run **one signing process per store/key**; the JSON store is not a shared multi-instance backend. Do not delete live sponsorship records to bypass a refusal. Review logging, transport security and access controls before exposing the service publicly.

## Integrate with Kohaku

This repository supplies patches against pinned Kohaku SDK and CLI revisions; it does not imply the changes are already upstream. Prepare them with:

```bash
pnpm --filter @tornado-4337/kohaku-integration setup
```

Configure the worker paymaster, EntryPoint, bundler and relayer URL in the patched SDK:

```ts
const paymasterConfig = {
  [chainId]: {
    entryPointAddress: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
    paymasterAddress: workerPaymasterAddress,
    bundlerUrl,
    poolsAccountsMap: {},
    relayer: { url: relayerUrl },
  },
};
```

The wallet obtains a quote, binds `quote.relayer` and `quote.fee` into the proof, estimates gas, obtains sponsorship, signs the final UserOperation and submits it to the bundler. A changed fee requires a new proof; do not alter the signed gas limits or calldata after sponsorship. A stub response is for estimation, **not** an approval.

The [live SDK example](kohaku-integration/example/withdraw-with-relayer.ts) uses `mode: 'paymaster'`, supports optional Aave tail calls and exposes `OP_OUT` for saving the prepared operation. After setting its documented environment variables, run `pnpm --filter @tornado-4337/kohaku-integration example`. It requires an existing shielded note in the host keystore. `MNEMONIC` belongs to the client, not the relayer; its environment is separate from `relayer/.env`.

The [JSON-RPC implementation](relayer/src/rpc.ts) exposes these methods at `POST /`:

| Method | Purpose |
| --- | --- |
| `tornado_quote` | Fee and gas quote for an instance; optional tail-call gas or gas overrides. |
| `pm_getPaymasterStubData` | ERC-7677 estimation fields. |
| `pm_getPaymasterData` | Validate, simulate and return signed sponsorship. |
| `tornado_status` | Status, also available at `GET /status`. |

Sponsor methods take `[userOp, entryPoint, chainId, context]`. `GET /health` reports process liveness only; use `/status` to inspect balances, registration, budget and unavailable reads.

## Safety and operating boundaries

**Restricted sponsorship.** The default sender implementation is Simple7702Account v0.8. The relayer enforces a non-empty allowlist, and the paymaster binds both the exact withdrawal and the sender implementation. This release refuses `PAYMASTER_MODE=7702` for the **relayer's own EOA**; that is distinct from the supported **user-side 7702 sender**.

**Checks before issuing.** The service checks the proof, root, nullifier, fee, current worker registration and available gas budget, then requires bundler simulation with all five gas fields. Simulation cannot be disabled. With `SPONSORSHIP_STORE` configured, the signed record is written before the signature is returned; a failed write refuses issuance and releases the reservation. Live legacy records with unknown gas costs pause new sponsorships until they expire, regardless of the current per-operation cap. See [`service.ts`](relayer/src/service.ts) and [`store.ts`](relayer/src/store.ts).

**Atomic does not mean free failure.** If execution reverts, the withdrawal, fee and TORN charge roll back, but the paymaster can still lose gas. Sender nonce/delegation changes need not roll back. Simulation cannot eliminate changes between signing and inclusion, and a successful bundle transaction does not prove its UserOperation succeeded. Short validity and budget limits constrain exposure; they do not guarantee payment or profitability. See the [execution-failure test](client/e2e/execution-failure.test.ts) and [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337).

**Retry and deployment scope.** One live sponsorship per note is retained until expiry, including after a restart. A failed attempt may therefore require waiting before requesting another signature; keep the note and read current nonce/delegation state when rebuilding. Compatibility is scoped to the tested configuration, not every account, bundler or strict mempool. No production-readiness or independent security-audit claim is made.

## Tests and acceptance evidence

### Mainnet fork

The [canonical acceptance test](contracts/test/fork/MainnetAcceptance.t.sol) uses the existing mainnet ETH-100 pool, EntryPoint v0.8, Simple7702Account, DAO Router/Registry/FeeManager and an existing registered master at block **25,981,000**. It simulates the master's worker-registration action without changing governance-owned configuration. Supporting suites also use fixture pools; they are not substitutes for this canonical-pool check.

From the repository root:

```bash
export MAINNET_RPC_URL='https://<your-mainnet-archive-rpc>'
export TORNADO_ARTIFACTS_DIR='/absolute/path/to/tornado-cli/circuits'
(cd contracts && forge install && forge build)
(cd contracts-tornado && forge build)
pnpm --filter @tornado-4337/relayer test
(cd contracts && forge test -vv)
pnpm --filter @tornado-4337/client e2e
```

The tests need an RPC that can serve the pinned historical state. Committed fork/leaf caches reduce upstream work, but are not a guarantee of offline execution. Without `MAINNET_RPC_URL`, the Foundry mainnet acceptance tests are skipped. The fork suites cover normal withdrawals, fees, rejected sponsorships, file-backed restart/replay checks and execution failure/retry.

### Live Sepolia

Sepolia uses a **project-controlled DAO sandbox**, with test TORN and test fee settings—not the mainnet DAO. It checks real deployment and UserOperation submission; mainnet-fork tests provide the evidence for integration with existing DAO contracts.

[Latest recorded acceptance](https://github.com/dyzz/tornado-4337-relayer/commit/073e9b42c37b7d8d8acd5ea3a9737bcae6893eed): **2026-09-17**, implementation [`2690d5c`](https://github.com/dyzz/tornado-4337-relayer/commit/2690d5c11d10dc011927c2c36a347b983014c174). The report records **37/37 Foundry tests**, including four mainnet acceptance cases, and **24/24 Vitest fork cases** across six files.

[Sepolia withdrawal `0x165edf28…446d`](https://sepolia.etherscan.io/tx/0x165edf282b9cec79e2f6e70354c53c857ddb38a753abb638204552ea8778446d): **0.1 ETH → registered worker → Router → wrap → Aave**.

| Reported result | Amount, rounded |
| --- | ---: |
| Withdrawal fee paid to master | 0.002142 ETH |
| Gas charged to worker's EntryPoint deposit | 0.000842 ETH |
| Sandbox TORN charged from master's stake | 0.1137 test TORN |
| aWETH delivered to recipient | 0.097858 aWETH |

The report also records a relayer restart while sponsorship was live: the file-backed record and its approximately **0.001674 ETH** gas ceiling were restored, and replay was refused with `note already sponsored`. Restart and replay refusal are **off-chain observations in that report**, not facts proven by the transaction alone. These are dated test results, not fixed fees, pricing guidance or an assurance that later revisions pass.

#### On-chain record

Addresses of the demonstration deployment, for checking the transactions below — not for use as your own deployment:

| Role | Sepolia address |
| --- | --- |
| Worker paymaster, deployed by the relayer software | [`0x12319951…488D`](https://sepolia.etherscan.io/address/0x12319951c1E1A8de07aa7363BECA8d20Bb54488D) |
| Relayer signing key, sender of the worker's setup transactions | [`0x168EB79a…F91E`](https://sepolia.etherscan.io/address/0x168EB79a6707CC95935B7773d07a899954A6F91E) |
| Master: sandbox registration, test TORN stake, fee recipient | [`0x4DC4F08E…c68B`](https://sepolia.etherscan.io/address/0x4DC4F08E87935135FDa56D11E1e303117B26c68B) |
| Sandbox `TornadoRouter` / `RelayerRegistry` | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D) / [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) |
| ETH 0.1 pool | [`0x8C4A04d8…F50b`](https://sepolia.etherscan.io/address/0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b) |
| Swap/Aave helper called by the tail call | [`0x2B247C8e…Ca33`](https://sepolia.etherscan.io/address/0x2B247C8ee4556B35d510C0BdBD75194c11C4Ca33) |

| Block | Transaction | Step |
| ---: | --- | --- |
| 11716691 | [`0x29991c6b…5010`](https://sepolia.etherscan.io/tx/0x29991c6b803537ac6440c6534ce76734507a4eeef1c7a3d3ead8af11815b5010) | Relayer software deploys the worker paymaster (`AUTO_SETUP`). |
| 11716693 | [`0xa47543d7…a696`](https://sepolia.etherscan.io/tx/0xa47543d7f76cd36bca4a98d1ca23b96e3b9381adb1970a19c008651a3b7aa696) | Worker stakes 0.02 ETH in the EntryPoint. |
| 11716695 | [`0x3646cfeb…eca8`](https://sepolia.etherscan.io/tx/0x3646cfeb35a5e4d1ae144e9efa3f45c43142fbd017563b0f89f44d85167deca8) | Worker's EntryPoint deposit is funded with 0.04 ETH. |
| 11716711 | [`0x5c123f80…77e3`](https://sepolia.etherscan.io/tx/0x5c123f803ae324b78a467ee3993f24da60f0b74121c7e85da8161e5d6cf177e3) | Master calls `registerWorker(master, worker)`. |
| 11722902 | [`0xae57c597…224f`](https://sepolia.etherscan.io/tx/0xae57c597974715318b134990ce00e8a8f191f25f2cca80c0f939c2529a8c224f) | Test wallet shields 0.1 ETH through the Kohaku SDK. |
| 11722909 | [`0x165edf28…446d`](https://sepolia.etherscan.io/tx/0x165edf282b9cec79e2f6e70354c53c857ddb38a753abb638204552ea8778446d) | **Sponsored withdrawal** (UserOperation `0x8f7982d6…a0cf`). |
| 11722912 | [`0x52e5bbe4…c8c0`](https://sepolia.etherscan.io/tx/0x52e5bbe4acd185055e0e7fdadeeb9662e482b27016f4413ab3a2bec91cb5c8c0) | Relayer key tops the deposit back up to its 0.04 ETH startup target (+0.000842 ETH, this withdrawal's gas); sent on the restart described above. |

Logs of the withdrawal transaction, in order:

| Emitted by | Event | Shows |
| --- | --- | --- |
| `RelayerRegistry` | `StakeBurned(master, 0.1137 TORN)` | Test TORN charged from the master's stake. |
| ETH 0.1 pool | `Withdrawal(to = sender, relayer = master, fee = 0.002142 ETH)` | The fee bound in the proof is paid to the master. |
| Worker paymaster | `Relayed(pool, nullifierHash, master, fee, viaRouter = true)` | The authorised `relayWithdraw` went through `TornadoRouter`. |
| WETH, Aave pool, aWETH, helper | `Deposit`, `Supply`, `Mint`, `Supplied`: 0.097858 on behalf of the recipient | Tail call: wrap, then supply to Aave. |
| Worker paymaster | `Sponsored(userOpHash, refundTo = 0, fee = 0.002142 ETH, refund = 0)` | Settled in `postOp`; worker mode refunds nothing. |
| EntryPoint | `UserOperationEvent(paymaster = worker, success = true, actualGasCost = 0.000842 ETH)` | The operation succeeded; its gas came from the worker's deposit. |

## Repository

| Path | Contents |
| --- | --- |
| [`relayer/`](relayer/) | Signing service, setup, pricing, JSON-RPC and sponsorship store. |
| [`contracts/`](contracts/) | Paymaster, optional swap/Aave helper, sandbox and Foundry tests. |
| [`client/`](client/) | Reference wallet/prover flow and mainnet-fork integration tests. |
| [`kohaku-integration/`](kohaku-integration/) | Pinned SDK/CLI patches and live example. |

---

# 简体中文

**为 Kohaku 提供轻量 Tornado Cash relayer 与 paymaster 集成：保留现有 relayer，而不是让运营者变成 bundler。**

[English](#tornado-4337-relayer) | 简体中文

> 实验性集成，未经安全审计。验收范围仅限 **mainnet fork 和 Sepolia 实网上链**，不代表主网生产发布。

现有 Tornado relayer 可以增加 ERC-4337 原子提现赞助服务，同时保留原有 master 身份、手续费收款地址与 DAO 质押。既有池和证明电路不变。这是可以与经典 relayer 并行运行的**可选接入方式**，不是原 HTTP API 的直接替代，也不要求现有运营者迁移。

## 对 relayer 来说，变化是什么？

```text
经典 relayer：检查提现请求                  → 签名并广播交易
本项目：      检查 UserOperation 并模拟执行 → 签 sponsorship，由钱包提交给 bundler
```

Relayer 仍然负责报价、检查提现、决定是否服务，不需要运行 bundler 或维护 UserOperation mempool。**链下 relayer 负责签名，链上 paymaster 负责验签和支付 gas**；部署、注册和入金是独立的初始化操作。

## 保留现有 DAO 与 relayer 经济体系

当前支持路径是：部署独立的 `TornadoRelayerPaymaster` 合约，由已有 master 调用 `RelayerRegistry.registerWorker(master, paymaster)`，将其登记为新 worker。Master 原有的 ENS 身份和 TORN stake 保持不变，不需要修改 DAO 治理合约。

证明中的 `relayer` 仍是 **master**，`recipient` 则是 UserOperation 的 **sender**。Worker 模式收取固定报价，提现手续费直接支付给 master，paymaster 不向用户退还未使用的 gas 差额。被授权的那笔 `relayWithdraw` 经过 `TornadoRouter`，并按现有 Registry/FeeManager 规则扣费。

三类资金必须分清：**master 在 RelayerRegistry 中的 TORN stake** 用于 DAO 扣费；**worker 在 EntryPoint 中的 ETH stake** 是独立的验证质押；**worker 在 EntryPoint 中的 ETH deposit** 才是支付 gas 的余额，需要运营者手动补充。手续费进入 master，不会自动变成 worker 的 gas deposit。

钱包先取得报价、生成证明并请求赞助，再把签好的 UserOperation 交给 bundler。EntryPoint 完成验证后，由 sender 执行“worker 提现 → Router／Registry 收费 → 池子 → wrap／swap／Aave 等尾调用”。每个 sponsorship 只授权一笔确定的提现，SDK 每张 note 生成一个 UserOperation。原子性仅在**单个 operation 内**成立，多 note 之间不保证整体原子性；顶层调用检查也不保证尾调用合约内部的全部行为。

## 启动 Sepolia 测试 relayer

需要 **Node.js 22+ 和 pnpm**；合约开发与 fork 测试另外需要支持 Prague 的 **Foundry** 和 Tornado proving artifacts。

安装命令与 Sepolia 配置见上方 [Run a Sepolia test relayer](#run-a-sepolia-test-relayer)。**`.env.example` 默认指向主网，必须先修改，不能直接启动。** 示例只服务 Sepolia 的 0.1 ETH 池，使用专用测试 worker 私钥和已在本项目 sandbox 注册的 master。主网注册关系不会自动带到 Sepolia；不要把别人的 master 或演示 worker 当成自己的部署。

默认 `AUTO_SETUP=true` 会执行所需的部署、Router 设置、ETH stake 和 deposit 入金，随后打印新 worker 地址并等待 master 注册。复用旧合约时，会在 stake/deposit 交易前检查布局、EntryPoint、signer 和 Router 是否匹配。设置 `AUTO_SETUP=false` 可禁用自动初始化交易。

```bash
pnpm --filter @tornado-4337/relayer start
# 由同一网络上的 master 账户执行：
# RelayerRegistry.registerWorker(masterAddress, newPaymasterAddress)
# 在另一个终端查看状态：
curl http://127.0.0.1:8787/status
```

兼容经典 relayer 的 `PRIVATE_KEY`、`HTTP_RPC_URL`、`NET_ID`、`RELAYER_FEE` 名称。建议只用一套命名；进程环境中已设置的值优先于 `.env`。`RELAYER_FEE=0.3` 表示 **0.3%**，等于 `SERVICE_FEE_BPS=30`，同时设置时后者优先。

完整参数见 [`.env.example`](relayer/.env.example)。`PAYMASTER_DEPOSIT_WEI` 是**启动时的入金目标**，不是持续自动补款；`MIN_DEPOSIT_WEI` 为新赞助保留余额余量，`MAX_SPONSORSHIP_GAS_WEI` 可限制单笔 gas 支出上限。ERC-20 池需要配置价格源，提现费使用池内代币计价，而 gas 仍以 ETH 支付。

Paymaster 状态文件和 sponsorship 文件应使用稳定路径、保存在持久化存储中。**一套 store/key 只运行一个签名进程**；JSON 文件不是多实例共享存储。不要删除仍有效的赞助记录来绕过拒签。对外开放前，应配置传输安全、访问控制和日志保留策略。

## Kohaku 接入

仓库提供固定版本的 Kohaku SDK／CLI 补丁，不代表修改已经进入上游。运行 `pnpm --filter @tornado-4337/kohaku-integration setup` 准备依赖，然后按上方 [Integrate with Kohaku](#integrate-with-kohaku) 配置 worker paymaster、EntryPoint、bundler URL 和 `relayer: { url }`。

钱包按“报价 → 证明绑定 `quote.relayer` 与 `quote.fee` → gas 估算 → relayer 签 sponsorship → sender 签最终 UserOperation → 提交 bundler”执行。Fee 改变需要重新生成证明；赞助后不能再改 gas 上限或 calldata。Stub 仅供估算，不是已经获批的赞助。

[实网示例](kohaku-integration/example/withdraw-with-relayer.ts) 支持普通提现和 Aave 尾调用。配置其文件头列出的环境变量后，运行 `pnpm --filter @tornado-4337/kohaku-integration example`。它要求客户端 keystore 已持有 shielded note；`MNEMONIC` 是客户端密钥材料，与 relayer 私钥不同，示例的环境配置也不读取 `relayer/.env`。`OP_OUT` 可保存已准备的 operation，方便重放检查。

服务在 `POST /` 提供 `tornado_quote`、ERC-7677 的 `pm_getPaymasterStubData`／`pm_getPaymasterData`，以及 `tornado_status`。两个 sponsor 方法的参数是 `[userOp, entryPoint, chainId, context]`。`GET /status` 返回资金、注册、预算和读取失败信息；`GET /health` 只表示进程存活，不代表当前可以接受赞助。

## 安全与运行边界

**限制账户实现。** 默认只赞助 Simple7702Account v0.8，白名单不能为空；链上签名绑定确切提现和 sender implementation。当前拒绝的是“relayer 自己的 EOA 兼任 paymaster”的 `PAYMASTER_MODE=7702`，不是用户侧的 7702 sender。

**先检查，先记录，再发出签名。** 签名前检查 proof、root、nullifier、fee、当前 worker 注册关系与 gas 预算，并强制要求 bundler 模拟返回全部五个 gas 字段。启用 `SPONSORSHIP_STORE` 后，签名记录必须先落盘才能返回；写入失败会拒绝发出签名并释放预留。仍有效但没有记录 gas 成本的旧条目，会暂停新赞助直到过期，不能用当前单笔 cap 代替旧承诺。实现见 [`service.ts`](relayer/src/service.ts) 和 [`store.ts`](relayer/src/store.ts)。

**原子执行不等于失败免费。** 执行回滚时，提现、手续费和 TORN 扣费一起回滚，但 paymaster 仍可能损失 gas；sender nonce／delegation 的变化也不一定回滚。签名前模拟无法排除签名到打包之间的状态变化，外层 bundle 成功不代表内部 UserOperation 成功。短有效期和预算限制只能约束敞口，不保证收款或盈利，具体回归见 [execution-failure 测试](client/e2e/execution-failure.test.ts)。

**重试与支持范围。** 每张 note 的有效赞助保留到过期，重启也不会清除；一次执行失败后，重新申请赞助可能仍需等待。保留原 note，重建操作时重新读取 nonce／delegation。兼容性结论仅覆盖已测试配置，不扩展为任意账户、任意 bundler 或所有严格 mempool 均可用。当前不作生产就绪或独立安全审计声明。

## 测试与验收记录

**Mainnet fork。** [Canonical acceptance 测试](contracts/test/fork/MainnetAcceptance.t.sol) 固定在主网区块 **25,981,000**，使用既有 ETH-100 池、EntryPoint v0.8、Simple7702Account、真实 DAO Router／Registry／FeeManager 和已有注册 master，模拟 master 添加 worker，不修改治理管理的配置。其他辅助测试也会使用 fixture 池，不能把它们与 canonical-pool 验收混为一谈。

完整命令见上方 [Mainnet fork](#mainnet-fork)。必须设置 `MAINNET_RPC_URL` 与绝对路径的 `TORNADO_ARTIFACTS_DIR`；缺少前者时，Foundry 的主网验收测试会被跳过。RPC 需要能提供固定区块的历史状态；已提交的缓存能减少上游读取，不代表离线即可完成所有测试。

**Sepolia 实网。** 使用本项目控制的 DAO sandbox、测试 TORN 与测试费用参数，不是主网 DAO 部署。它验证真实部署和 UserOperation 提交流程；现有 DAO 合约兼容性由主网 fork 验证。

[2026-09-17 验收记录](https://github.com/dyzz/tornado-4337-relayer/commit/073e9b42c37b7d8d8acd5ea3a9737bcae6893eed) 对应实现版本 `2690d5c`：报告记录 Foundry **37/37**，含四项主网 acceptance，以及六个文件内的 Vitest fork 测试 **24/24**。

[Sepolia 交易 `0x165edf28…446d`](https://sepolia.etherscan.io/tx/0x165edf282b9cec79e2f6e70354c53c857ddb38a753abb638204552ea8778446d) 展示 **0.1 ETH 提现 → 注册 worker → Router → wrap → Aave**。报告中的四舍五入数值为：master 收取 **0.002142 ETH**，worker deposit 支付 gas **0.000842 ETH**，master stake 扣除 **0.1137 测试 TORN**，最终到账 **0.097858 aWETH**。

该记录还包含一次有效赞助期间的 relayer 重启：恢复文件记录及约 **0.001674 ETH** 的 gas 预算，重复申请返回 `note already sponsored`。重启与拒签属于报告中的**链下运行观察**，不能仅凭交易证明。这些是特定日期与版本的测试结果，不是固定收费、报价建议，也不保证后续修改自动通过。

**链上记录。** 下列地址属于演示部署，仅用于核对下面的交易，不要当作自己的部署：

| 角色 | Sepolia 地址 |
| --- | --- |
| Worker paymaster，由 relayer 软件部署 | [`0x12319951…488D`](https://sepolia.etherscan.io/address/0x12319951c1E1A8de07aa7363BECA8d20Bb54488D) |
| Relayer 签名 key，发出 worker 的初始化交易 | [`0x168EB79a…F91E`](https://sepolia.etherscan.io/address/0x168EB79a6707CC95935B7773d07a899954A6F91E) |
| Master：sandbox 注册身份、测试 TORN stake、手续费收款地址 | [`0x4DC4F08E…c68B`](https://sepolia.etherscan.io/address/0x4DC4F08E87935135FDa56D11E1e303117B26c68B) |
| Sandbox `TornadoRouter`／`RelayerRegistry` | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D)／[`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) |
| ETH 0.1 池 | [`0x8C4A04d8…F50b`](https://sepolia.etherscan.io/address/0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b) |
| 尾调用使用的 swap／Aave 辅助合约 | [`0x2B247C8e…Ca33`](https://sepolia.etherscan.io/address/0x2B247C8ee4556B35d510C0BdBD75194c11C4Ca33) |

| 区块 | 交易 | 步骤 |
| ---: | --- | --- |
| 11716691 | [`0x29991c6b…5010`](https://sepolia.etherscan.io/tx/0x29991c6b803537ac6440c6534ce76734507a4eeef1c7a3d3ead8af11815b5010) | relayer 软件部署 worker paymaster（`AUTO_SETUP`）。 |
| 11716693 | [`0xa47543d7…a696`](https://sepolia.etherscan.io/tx/0xa47543d7f76cd36bca4a98d1ca23b96e3b9381adb1970a19c008651a3b7aa696) | worker 在 EntryPoint 质押 0.02 ETH。 |
| 11716695 | [`0x3646cfeb…eca8`](https://sepolia.etherscan.io/tx/0x3646cfeb35a5e4d1ae144e9efa3f45c43142fbd017563b0f89f44d85167deca8) | worker 的 EntryPoint deposit 入金 0.04 ETH。 |
| 11716711 | [`0x5c123f80…77e3`](https://sepolia.etherscan.io/tx/0x5c123f803ae324b78a467ee3993f24da60f0b74121c7e85da8161e5d6cf177e3) | master 调用 `registerWorker(master, worker)`。 |
| 11722902 | [`0xae57c597…224f`](https://sepolia.etherscan.io/tx/0xae57c597974715318b134990ce00e8a8f191f25f2cca80c0f939c2529a8c224f) | 测试钱包通过 Kohaku SDK shield 0.1 ETH。 |
| 11722909 | [`0x165edf28…446d`](https://sepolia.etherscan.io/tx/0x165edf282b9cec79e2f6e70354c53c857ddb38a753abb638204552ea8778446d) | **赞助提现**（UserOperation `0x8f7982d6…a0cf`）。 |
| 11722912 | [`0x52e5bbe4…c8c0`](https://sepolia.etherscan.io/tx/0x52e5bbe4acd185055e0e7fdadeeb9662e482b27016f4413ab3a2bec91cb5c8c0) | relayer key 把 deposit 补回 0.04 ETH 的启动目标（+0.000842 ETH，即这笔提现的 gas），由上文所述的重启发出。 |

提现交易的日志（按顺序）：

| 发出方 | 事件 | 说明 |
| --- | --- | --- |
| `RelayerRegistry` | `StakeBurned(master, 0.1137 TORN)` | 从 master stake 扣除测试 TORN。 |
| ETH 0.1 池 | `Withdrawal(to = sender, relayer = master, fee = 0.002142 ETH)` | 证明中绑定的手续费支付给 master。 |
| Worker paymaster | `Relayed(pool, nullifierHash, master, fee, viaRouter = true)` | 被授权的 `relayWithdraw` 经过 `TornadoRouter`。 |
| WETH、Aave pool、aWETH、辅助合约 | `Deposit`、`Supply`、`Mint`、`Supplied`：为收款地址存入 0.097858 | 尾调用：先 wrap，再存入 Aave。 |
| Worker paymaster | `Sponsored(userOpHash, refundTo = 0, fee = 0.002142 ETH, refund = 0)` | 在 `postOp` 中结算，worker 模式不退款。 |
| EntryPoint | `UserOperationEvent(paymaster = worker, success = true, actualGasCost = 0.000842 ETH)` | operation 执行成功，gas 从 worker deposit 支付。 |

## 目录

| 路径 | 内容 |
| --- | --- |
| [`relayer/`](relayer/) | 签名服务、初始化、定价、JSON-RPC、赞助存储。 |
| [`contracts/`](contracts/) | Paymaster、可选 swap／Aave 辅助合约、sandbox 与 Foundry 测试。 |
| [`client/`](client/) | 钱包／prover 参考流程与 mainnet-fork 集成测试。 |
| [`kohaku-integration/`](kohaku-integration/) | 固定版本 SDK／CLI 补丁与实网示例。 |
