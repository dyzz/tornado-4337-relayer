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

The paymaster can be registered as a **worker of an existing Tornado relayer**.

In worker mode:

- the proof still names the existing relayer;
- the withdrawal fee still goes to the existing relayer;
- withdrawals still go through `TornadoRouter`;
- `RelayerRegistry` still charges TORN from the existing relayer's stake;
- the paymaster only handles gas sponsorship.

So the existing relayer remains part of the atomic withdrawal path instead of being bypassed.

A paymaster can also register as a new relayer master, but worker mode is the simplest path for an existing operator.

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
paymaster
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
- worker mode where an existing relayer receives the fee and its stake is charged.

This is still experimental and unaudited. Production use needs further hardening.

## Running the tests

Needs pnpm, Foundry and the Tornado proving artifacts from `tornado-cli` (`TORNADO_ARTIFACTS_DIR`).

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster + sandbox DAO, 28 tests
pnpm --filter @tornado-4337/relayer test                         # relayer, 10 tests
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # mainnet fork, ~10 min
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # same suites on a Sepolia fork (sandbox DAO)
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # real Kohaku SDK, Sepolia fork
```

The mainnet fork (anvil + alto bundler + the relayer in-process) runs three suites against the real contracts:
ETH pool → swap → Aave, DAI pool → Aave with the fee priced by the 1inch oracle, and the DAO path through the
real `TornadoRouter` / `RelayerRegistry` / FeeManager — the paymaster as a fresh master (~0.1155 TORN burned
per withdrawal, refund still paid) and as a worker of a really registered relayer (fee to the master, its stake
burned).

## What we did on Sepolia

The DAO's own Sepolia registry has no router, no enabled pools and a zero fee, so we deployed a sandbox copy of
the relayer stack (`contracts/src/dao-sandbox`: same ABIs, governance = us, test TORN minted by us, TORN price
set by governance), enabled the ETH 0.1 / ETH 1 / DAI 100 pools at 0.30 %, and registered the paymaster
[`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) in it as
relayer master `relayer.sandbox.eth` with 5000 TORN. Router
[`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D), registry
[`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e); the rest is
in `client/src/chains.ts`.

Then, from a Kohaku CLI wallet: `kohaku shield` 0.1 ETH, and one `kohaku unshield` with an Aave tail call.
That withdrawal is a single transaction:

[`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b)
— EntryPoint → `paymaster.relayWithdraw` → `TornadoRouter` → `RelayerRegistry.burn` (0.1137 TORN from the
stake, 5000 → 4999.8863) → pool → wrap → Aave. Fee bound in the proof 0.002564 ETH, actual gas 0.000837 ETH,
0.001290 ETH refunded, 0.097436 aWETH landed in the wallet.

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

paymaster 可以注册成 **现有 Tornado relayer 的 worker**。

在 worker mode 下：

- proof 里仍然写现有 relayer；
- withdrawal fee 仍然付给现有 relayer；
- 提现仍然经过 `TornadoRouter`；
- `RelayerRegistry` 仍然从现有 relayer 的 stake 里扣 TORN；
- paymaster 只负责 gas sponsorship。

也就是说，现有 relayer 仍然处在新的 atomic withdrawal 路径中，而不是被绕开。

paymaster 也可以自己注册成新的 relayer master，但对于现有运营者，worker mode 是最简单的接入方式。

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
paymaster
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
- worker mode：现有 relayer 收 fee，同时从它的 stake 中扣 TORN。

目前仍然是实验性实现，未经审计，生产环境还需要进一步加固。

## 怎么跑测试

需要 pnpm、Foundry 和 `tornado-cli` 里的证明文件（`TORNADO_ARTIFACTS_DIR`）。

```bash
pnpm install && (cd contracts && forge install && forge build) && (cd contracts-tornado && forge build)
(cd contracts && forge test)                                     # paymaster + 沙盒 DAO，28 个
pnpm --filter @tornado-4337/relayer test                         # relayer，10 个
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 主网 fork，约 10 分钟
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # 同一套跑 Sepolia fork（沙盒 DAO）
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # 真实 Kohaku SDK，Sepolia fork
```

主网 fork（anvil + alto bundler + 进程内 relayer）对着真实合约跑三套：ETH 池 → swap → Aave；DAI 池 → Aave，fee 用 1inch 预言机定价；以及走真实 `TornadoRouter` / `RelayerRegistry` / FeeManager 的 DAO 路径——paymaster 作为新注册的 master（每笔烧约 0.1155 TORN，退款照常）和作为一个真实已注册 relayer 的 worker（fee 到 master、烧它的质押）。

## 我们在 Sepolia 做了什么

DAO 自己的 Sepolia registry 没有 router、没有启用的池子、费用为 0，所以我们部署了一套 relayer 栈的沙盒副本（`contracts/src/dao-sandbox`：ABI 一致，governance 是我们，TORN 是我们 mint 的测试币，价格由 governance 设定），按 0.30 % 启用了 ETH 0.1 / ETH 1 / DAI 100 三个池，并把 paymaster [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) 注册为 relayer master `relayer.sandbox.eth`，质押 5000 TORN。router [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D)，registry [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e)，其余地址见 `client/src/chains.ts`。

然后用 Kohaku CLI 钱包 `kohaku shield` 0.1 ETH，再 `kohaku unshield` 一次并带上存 Aave 的尾调用。这笔提现是一笔交易：

[`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b)
——EntryPoint → `paymaster.relayWithdraw` → `TornadoRouter` → `RelayerRegistry.burn`（从质押里烧 0.1137 TORN，5000 → 4999.8863）→ 池子 → wrap → 存 Aave。证明里绑定的 fee 0.002564 ETH，实际 gas 0.000837 ETH，退回 0.001290 ETH，钱包到账 0.097436 aWETH。
