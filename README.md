# tornado-4337-relayer

**A thin Tornado Cash relayer for Kohaku / ERC-4337 atomic withdrawals.**

English | [简体中文](#简体中文)

> Working PoC on Sepolia. Experimental and unaudited.

The goal is simple: let existing Tornado relayers participate in Kohaku's atomic withdrawal flow **without becoming bundlers and without leaving the existing Tornado relayer economy**.

## For Tornado relayers

The new relayer is intentionally very close to the classic Tornado relayer.

Classic relayer:

```text
receive withdrawal
→ check proof / root / nullifier / fee
→ sign and send transaction
```

This relayer:

```text
receive UserOperation
→ check proof / root / nullifier / fee
→ sign sponsorship
```

The main difference is simply **what gets signed**.

The relayer no longer has to submit the transaction itself. The user's wallet sends the sponsored UserOperation to an ERC-4337 bundler.

So the relayer still does a small, Tornado-specific job:

- quote the fee;
- validate the withdrawal;
- decide whether to sponsor it;
- sign;
- keep its existing fee policy, pricing logic and privacy setup.

No bundler needs to be operated by the relayer.

## Keep the existing relayer economy

The paymaster is a small contract registered as a **worker of the existing relayer** — the same registry
action as adding a worker key today. The relayer software deploys that contract from the relayer's own key on
first start, stakes and funds it on the EntryPoint, and then waits for the master to register it.

In this mode:

- the proof still names the existing relayer (its master address);
- the withdrawal fee still goes to the existing relayer;
- withdrawals still go through `TornadoRouter`, one note per operation;
- `RelayerRegistry` still charges TORN from the existing relayer's stake, once per relayed withdrawal;
- the paymaster only signs sponsorships and pays gas from its EntryPoint deposit.

So the existing relayer remains part of the atomic withdrawal path instead of being bypassed, and switching
means replacing the relayer software — same worker key, same `REWARD_ACCOUNT`, same fee setting.

Two variants exist but are not the recommended path: a standalone contract registered as a new relayer
*master* (it then refunds users the unused part of the fee), and an experimental EIP-7702 mode in which the
worker EOA itself delegates to a shared implementation (accepted by Pimlico's public bundler, not guaranteed
under strict ERC-7562 mempool rules).

### Running it as an existing relayer

```bash
cd relayer && cp .env.example .env
# PRIVATE_KEY      a relayer key (your worker key works)             REWARD_ACCOUNT  your master address
# RELAYER_FEE      0.3 (percent, as in tornado-relayer)              HTTP_RPC_URL / NET_ID as before
# PAYMASTER_DEPOSIT_WEI   gas float to keep on the EntryPoint (the key needs ETH for it, as workers need ETH for gas today)
pnpm start
```

On first start the service deploys the worker paymaster contract from that key, stakes 0.1 ETH and funds the
deposit, prints the address, and waits. You register it from your master key exactly as you would a new
worker: `RelayerRegistry.registerWorker(master, paymaster)`. From then on the service only signs.
`GET /status` shows the mode, the master, the stake left and the TORN burned per pool. Wallets use the
paymaster address and the service URL as the ERC-7677 endpoint.

## For Kohaku

Kohaku only needs a relayer-signed sponsorship path:

```text
Kohaku / wallet
    ↓
ask Tornado relayer for quote
    ↓
build proof + UserOperation
    ↓
ask relayer to sign sponsorship
    ↓
send UserOperation to bundler
```

This allows atomic flows such as:

```text
Tornado withdraw
→ swap
→ Aave
```

inside one UserOperation.

The existing Tornado pools and proving circuit stay unchanged.

## Architecture

```text
Kohaku / wallet
      ↓
thin Tornado relayer
      ↓
sign sponsorship
      ↓
paymaster  (a contract registered as the relayer's worker)
      ↓
ERC-4337 bundler
      ↓
EntryPoint
      ↓
TornadoRouter
      ↓
Tornado pool
      ↓
atomic tail calls
```

The Tornado-specific part stays in the relayer. The bundler remains generic infrastructure.

## Current status

The PoC currently demonstrates:

- Kohaku SDK / CLI integration;
- live Sepolia atomic withdrawal;
- relayer-signed paymaster sponsorship;
- atomic `withdraw → wrap/swap → Aave`;
- `TornadoRouter → RelayerRegistry` integration;
- TORN stake charging in the Sepolia DAO sandbox;
- mainnet-fork tests against the real Tornado DAO router / registry;
- worker mode where an existing relayer receives the fee and its stake is charged;
- a mainnet acceptance run on a fork: canonical ETH 100 pool, the DAO's live router / registry / FeeManager
  untouched, a really registered relayer as master, the worker contract deployed by the relayer software,
  116 TORN burned from the master's stake per withdrawal;
- strict ERC-7562 mempool rules: the reference bundler's own tracer and rule engine accept the validation
  phase (and reject it when the paymaster is unstaked).

Review findings addressed in the current code:

- **Sponsorship bound to the exact withdrawal.** The relayer signs the hash of the one `relayWithdraw` it
  approved; validation records it in transient storage and `relayWithdraw` only runs with those arguments. A
  sender account with unusual execution semantics, a note owner, or a third party cannot make the paymaster
  relay (and burn stake for) anything else.
- **One note per operation.** Extra Tornado withdrawals in the same operation are refused, so every relayed
  note goes through the router and burns TORN exactly as with a classic relayer; Kohaku's patch issues one
  operation per note.
- **The sponsorship binds the account implementation that executes it.** The relayer signs the EIP-7702
  implementation the sender will run (the operation's own authorization, else its current delegation), and the
  paymaster re-checks the sender's delegation designator on-chain during validation. Swapping the authorization
  to another implementation after the signature is refused (`SenderImplementationMismatch`), so the approved
  withdrawal cannot be executed by code the relayer never saw. Tested adversarially on the mainnet fork: after
  the sponsorship is signed, re-delegating the sender to another byte-identical account implementation makes
  validation reject the operation, so nothing is burned and the note stays unspent.
- **EntryPoint nonce and EOA nonce are separate.** The SDK reads `EntryPoint.getNonce` for the operation and
  the sender's transaction count for the EIP-7702 authorization, and attaches no authorization at all when the
  sender already delegates to Simple7702Account — the two counters diverge as soon as either happens.
- **ERC-7562.** The paymaster reads its own storage during validation, so it is staked (0.1 ETH by the setup;
  raise `PAYMASTER_STAKE_WEI` to whatever entity minimum the bundler you use enforces, typically 1 ETH).
- **Hardening.** Live sponsorships can be persisted (`SPONSORSHIP_STORE`), sponsorship can be limited to
  known account implementations (`ALLOWED_SENDER_IMPLEMENTATIONS`), every on-chain setup action is logged and
  can be disabled (`AUTO_SETUP=false`). A multi-instance relayer still needs a shared sponsorship store.

Still experimental and unaudited; production use needs an audit.

## Running the tests

Needs pnpm, Foundry and the Tornado proving artifacts from `tornado-cli` (`TORNADO_ARTIFACTS_DIR`).

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster (both variants) + sandbox DAO, 33 tests
pnpm --filter @tornado-4337/relayer test                         # relayer, 14 tests

# mainnet acceptance: a Foundry fork test against the live DAO contracts (~1 min, pinned block)
(cd contracts && MAINNET_RPC_URL=… TORNADO_ARTIFACTS_DIR=…/tornado-cli/circuits forge test --match-contract MainnetAcceptance -vv)

# strict ERC-7562 (bundler mempool rules) with the reference bundler's tracer + rule engine, no deployment needed
MAINNET_RPC_URL=… AA_BUNDLER_DIR=…/eth-infinitism-bundler pnpm --filter @tornado-4337/client exec tsx scripts/erc7562-check.ts


# the off-chain stack end to end (relayer service, alto bundler, Kohaku SDK) on forks
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # ~1–2 min per suite from the committed fork cache
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # real Kohaku SDK, Sepolia fork
```

The Foundry acceptance test (`contracts/test/fork/MainnetAcceptance.t.sol`) is the main line: the canonical
ETH 100 pool with its real deposit tree (proof via ffi from the client prover, leaves from the committed
fixture), the DAO's live `TornadoRouter` / `RelayerRegistry` / FeeManager and the real EntryPoint v0.8 and
Simple7702Account at their mainnet addresses, a really registered relayer master (solid-relayer.eth), the
worker contract deployed from the relayer key as the software does — nothing governance-owned touched, the
only `vm.prank` is the master registering its worker. It also asserts, with the state-diff recorder, that
validation touches no storage but the paymaster's own.

`scripts/erc7562-check.ts` runs the eth-infinitism reference bundler's `bundlerCollectorTracer` and
`tracerResultParser` — its actual mempool rule engine — over a `debug_traceCall` of `handleOps` on a live
archive node, with the worker contract, its storage, its EntryPoint stake and the sender's EIP-7702
authorization supplied as state overrides. `--unstaked` is the negative control and has to be rejected for the
expected reason (an unstaked paymaster touching its own storage, STO-031). The bundler checkout is pinned to
one commit (`client/src/aa-bundler.ts`), so "passes the reference rules" always means one known rule set.

Forks are pinned to a fixed block (block 25 981 000 for mainnet; `E2E_FORK_BLOCK=latest` to override) and
the RPC cache for that block ships in `client/e2e/fork-cache/` (shared by Foundry and anvil), so a fresh clone
runs everything without an archive node. After moving the pin, warm the caches once and
`pnpm --filter @tornado-4337/client fork-cache:save`.

The vitest suites (anvil + alto bundler + the relayer in-process) cover what Foundry cannot: the relayer
service's validation, simulation and signing, bundler acceptance, and the Kohaku SDK — ETH pool → swap → Aave;
DAI pool → Aave with the fee priced by the 1inch oracle; the paymaster as a fresh master, as the worker contract
the software deploys, and as the experimental 7702 variant.

## What we did on Sepolia

The DAO's own Sepolia registry has no router, no enabled pools and a zero fee, so we deployed a sandbox copy of
the relayer stack (`contracts/src/dao-sandbox`: same ABIs, governance = us, test TORN minted by us, TORN price
set by governance) and enabled the ETH 0.1 / ETH 1 / DAI 100 pools at 0.30 %. Router
[`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D), registry
[`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e); the rest is
in `client/src/chains.ts`.

Then we played an existing relayer: an EOA registered as master `existing-relayer.sandbox.eth` with 5000 TORN,
exactly like a `tornado-relayer` deployment, and ran the new relayer software with a relayer key and
`REWARD_ACCOUNT` = the master. On boot the software deployed its worker contract
[`0x12319951…488D`](https://sepolia.etherscan.io/address/0x12319951c1E1A8de07aa7363BECA8d20Bb54488D), staked
and funded it, and waited; the master registered it with one
[`registerWorker`](https://sepolia.etherscan.io/tx/0x5c123f803ae324b78a467ee3993f24da60f0b74121c7e85da8161e5d6cf177e3)
and the service came up. Then, through the Kohaku SDK: shield 0.1 ETH, then one unshield with an Aave tail
call. That withdrawal is a single transaction:

[`0x5b488530…06f9`](https://sepolia.etherscan.io/tx/0x5b4885302db74fe3b9e01615a4bc56169a03dfb1a39e8271340f1b644e6206f9)
— EntryPoint → worker contract `relayWithdraw` (only with the arguments the relayer signed, and only because
the sender ran the implementation the relayer signed for) → `TornadoRouter` → `RelayerRegistry.burn`
(0.1137 TORN from the master's stake) → pool → wrap → Aave. Fee bound in the proof 0.002348 ETH, paid to the
master; actual gas 0.000867 ETH, paid from the worker's EntryPoint deposit, so the master keeps 0.001481 ETH;
0.097652 aWETH (exactly denomination − fee) landed on the recipient. Earlier runs on the previous worker
contract, before the sponsorship terms gained the bound implementation, are
[`0x30fca6f5…d059`](https://sepolia.etherscan.io/tx/0x30fca6f5e1a6b8a05ea0b1b3099e05c3add5055238e8d425b09d43f5a47ed059)
(the same flow from the Kohaku CLI), a plain unshield without tail calls
[`0xd4e04a7e…26c6`](https://sepolia.etherscan.io/tx/0xd4e04a7e88f5e3bf96bebabf4a24c431c474d1f8a1f6218b55a5e936743026c6)
and the experimental 7702 variant
[`0x0411a50f…e7df`](https://sepolia.etherscan.io/tx/0x0411a50f9b54e642382c28c1b13df74ca763583f33dc566af1687e80e181e7df).

## Repository

| Path | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymasterCore.sol` (logic), `TornadoRelayerPaymaster7702.sol` (delegate for worker EOAs), `TornadoRelayerPaymaster.sol` (standalone), `SwapAndSupplyZap.sol`, `dao-sandbox/` (testnet copy of the DAO relayer stack) |
| `relayer/` | the signing service (`setup.ts` = first-start delegation / stake / deposit) |
| `client/` | reference wallet flow, proof generation, e2e harness (anvil fork + alto) |
| `kohaku-integration/` | patches for `@kohaku-eth/tornado-cash` and `kohaku-cli`, Kohaku e2e |

---

# 简体中文

**一个面向 Kohaku / ERC-4337 原子提现的轻量 Tornado Cash relayer。**

> 已在 Sepolia 跑通 PoC。实验性质，未经审计。

目标很简单：让现有 Tornado relayer 继续参与 Kohaku 的原子提现流程，**不需要自己变成 bundler，也不脱离现有 Tornado relayer 的经济体系。**

## 对现有 Tornado relayer 来说

新的 relayer 和传统 relayer 的工作其实非常接近。

传统 relayer：

```text
收到提现请求
→ 检查 proof / root / nullifier / fee
→ 签名并发送交易
```

新的 relayer：

```text
收到 UserOperation
→ 检查 proof / root / nullifier / fee
→ 签 sponsorship
```

本质上的区别只是：**签的东西变了。**

relayer 不再需要自己发交易。用户的钱包拿到 sponsorship 后，把 UserOperation 发给 ERC-4337 bundler。

所以 relayer 仍然只做很小的一部分 Tornado-specific 工作：

- 报价；
- 检查提现；
- 决定是否 sponsor；
- 签名；
- 保留原来的 fee、价格逻辑和 privacy setup。

relayer 自己不需要运行 bundler。

## 保留现有 relayer 经济模型

paymaster 是一个小合约，注册成**现有 relayer 的 worker**——和今天往 registry 里加一个 worker key 是同一个动作。relayer 软件首次启动时用 relayer 自己的 key 部署这个合约、在 EntryPoint 上质押和入金，然后等 master 把它登记为 worker。

在这个模式下：

- proof 里仍然写现有 relayer（它的 master 地址）；
- withdrawal fee 仍然付给现有 relayer；
- 提现仍然经过 `TornadoRouter`，每个 UserOperation 一张 note；
- `RelayerRegistry` 仍然从现有 relayer 的 stake 里扣 TORN，每转发一笔扣一次；
- paymaster 只负责签 sponsorship，gas 从它的 EntryPoint 押金里出。

也就是说，现有 relayer 仍然处在新的 atomic withdrawal 路径中，而不是被绕开；切换只是换掉 relayer 软件——worker key、`REWARD_ACCOUNT`、手续费设置都照旧。

另外两种变体存在但不推荐：独立合约注册成新的 relayer *master*（会把 fee 里没用掉的部分退给用户）；以及实验性的 EIP-7702 模式，让 worker EOA 自己委托到共享实现（Pimlico 公共 bundler 接受，严格 ERC-7562 mempool 规则下不保证）。

### 作为现有 relayer 怎么跑

```bash
cd relayer && cp .env.example .env
# PRIVATE_KEY      一个 relayer key（现有的 worker key 就行）           REWARD_ACCOUNT  你的 master 地址
# RELAYER_FEE      0.3（百分比，和 tornado-relayer 一样）              HTTP_RPC_URL / NET_ID 照旧
# PAYMASTER_DEPOSIT_WEI   要在 EntryPoint 保持的 gas 浮存（这个 key 需要 ETH，就像 worker 今天也需要 ETH 付 gas）
pnpm start
```

首次启动时服务用这个 key 部署 worker paymaster 合约、质押 0.1 ETH、入金，打印地址后等待。你用 master key 把它登记为 worker，和加新 worker 一模一样：`RelayerRegistry.registerWorker(master, paymaster)`。之后服务只做签名。`GET /status` 显示模式、master、剩余质押和各池每笔要烧的 TORN。钱包把 paymaster 地址和服务 URL 当 ERC-7677 端点即可。

## 对 Kohaku 来说

Kohaku 只需要增加一条由 relayer 签名的 sponsorship 路径：

```text
Kohaku / wallet
    ↓
向 Tornado relayer 请求报价
    ↓
生成 proof + UserOperation
    ↓
请求 relayer 签 sponsorship
    ↓
把 UserOperation 发给 bundler
```

这样就可以在一个 UserOperation 里完成：

```text
Tornado withdraw
→ swap
→ Aave
```

现有 Tornado pool 和 proving circuit 都不需要修改。

## 架构

```text
Kohaku / wallet
      ↓
thin Tornado relayer
      ↓
签 sponsorship
      ↓
paymaster（注册为 relayer worker 的合约）
      ↓
ERC-4337 bundler
      ↓
EntryPoint
      ↓
TornadoRouter
      ↓
Tornado pool
      ↓
atomic tail calls
```

Tornado-specific 的逻辑继续留在 relayer；bundler 只是通用基础设施。

## 当前状态

目前 PoC 已经完成：

- Kohaku SDK / CLI 集成；
- Sepolia 实网 atomic withdrawal；
- relayer-signed paymaster sponsorship；
- 原子 `withdraw → wrap/swap → Aave`；
- `TornadoRouter → RelayerRegistry` 集成；
- Sepolia DAO sandbox 中的 TORN stake 扣费；
- 基于真实 Tornado DAO router / registry 的 mainnet-fork 测试；
- worker mode：现有 relayer 收 fee，同时从它的 stake 中扣 TORN；
- 主网 fork 上的验收跑：主网真实的 ETH 100 池、DAO 现有的 router / registry / FeeManager 一个字不动、一个真实已注册的 relayer 当 master、relayer 软件自己部署的 worker 合约，每笔从 master 质押里烧 116 TORN；
- 严格 ERC-7562 mempool 规则：参考 bundler 自己的 tracer 和规则引擎接受验证阶段（paymaster 未质押时则拒绝）。

评审提出的问题已在当前代码里处理：

- **sponsorship 绑定到具体那笔提现。** relayer 签的是它批准的那一次 `relayWithdraw` 的哈希；验证阶段记进 transient storage，`relayWithdraw` 只对完全相同的参数放行。执行语义奇怪的 sender 账户、note 持有人、第三方都不能让 paymaster 转发（并烧质押）别的东西。
- **每个 operation 一张 note。** 同一操作里多余的 Tornado 提现会被拒绝，所以每一笔被转发的 note 都经过 router、按经典 relayer 的方式烧一次 TORN；Kohaku 补丁改为每张 note 一个 operation。
- **sponsorship 绑定执行它的账户实现。** relayer 把 sender 将要运行的 EIP-7702 implementation（operation 自带的 authorization，没有就用当前 delegation）一起签进条款，paymaster 在验证阶段再链上核对 sender 的 delegation designator。签完之后把 authorization 换成别的 implementation 会被拒（`SenderImplementationMismatch`），已批准的提现不可能由 relayer 没见过的代码执行。主网 fork 上有对抗测试：签完 sponsorship 之后把 sender 重新委托到另一份字节码完全相同的账户实现，验证阶段会拒绝这笔 operation，于是不烧质押、note 也没被花掉。
- **EntryPoint nonce 与 EOA nonce 分开。** SDK 用 `EntryPoint.getNonce` 取 operation 的 nonce，用 sender 的交易计数取 EIP-7702 authorization 的 nonce；sender 已经委托到 Simple7702Account 时干脆不带 authorization——这两种情况下两个计数就会错开。
- **ERC-7562。** paymaster 在验证阶段读自身存储，所以要质押（设置步骤质押 0.1 ETH；实际用哪个 bundler 就把 `PAYMASTER_STAKE_WEI` 提到它要求的实体门槛，一般是 1 ETH）。
- **加固。** 进行中的 sponsorship 可持久化（`SPONSORSHIP_STORE`），可限制只赞助已知的账户实现（`ALLOWED_SENDER_IMPLEMENTATIONS`），所有链上设置动作都有日志且可关闭（`AUTO_SETUP=false`）。多实例 relayer 仍需共享的 sponsorship 存储。

仍然是实验性实现，未经审计；上生产前需要审计。

## 怎么跑测试

需要 pnpm、Foundry 和 `tornado-cli` 里的证明文件（`TORNADO_ARTIFACTS_DIR`）。

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster 两个版本 + 沙盒 DAO，33 个
pnpm --filter @tornado-4337/relayer test                         # relayer，14 个

# 主网验收：Foundry fork 测试，对着 DAO 现有合约（固定高度，约 1 分钟）
(cd contracts && MAINNET_RPC_URL=… TORNADO_ARTIFACTS_DIR=…/tornado-cli/circuits forge test --match-contract MainnetAcceptance -vv)

# 严格 ERC-7562（bundler mempool 规则）：参考 bundler 的 tracer + 规则引擎，不用部署
MAINNET_RPC_URL=… AA_BUNDLER_DIR=…/eth-infinitism-bundler pnpm --filter @tornado-4337/client exec tsx scripts/erc7562-check.ts


# 链下栈端到端（relayer 服务、alto bundler、Kohaku SDK），跑在 fork 上
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 有提交的 fork 缓存，每套约 1–2 分钟
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # 真实 Kohaku SDK，Sepolia fork
```

主线是 Foundry 验收测试（`contracts/test/fork/MainnetAcceptance.t.sol`）：主网真实的 ETH 100 池及其完整存款树（证明由 client 的 prover 经 ffi 生成，叶子来自提交的 fixture）、DAO 现有的 `TornadoRouter` / `RelayerRegistry` / FeeManager、主网地址上的真实 EntryPoint v0.8 和 Simple7702Account、一个真实已注册的 relayer master（solid-relayer.eth）、按软件的方式从 relayer key 部署的 worker 合约——不碰任何 governance 持有的状态，唯一的 `vm.prank` 是 master 登记自己的 worker。它还用 state-diff 记录器断言验证阶段只碰 paymaster 自己的存储。

`scripts/erc7562-check.ts` 把 eth-infinitism 参考 bundler 自己的 `bundlerCollectorTracer` 和 `tracerResultParser`（它真正的 mempool 规则引擎）跑在归档节点的 `debug_traceCall(handleOps)` 上，worker 合约代码、存储、EntryPoint 质押和 sender 的 EIP-7702 授权都通过 state override 提供。`--unstaked` 是反例，而且必须是按预期的那条理由被拒（未质押的 paymaster 读自身存储，STO-031）。参考 bundler 的 checkout 固定在一个 commit（`client/src/aa-bundler.ts`），所以"通过参考规则"永远指同一套规则。

fork 固定在一个区块高度（主网 25 981 000；`E2E_FORK_BLOCK=latest` 可覆盖），该高度的 RPC 缓存随仓库提交在 `client/e2e/fork-cache/`（Foundry 和 anvil 共用），所以新克隆下来不需要归档节点也能全部跑。改了高度后先热跑一遍，再 `pnpm --filter @tornado-4337/client fork-cache:save`。

vitest 套件（anvil + alto bundler + 进程内 relayer）覆盖 Foundry 覆盖不了的部分：relayer 服务的校验、模拟、签名，bundler 是否接受，以及 Kohaku SDK——ETH 池 → swap → Aave；DAI 池 → Aave，fee 用 1inch 预言机定价；paymaster 作为新注册的 master、作为软件自部署的 worker 合约、以及实验性的 7702 变体。

## 我们在 Sepolia 做了什么

DAO 自己的 Sepolia registry 没有 router、没有启用的池子、费用为 0，所以我们部署了一套 relayer 栈的沙盒副本（`contracts/src/dao-sandbox`：ABI 一致，governance 是我们，TORN 是我们 mint 的测试币，价格由 governance 设定），按 0.30 % 启用了 ETH 0.1 / ETH 1 / DAI 100 三个池。router [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D)，registry [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e)，其余地址见 `client/src/chains.ts`。

然后我们扮演一个现有 relayer：一个 EOA 注册为 master `existing-relayer.sandbox.eth`，质押 5000 TORN——和一套 `tornado-relayer` 部署完全一样；用一个 relayer key 启动新软件，`REWARD_ACCOUNT` 填 master。软件启动时自己部署了 worker 合约 [`0x12319951…488D`](https://sepolia.etherscan.io/address/0x12319951c1E1A8de07aa7363BECA8d20Bb54488D)，质押、入金后等待；master 用一笔 [`registerWorker`](https://sepolia.etherscan.io/tx/0x5c123f803ae324b78a467ee3993f24da60f0b74121c7e85da8161e5d6cf177e3) 登记它，服务随即上线。再通过 Kohaku SDK：shield 0.1 ETH，然后一次 unshield 并带上存 Aave 的尾调用。这笔提现是一笔交易：

[`0x5b488530…06f9`](https://sepolia.etherscan.io/tx/0x5b4885302db74fe3b9e01615a4bc56169a03dfb1a39e8271340f1b644e6206f9)
——EntryPoint → worker 合约 `relayWithdraw`（只接受 relayer 签过的那组参数，而且只在 sender 运行的正是 relayer 签名时绑定的那个实现时才放行）→ `TornadoRouter` → `RelayerRegistry.burn`（从 master 质押里烧 0.1137 TORN）→ 池子 → wrap → Aave。证明里绑定的 fee 是 0.002348 ETH，进 master 口袋；实际 gas 0.000867 ETH 从 worker 的 EntryPoint 存款里出，master 净得 0.001481 ETH；收款地址拿到 0.097652 aWETH（正好是面额减 fee）。在 sponsorship 条款加入绑定实现之前、跑在上一个 worker 合约上的几笔分别是 [`0x30fca6f5…d059`](https://sepolia.etherscan.io/tx/0x30fca6f5e1a6b8a05ea0b1b3099e05c3add5055238e8d425b09d43f5a47ed059)（同样的流程，从 Kohaku CLI 发起）、不带尾调用的普通 unshield [`0xd4e04a7e…26c6`](https://sepolia.etherscan.io/tx/0xd4e04a7e88f5e3bf96bebabf4a24c431c474d1f8a1f6218b55a5e936743026c6)，以及实验性的 7702 变体 [`0x0411a50f…e7df`](https://sepolia.etherscan.io/tx/0x0411a50f9b54e642382c28c1b13df74ca763583f33dc566af1687e80e181e7df)。

## 目录

| 路径 | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymasterCore.sol`（逻辑）、`TornadoRelayerPaymaster7702.sol`（worker EOA 的委托目标）、`TornadoRelayerPaymaster.sol`（独立部署版）、`SwapAndSupplyZap.sol`、`dao-sandbox/`（测试网用的 DAO relayer 栈副本） |
| `relayer/` | 签名服务（`setup.ts` = 首次启动的委托 / 质押 / 入金） |
| `client/` | 参考钱包流程、证明生成、e2e 测试台（anvil fork + alto） |
| `kohaku-integration/` | `@kohaku-eth/tornado-cash` 与 `kohaku-cli` 的补丁、Kohaku e2e |
