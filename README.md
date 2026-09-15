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

The relayer's existing **worker address becomes the paymaster**. The worker key `tornado-relayer` already
runs with is already registered as a worker of the relayer's master in `RelayerRegistry`; on first start the
new software has that address delegate itself (EIP-7702) to a shared paymaster implementation, stake and fund
it on the EntryPoint. Nothing changes in the registry.

In this mode:

- the proof still names the existing relayer (its master address);
- the withdrawal fee still goes to the existing relayer;
- withdrawals still go through `TornadoRouter`;
- `RelayerRegistry` still charges TORN from the existing relayer's stake;
- the worker only signs sponsorships and pays gas from its EntryPoint deposit.

So the existing relayer remains part of the atomic withdrawal path instead of being bypassed, and switching
means replacing the relayer software — same worker key, same `REWARD_ACCOUNT`, same fee setting.

A standalone paymaster contract can also be registered as a new relayer master (it then refunds users the
unused part of the fee), but the delegated worker is the path for an existing operator.

### Running it as an existing relayer

```bash
cd relayer && cp .env.example .env
# PRIVATE_KEY      your worker key (as in tornado-relayer)         REWARD_ACCOUNT  your master address
# RELAYER_FEE      0.3 (percent, as in tornado-relayer)             HTTP_RPC_URL / NET_ID as before
# PAYMASTER_IMPLEMENTATION  the chain's TornadoRelayerPaymaster7702 (Sepolia: 0x9917840A8843aCE7F525BC24D518Ad059D86Eb31)
# PAYMASTER_DEPOSIT_WEI     gas float to keep on the EntryPoint (the worker needs ETH for it, as it needs ETH for gas today)
pnpm start
```

On first start the service sends three transactions from the worker key — the EIP-7702 delegation, a 0.1 ETH
EntryPoint stake, the deposit — checks that the registry resolves the worker to `REWARD_ACCOUNT`, and then
only signs. `GET /status` shows the mode, the master, the stake left and the TORN burned per pool. Wallets
use the worker address as the paymaster and the service URL as the ERC-7677 endpoint.

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
paymaster  (= the relayer's worker EOA, delegated via EIP-7702)
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
- the existing worker EOA acting as the paymaster through EIP-7702, set up by the relayer software itself.

Two findings of a first self-audit are fixed in the current code: a note owner could previously route
fee-less withdrawals through the paymaster and burn the relayer's stake for free (now every relay needs a
one-shot sponsorship the paymaster grants only inside an operation the relayer signed), and the paymaster
reads its own storage during validation, which ERC-7562 only allows for staked paymasters (the setup stakes
0.1 ETH). Still experimental and unaudited; production use needs further hardening.

## Running the tests

