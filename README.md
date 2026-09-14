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

Prerequisites: Node ≥ 22 with pnpm, Foundry, and the Tornado proving artifacts (`tornado.json`,
`tornadoProvingKey.bin`, `withdraw.json` from `tornado-cli`) with `TORNADO_ARTIFACTS_DIR` pointing at them.

```bash
pnpm install
(cd contracts && forge install && forge build && forge test)     # 28 tests: paymaster, mocks, sandbox DAO
(cd contracts-tornado && forge build)                            # ETHTornado / ERC20Tornado for fresh pools on forks
pnpm --filter @tornado-4337/relayer test                         # 10 tests: validation, fee math, encoding

# mainnet fork (anvil + alto bundler + in-process relayer; ~3 min per suite, RPC defaults to publicnode)
export MAINNET_RPC_URL=https://…   TORNADO_ARTIFACTS_DIR=…/tornado-cli/circuits
pnpm --filter @tornado-4337/client e2e                           # all three suites below
pnpm --filter @tornado-4337/client e2e -- e2e/registry-burn.test.ts

# the same suites on a Sepolia fork, against the sandbox DAO
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e

# real Kohaku SDK on a Sepolia fork (clones + patches Kohaku and kohaku-cli into kohaku-integration/vendor)
pnpm --filter @tornado-4337/kohaku-integration setup
pnpm --filter @tornado-4337/kohaku-integration e2e
```

What the mainnet-fork suites do:

| Suite | Flow | Checks |
| --- | --- | --- |
| `withdraw-swap-aave` | fresh ETH 0.1 pool → `relayWithdraw` → Uniswap → Aave (aUSDC) | atomic tail, refund, paymaster deposit grows, TS hash = contract `getHash`, fee-too-low refused |
| `withdraw-erc20-aave` | fresh DAI 100 pool → `relayWithdraw` → Aave (aDAI), fee priced with the 1inch oracle | fee and refund in DAI, token sweep |
| `registry-burn` (master) | real `TornadoRouter` 0xd90e… / `RelayerRegistry` 0x58E8… / FeeManager; fresh pools added by impersonated governance at 0.30 %; ENS name + 5000 real TORN written into the fork for the paymaster | `StakeBurned` == `FeeManager.instanceFee` (~0.1155 TORN), stake decreases, refund still paid, direct `pool.withdraw` refused, unregistered paymaster refused at boot |
| `registry-burn` (worker) | the paymaster registered as a worker of a really registered relayer (solid-relayer.eth, impersonated) | fee lands on the master EOA, the master's stake is burned, no refund, paymaster only pays gas |

## What we did on Sepolia

Everything below is on Sepolia, owner / governance `0x4DC4…c68B`, Kohaku CLI wallet `0x8b89…Dd79`, bundled by
Pimlico's public endpoint. The DAO's own Sepolia registry has no router, no enabled pools and a zero fee, so the
DAO part is a sandbox copy of the stack (same ABIs, test TORN minted by us).

**Contracts**