Needs pnpm, Foundry and the Tornado proving artifacts from `tornado-cli` (`TORNADO_ARTIFACTS_DIR`).

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster (both variants) + sandbox DAO, 31 tests
pnpm --filter @tornado-4337/relayer test                         # relayer, 10 tests
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # mainnet fork; ~2 min per suite with a local node
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # same suites on a Sepolia fork (sandbox DAO)
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # real Kohaku SDK, Sepolia fork
```

The mainnet fork (anvil + alto bundler + the relayer in-process) runs against the real contracts: ETH pool →
swap → Aave; DAI pool → Aave with the fee priced by the 1inch oracle; and the DAO path through the real
`TornadoRouter` / `RelayerRegistry` / FeeManager — the paymaster as a fresh master (~0.116 TORN burned per
withdrawal, refund still paid), as a standalone worker of a really registered relayer, and as that relayer's
worker EOA delegated through EIP-7702 by the relayer software's own setup step (fee to the master, its stake
burned, the worker's own ETH untouched).

## What we did on Sepolia

The DAO's own Sepolia registry has no router, no enabled pools and a zero fee, so we deployed a sandbox copy of
the relayer stack (`contracts/src/dao-sandbox`: same ABIs, governance = us, test TORN minted by us, TORN price
set by governance) and enabled the ETH 0.1 / ETH 1 / DAI 100 pools at 0.30 %. Router
[`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D), registry
[`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e); the rest is
in `client/src/chains.ts`.

Then we played an existing relayer: an EOA registered as master `existing-relayer.sandbox.eth` with 5000 TORN
and one worker key, exactly like a `tornado-relayer` deployment. The new relayer software was started with
that worker key and `REWARD_ACCOUNT` = the master; on boot it delegated the worker
[`0x168EB79a…F91E`](https://sepolia.etherscan.io/address/0x168EB79a6707CC95935B7773d07a899954A6F91E) to the
shared implementation
[`0x9917840A…Eb31`](https://sepolia.etherscan.io/address/0x9917840A8843aCE7F525BC24D518Ad059D86Eb31), staked and
funded it. From a Kohaku CLI wallet: `kohaku shield` 0.1 ETH, then one `kohaku unshield` with an Aave tail call.
That withdrawal is a single transaction:

[`0x0411a50f…e7df`](https://sepolia.etherscan.io/tx/0x0411a50f9b54e642382c28c1b13df74ca763583f33dc566af1687e80e181e7df)
— EntryPoint → worker EOA (paymaster) `relayWithdraw` → `TornadoRouter` → `RelayerRegistry.burn`
(0.1137 TORN from the master's stake, 5000 → 4999.8863) → pool → wrap → Aave. Fee bound in the proof
0.002253 ETH, paid to the master; actual gas 0.000772 ETH, paid from the worker's EntryPoint deposit;
0.097747 aWETH landed in the wallet.

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

relayer 现有的 **worker 地址直接成为 paymaster**。`tornado-relayer` 现在用的 worker key，本来就已经在 `RelayerRegistry` 里登记为该 relayer master 的 worker；新软件首次启动时让这个地址通过 EIP-7702 委托到一份共享的 paymaster 实现，并在 EntryPoint 上质押、入金。registry 里什么都不用改。

在这个模式下：

- proof 里仍然写现有 relayer（它的 master 地址）；
- withdrawal fee 仍然付给现有 relayer；
- 提现仍然经过 `TornadoRouter`；
- `RelayerRegistry` 仍然从现有 relayer 的 stake 里扣 TORN；
- worker 只负责签 sponsorship，gas 从它的 EntryPoint 押金里出。

也就是说，现有 relayer 仍然处在新的 atomic withdrawal 路径中，而不是被绕开；切换只是换掉 relayer 软件——worker key、`REWARD_ACCOUNT`、手续费设置都照旧。

也可以把一个独立部署的 paymaster 合约注册成新的 relayer master（这种模式会把 fee 里没用掉的部分退给用户），但对现有运营者，委托 worker 才是接入路径。

### 作为现有 relayer 怎么跑

```bash
cd relayer && cp .env.example .env
# PRIVATE_KEY      你的 worker key（和 tornado-relayer 一样）        REWARD_ACCOUNT  你的 master 地址
# RELAYER_FEE      0.3（百分比，和 tornado-relayer 一样）            HTTP_RPC_URL / NET_ID 照旧
# PAYMASTER_IMPLEMENTATION  该链的 TornadoRelayerPaymaster7702（Sepolia：0x9917840A8843aCE7F525BC24D518Ad059D86Eb31）
# PAYMASTER_DEPOSIT_WEI     要在 EntryPoint 保持的 gas 浮存（worker 需要 ETH，就像它今天也需要 ETH 付 gas）
pnpm start
```

首次启动时服务用 worker key 发三笔交易——EIP-7702 委托、0.1 ETH 的 EntryPoint 质押、入金——再核对 registry 把 worker 解析到的 master 就是 `REWARD_ACCOUNT`，然后就只做签名。`GET /status` 显示模式、master、剩余质押和各池每笔要烧的 TORN。钱包把 worker 地址当 paymaster、把服务 URL 当 ERC-7677 端点即可。

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
paymaster（= relayer 的 worker EOA，经 EIP-7702 委托）
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
- 现有 worker EOA 通过 EIP-7702 直接充当 paymaster，由 relayer 软件自己完成设置。

第一轮自查发现的两个问题已在当前代码里修掉：此前 note 持有人可以把零手续费的提现从 paymaster 转发出去、白白烧掉 relayer 的质押（现在每次转发都需要 paymaster 在 relayer 签过的操作内部发放的一次性额度）；以及 paymaster 在验证阶段读自身存储，ERC-7562 只允许已质押的 paymaster 这样做（设置步骤会质押 0.1 ETH）。仍然是实验性实现，未经审计，生产环境还需要进一步加固。

## 怎么跑测试

需要 pnpm、Foundry 和 `tornado-cli` 里的证明文件（`TORNADO_ARTIFACTS_DIR`）。

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster 两个版本 + 沙盒 DAO，31 个
pnpm --filter @tornado-4337/relayer test                         # relayer，10 个
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 主网 fork；用本地节点每套约 2 分钟
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # 同一套跑 Sepolia fork（沙盒 DAO）
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # 真实 Kohaku SDK，Sepolia fork
```

主网 fork（anvil + alto bundler + 进程内 relayer）对着真实合约跑：ETH 池 → swap → Aave；DAI 池 → Aave，fee 用 1inch 预言机定价；以及走真实 `TornadoRouter` / `RelayerRegistry` / FeeManager 的 DAO 路径——paymaster 作为新注册的 master（每笔烧约 0.116 TORN，退款照常）、作为一个真实已注册 relayer 的独立 worker 合约、以及作为该 relayer 经 EIP-7702 委托的 worker EOA（由 relayer 软件自己的设置步骤完成委托；fee 到 master、烧它的质押、worker 自己的 ETH 不动）。

## 我们在 Sepolia 做了什么

DAO 自己的 Sepolia registry 没有 router、没有启用的池子、费用为 0，所以我们部署了一套 relayer 栈的沙盒副本（`contracts/src/dao-sandbox`：ABI 一致，governance 是我们，TORN 是我们 mint 的测试币，价格由 governance 设定），按 0.30 % 启用了 ETH 0.1 / ETH 1 / DAI 100 三个池。router [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D)，registry [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e)，其余地址见 `client/src/chains.ts`。

然后我们扮演一个现有 relayer：一个 EOA 注册为 master `existing-relayer.sandbox.eth`，质押 5000 TORN，带一个 worker key——和一套 `tornado-relayer` 部署完全一样。新 relayer 软件用这个 worker key 启动，`REWARD_ACCOUNT` 填 master；启动时它把 worker [`0x168EB79a…F91E`](https://sepolia.etherscan.io/address/0x168EB79a6707CC95935B7773d07a899954A6F91E) 委托到共享实现 [`0x9917840A…Eb31`](https://sepolia.etherscan.io/address/0x9917840A8843aCE7F525BC24D518Ad059D86Eb31)，并质押、入金。再用 Kohaku CLI 钱包 `kohaku shield` 0.1 ETH，`kohaku unshield` 一次并带上存 Aave 的尾调用。这笔提现是一笔交易：

[`0x0411a50f…e7df`](https://sepolia.etherscan.io/tx/0x0411a50f9b54e642382c28c1b13df74ca763583f33dc566af1687e80e181e7df)
——EntryPoint → worker EOA（即 paymaster）`relayWithdraw` → `TornadoRouter` → `RelayerRegistry.burn`（从 master 的质押里烧 0.1137 TORN，5000 → 4999.8863）→ 池子 → wrap → 存 Aave。证明里绑定的 fee 0.002253 ETH 付给 master；实际 gas 0.000772 ETH 从 worker 的 EntryPoint 押金里出；钱包到账 0.097747 aWETH。

## 目录

| 路径 | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymasterCore.sol`（逻辑）、`TornadoRelayerPaymaster7702.sol`（worker EOA 的委托目标）、`TornadoRelayerPaymaster.sol`（独立部署版）、`SwapAndSupplyZap.sol`、`dao-sandbox/`（测试网用的 DAO relayer 栈副本） |
| `relayer/` | 签名服务（`setup.ts` = 首次启动的委托 / 质押 / 入金） |
| `client/` | 参考钱包流程、证明生成、e2e 测试台（anvil fork + alto） |
| `kohaku-integration/` | `@kohaku-eth/tornado-cash` 与 `kohaku-cli` 的补丁、Kohaku e2e |