| | Address | Tx |
| --- | --- | --- |
| TornadoRelayerPaymaster (current) | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) | [deploy](https://sepolia.etherscan.io/tx/0x58bc7b7827ce112b1610fadc8692782aa24487057ce008254ae2bb006f2c8589) · [deposit 0.05 ETH](https://sepolia.etherscan.io/tx/0xa345847c8f1812c44a61b98ac3f09c014be6d409fa5ff43d13acf2540ebff922) |
| SwapAndSupplyZap | [`0x2B247C8e…Ca33`](https://sepolia.etherscan.io/address/0x2B247C8ee4556B35d510C0BdBD75194c11C4Ca33) | [deploy](https://sepolia.etherscan.io/tx/0xeb67a405a7d1299bd45c89c9c0d61cb6dd453b2d218de4e19f0724944af3291b) |
| Earlier paymaster builds (direct pool call), retired | [`0xA05e1201…6E94`](https://sepolia.etherscan.io/address/0xA05e12016882b2FE01A080b04F5D2F6FC3AC6E94), [`0x5b785B2a…B2f1`](https://sepolia.etherscan.io/address/0x5b785B2ae9450c18E3841a92C079b217bd44B2f1) | [deploy](https://sepolia.etherscan.io/tx/0x9092624db7e504d109025909642fe4d60381d6db2e90d2e29e0c2bb982a03991) · [deposit withdrawn](https://sepolia.etherscan.io/tx/0x9dc449e087c065bab96315512d10e755f50dbd039038a19a9fc1af01511dbbfc) |
| Sandbox TORN (10 M minted) | [`0xf732fac9…bB8E`](https://sepolia.etherscan.io/address/0xf732fac951a97939A273b34c7Ca21b51C9AcbB8E) | [deploy](https://sepolia.etherscan.io/tx/0x84e5d621e3616afb966276069a48233e125c46b4f5001c9ccc4aece9990a4a8a) |
| Sandbox ENS | [`0xa5c36Dc6…c0Ad`](https://sepolia.etherscan.io/address/0xa5c36Dc6Dd5927EA7B1964015Fa6f27292d4c0Ad) | [deploy](https://sepolia.etherscan.io/tx/0x88a6f35586acf7c3ee1be96c35ec86b824a4c6c086f009f2ed23a3ff33e5c72a) |
| Sandbox StakingRewards | [`0x16AEE731…FBfA`](https://sepolia.etherscan.io/address/0x16AEE73159B43D1a783Ee025802BE43125B0FBfA) | [deploy](https://sepolia.etherscan.io/tx/0x2c80a81cdaad5a8af7c7b0ea5207fbb1ff5faea4651edd1c1931a2088f4880a9) |
| Sandbox InstanceRegistry | [`0x1BDf1FE9…6424`](https://sepolia.etherscan.io/address/0x1BDf1FE9297ed844FE17DF70537A95a29dA66424) | [deploy](https://sepolia.etherscan.io/tx/0xb774cae50e6799fb7730ed589b548148603855be486cbd836c461062b94cd029) |
| Sandbox FeeManager | [`0x7cFEFbDe…49c9`](https://sepolia.etherscan.io/address/0x7cFEFbDe09B5d0883966e153d6B6c2f8d70049c9) | [deploy](https://sepolia.etherscan.io/tx/0x87eecab1af4ad08d88c6ce624024df45537de10e84d6e9f00bce36718ad8ad21) |
| Sandbox RelayerRegistry | [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) | [deploy](https://sepolia.etherscan.io/tx/0x403309d88402e6de443acede8c00afaecc768ed44d2a9e1dff9bde394852d019) |
| Sandbox TornadoRouter | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D) | [deploy](https://sepolia.etherscan.io/tx/0x7aad1d2a3e7f979ff9d51767ee2b42f4c188d1eecdb0c7bcb30cdd8d642bbf0c) |

**Wiring and registration** (governance = deployer)

| Step | Tx |
| --- | --- |
| InstanceRegistry / RelayerRegistry `setTornadoRouter`, Staking `setRelayerRegistry` | [1](https://sepolia.etherscan.io/tx/0x56f98610bceb9b9134cc349823db66004ea12996c460c6ace2c5a73fc0b12857) · [2](https://sepolia.etherscan.io/tx/0x44d6b35d09f81e7521c9766fe742c5d69657ed475be4a31cd1ef6c1e04dc71d7) · [3](https://sepolia.etherscan.io/tx/0x7d59c46f9a98a17b16119776bd8ecea49ed764d2220a66cdbf95b6f074ab6272) |
| `setMinStakeAmount(5000 TORN)` | [tx](https://sepolia.etherscan.io/tx/0x05ec1876534b8986c32b52f869ee968ffb72f64f891a6579cfbbfc0a0896d3a6) |
| TORN price: 379 TORN/ETH, 0.15 TORN/DAI | [tx](https://sepolia.etherscan.io/tx/0xf3bbcd3d42cf86adfc9c9c3a18219e32ee0a0af97039cefa3fc139bd39ff1d8b) · [tx](https://sepolia.etherscan.io/tx/0xb3657c2e0976ce084967c40bfa855f56573a5595ad7045624ae4c5f0ab6d15e9) |
| Enable pools ETH 0.1 / ETH 1 / DAI 100 at 0.30 % | [tx](https://sepolia.etherscan.io/tx/0xf985ea08a9024847298e8b8ff8cca0ad7953d2ff2e9371f773ea09d64d0cf364) · [tx](https://sepolia.etherscan.io/tx/0xb14330922fe52922e4d26fffbe160b5cd05b3811f586a138887c23f824e76f82) · [tx](https://sepolia.etherscan.io/tx/0xf7900444ec83ef9cdcbd0b9a3799c8c71bfbe66e390aad0f82d1fab3eeecaf2b) |
| `updateAllFees` → 0.1137 / 1.137 / 0.045 TORN per withdrawal | [tx](https://sepolia.etherscan.io/tx/0x703f4baed3366494e84e59fbf611ac37897233d539eda8c481cc3021169696c9) |
| ENS `relayer.sandbox.eth` → paymaster, 5000 TORN → paymaster | [tx](https://sepolia.etherscan.io/tx/0xdd3f58e3fcad058a84b792e81b8c3bff13d575e502f305fddf43b35943ebad29) · [tx](https://sepolia.etherscan.io/tx/0x2db8848b5a68f4c314887275e7fcdc359b93c97e5e091019ed348df5bb70560a) |
| paymaster `setRouter`, `registerAsRelayer` (master, 5000 TORN staked) | [tx](https://sepolia.etherscan.io/tx/0xda578f1acb68b237ef77a596735b8a7d80f75341fcecb45d01124041eb2dec71) · [tx](https://sepolia.etherscan.io/tx/0x0e5c5336a48049b7676dd4bfb20fc87275df01cc2c15226d80f7a9d34a4aa5d8) |

**Live withdrawals** (each: `kohaku shield` 0.1 ETH, then `kohaku unshield --tail-calls zap:wrapEthAndSupply(wallet):max`)

| Run | Shield | Unshield (one tx) | Fee / gas / refund | Result |
| --- | --- | --- | --- | --- |
| 1 · paymaster `0xA05e…`, `pool.withdraw` called directly | [`0x14c3daaa…73ac`](https://sepolia.etherscan.io/tx/0x14c3daaa20829573465c0c5a96b6eb5fbcbae42a114b8dfedf9c93c5496e73ac) | [`0x5d61d705…7000`](https://sepolia.etherscan.io/tx/0x5d61d705186b06381a29c23a272c7aba92a15b2cb6012c8548105524b41b7000) | 0.002380 / 0.000930 / 0.001033 ETH | 0.097620 aWETH |
| 2 · paymaster `0x0205…`, `relayWithdraw` without a router | [`0x3ae621fe…9172`](https://sepolia.etherscan.io/tx/0x3ae621fe42bedf3b581ffee6d0d6d25a558f411cf50b30ba932c52ba13089172) | [`0x42f07d41…1609`](https://sepolia.etherscan.io/tx/0x42f07d41fa7fc7315419c44f6855faa5daf048c200093b240fa7090a04e91609) | 0.002168 / 0.000762 / 0.000975 ETH | 0.097832 aWETH |
| 3 · `relayWithdraw` → sandbox `TornadoRouter` → `RelayerRegistry.burn` | [`0xa9af8368…d2d1`](https://sepolia.etherscan.io/tx/0xa9af8368fcc7a690fbf23285e2eb1f694dff06c0e8559548775ea981f655d2d1) | [`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b) | 0.002564 / 0.000837 / 0.001290 ETH | 0.097436 aWETH, **0.1137 TORN burned** (stake 5000 → 4999.8863) |

After the three runs the wallet holds 0.2929 aWETH and the paymaster's EntryPoint deposit went 0.05 → 0.0508 ETH.

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

前置：Node ≥ 22 + pnpm、Foundry、Tornado 的证明文件（`tornado-cli` 里的 `tornado.json`、`tornadoProvingKey.bin`、`withdraw.json`），用 `TORNADO_ARTIFACTS_DIR` 指向它们。

```bash
pnpm install
(cd contracts && forge install && forge build && forge test)     # 28 个：paymaster、mock、沙盒 DAO
(cd contracts-tornado && forge build)                            # ETHTornado / ERC20Tornado，fork 上部署新池子用
pnpm --filter @tornado-4337/relayer test                         # 10 个：校验、费用计算、编码

# 主网 fork（anvil + alto bundler + 进程内 relayer；每套约 3 分钟，RPC 默认 publicnode）
export MAINNET_RPC_URL=https://…   TORNADO_ARTIFACTS_DIR=…/tornado-cli/circuits
pnpm --filter @tornado-4337/client e2e                           # 下面三套全跑
pnpm --filter @tornado-4337/client e2e -- e2e/registry-burn.test.ts

# 同一套测试跑 Sepolia fork，对着沙盒 DAO
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e

# 真实 Kohaku SDK，Sepolia fork（会把 Kohaku 和 kohaku-cli 克隆到 kohaku-integration/vendor 并打补丁）
pnpm --filter @tornado-4337/kohaku-integration setup
pnpm --filter @tornado-4337/kohaku-integration e2e
```

主网 fork 各套测试做的事：

| 套件 | 流程 | 检查 |
| --- | --- | --- |
| `withdraw-swap-aave` | 新部署 ETH 0.1 池 → `relayWithdraw` → Uniswap → Aave（aUSDC） | 尾调用原子性、退款、paymaster 押金增加、TS 侧哈希 = 合约 `getHash`、fee 过低被拒 |
| `withdraw-erc20-aave` | 新部署 DAI 100 池 → `relayWithdraw` → Aave（aDAI），用 1inch 预言机定价 | fee 和退款都是 DAI、token 提取 |
| `registry-burn`（master） | 真实 `TornadoRouter` 0xd90e… / `RelayerRegistry` 0x58E8… / FeeManager；冒充 governance 把新池子按 0.30 % 登记；ENS 名字和 5000 个真 TORN 写进 fork 给 paymaster | `StakeBurned` == `FeeManager.instanceFee`（约 0.1155 TORN）、质押减少、退款照常、直接 `pool.withdraw` 被拒、未登记的 paymaster 启动被拒 |
| `registry-burn`（worker） | paymaster 登记为一个真实已注册 relayer（solid-relayer.eth，冒充）的 worker | fee 到 master EOA、烧 master 的质押、无退款、paymaster 只出 gas |

## 我们在 Sepolia 做了什么

以下全部在 Sepolia，owner / governance `0x4DC4…c68B`，Kohaku CLI 钱包 `0x8b89…Dd79`，Pimlico 公共 bundler 打包。DAO 自己的 Sepolia registry 没有 router、没有启用的池子、费用为 0，所以 DAO 这部分是我们部署的沙盒副本（ABI 一致，TORN 是我们 mint 的测试币）。

**合约**

| | 地址 | 交易 |
| --- | --- | --- |
| TornadoRelayerPaymaster（当前） | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) | [部署](https://sepolia.etherscan.io/tx/0x58bc7b7827ce112b1610fadc8692782aa24487057ce008254ae2bb006f2c8589) · [存 0.05 ETH 押金](https://sepolia.etherscan.io/tx/0xa345847c8f1812c44a61b98ac3f09c014be6d409fa5ff43d13acf2540ebff922) |
| SwapAndSupplyZap | [`0x2B247C8e…Ca33`](https://sepolia.etherscan.io/address/0x2B247C8ee4556B35d510C0BdBD75194c11C4Ca33) | [部署](https://sepolia.etherscan.io/tx/0xeb67a405a7d1299bd45c89c9c0d61cb6dd453b2d218de4e19f0724944af3291b) |
| 早期 paymaster（直接调池子），已退役 | [`0xA05e1201…6E94`](https://sepolia.etherscan.io/address/0xA05e12016882b2FE01A080b04F5D2F6FC3AC6E94)、[`0x5b785B2a…B2f1`](https://sepolia.etherscan.io/address/0x5b785B2ae9450c18E3841a92C079b217bd44B2f1) | [部署](https://sepolia.etherscan.io/tx/0x9092624db7e504d109025909642fe4d60381d6db2e90d2e29e0c2bb982a03991) · [押金取回](https://sepolia.etherscan.io/tx/0x9dc449e087c065bab96315512d10e755f50dbd039038a19a9fc1af01511dbbfc) |
| 沙盒 TORN（铸 1000 万） | [`0xf732fac9…bB8E`](https://sepolia.etherscan.io/address/0xf732fac951a97939A273b34c7Ca21b51C9AcbB8E) | [部署](https://sepolia.etherscan.io/tx/0x84e5d621e3616afb966276069a48233e125c46b4f5001c9ccc4aece9990a4a8a) |
| 沙盒 ENS | [`0xa5c36Dc6…c0Ad`](https://sepolia.etherscan.io/address/0xa5c36Dc6Dd5927EA7B1964015Fa6f27292d4c0Ad) | [部署](https://sepolia.etherscan.io/tx/0x88a6f35586acf7c3ee1be96c35ec86b824a4c6c086f009f2ed23a3ff33e5c72a) |
| 沙盒 StakingRewards | [`0x16AEE731…FBfA`](https://sepolia.etherscan.io/address/0x16AEE73159B43D1a783Ee025802BE43125B0FBfA) | [部署](https://sepolia.etherscan.io/tx/0x2c80a81cdaad5a8af7c7b0ea5207fbb1ff5faea4651edd1c1931a2088f4880a9) |
| 沙盒 InstanceRegistry | [`0x1BDf1FE9…6424`](https://sepolia.etherscan.io/address/0x1BDf1FE9297ed844FE17DF70537A95a29dA66424) | [部署](https://sepolia.etherscan.io/tx/0xb774cae50e6799fb7730ed589b548148603855be486cbd836c461062b94cd029) |
| 沙盒 FeeManager | [`0x7cFEFbDe…49c9`](https://sepolia.etherscan.io/address/0x7cFEFbDe09B5d0883966e153d6B6c2f8d70049c9) | [部署](https://sepolia.etherscan.io/tx/0x87eecab1af4ad08d88c6ce624024df45537de10e84d6e9f00bce36718ad8ad21) |
| 沙盒 RelayerRegistry | [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) | [部署](https://sepolia.etherscan.io/tx/0x403309d88402e6de443acede8c00afaecc768ed44d2a9e1dff9bde394852d019) |
| 沙盒 TornadoRouter | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D) | [部署](https://sepolia.etherscan.io/tx/0x7aad1d2a3e7f979ff9d51767ee2b42f4c188d1eecdb0c7bcb30cdd8d642bbf0c) |

**接线与登记**（governance = 部署者）

| 步骤 | 交易 |
| --- | --- |
| InstanceRegistry / RelayerRegistry `setTornadoRouter`，Staking `setRelayerRegistry` | [1](https://sepolia.etherscan.io/tx/0x56f98610bceb9b9134cc349823db66004ea12996c460c6ace2c5a73fc0b12857) · [2](https://sepolia.etherscan.io/tx/0x44d6b35d09f81e7521c9766fe742c5d69657ed475be4a31cd1ef6c1e04dc71d7) · [3](https://sepolia.etherscan.io/tx/0x7d59c46f9a98a17b16119776bd8ecea49ed764d2220a66cdbf95b6f074ab6272) |
| `setMinStakeAmount(5000 TORN)` | [tx](https://sepolia.etherscan.io/tx/0x05ec1876534b8986c32b52f869ee968ffb72f64f891a6579cfbbfc0a0896d3a6) |
| TORN 价格：379 TORN/ETH、0.15 TORN/DAI | [tx](https://sepolia.etherscan.io/tx/0xf3bbcd3d42cf86adfc9c9c3a18219e32ee0a0af97039cefa3fc139bd39ff1d8b) · [tx](https://sepolia.etherscan.io/tx/0xb3657c2e0976ce084967c40bfa855f56573a5595ad7045624ae4c5f0ab6d15e9) |
| 启用 ETH 0.1 / ETH 1 / DAI 100 三个池，费率 0.30 % | [tx](https://sepolia.etherscan.io/tx/0xf985ea08a9024847298e8b8ff8cca0ad7953d2ff2e9371f773ea09d64d0cf364) · [tx](https://sepolia.etherscan.io/tx/0xb14330922fe52922e4d26fffbe160b5cd05b3811f586a138887c23f824e76f82) · [tx](https://sepolia.etherscan.io/tx/0xf7900444ec83ef9cdcbd0b9a3799c8c71bfbe66e390aad0f82d1fab3eeecaf2b) |
| `updateAllFees` → 每笔 0.1137 / 1.137 / 0.045 TORN | [tx](https://sepolia.etherscan.io/tx/0x703f4baed3366494e84e59fbf611ac37897233d539eda8c481cc3021169696c9) |
| ENS `relayer.sandbox.eth` → paymaster，5000 TORN → paymaster | [tx](https://sepolia.etherscan.io/tx/0xdd3f58e3fcad058a84b792e81b8c3bff13d575e502f305fddf43b35943ebad29) · [tx](https://sepolia.etherscan.io/tx/0x2db8848b5a68f4c314887275e7fcdc359b93c97e5e091019ed348df5bb70560a) |
| paymaster `setRouter`、`registerAsRelayer`（master，质押 5000 TORN） | [tx](https://sepolia.etherscan.io/tx/0xda578f1acb68b237ef77a596735b8a7d80f75341fcecb45d01124041eb2dec71) · [tx](https://sepolia.etherscan.io/tx/0x0e5c5336a48049b7676dd4bfb20fc87275df01cc2c15226d80f7a9d34a4aa5d8) |

**实网提现**（每次都是 `kohaku shield` 0.1 ETH，然后 `kohaku unshield --tail-calls zap:wrapEthAndSupply(钱包):max`）

| 次 | Shield | Unshield（一笔交易） | fee / gas / 退款 | 结果 |
| --- | --- | --- | --- | --- |
| 1 · paymaster `0xA05e…`，直接调 `pool.withdraw` | [`0x14c3daaa…73ac`](https://sepolia.etherscan.io/tx/0x14c3daaa20829573465c0c5a96b6eb5fbcbae42a114b8dfedf9c93c5496e73ac) | [`0x5d61d705…7000`](https://sepolia.etherscan.io/tx/0x5d61d705186b06381a29c23a272c7aba92a15b2cb6012c8548105524b41b7000) | 0.002380 / 0.000930 / 0.001033 ETH | 0.097620 aWETH |
| 2 · paymaster `0x0205…`，`relayWithdraw`，没有 router | [`0x3ae621fe…9172`](https://sepolia.etherscan.io/tx/0x3ae621fe42bedf3b581ffee6d0d6d25a558f411cf50b30ba932c52ba13089172) | [`0x42f07d41…1609`](https://sepolia.etherscan.io/tx/0x42f07d41fa7fc7315419c44f6855faa5daf048c200093b240fa7090a04e91609) | 0.002168 / 0.000762 / 0.000975 ETH | 0.097832 aWETH |
| 3 · `relayWithdraw` → 沙盒 `TornadoRouter` → `RelayerRegistry.burn` | [`0xa9af8368…d2d1`](https://sepolia.etherscan.io/tx/0xa9af8368fcc7a690fbf23285e2eb1f694dff06c0e8559548775ea981f655d2d1) | [`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b) | 0.002564 / 0.000837 / 0.001290 ETH | 0.097436 aWETH，**烧掉 0.1137 TORN**（质押 5000 → 4999.8863） |

三次跑完钱包持有 0.2929 aWETH，paymaster 的 EntryPoint 押金 0.05 → 0.0508 ETH。
