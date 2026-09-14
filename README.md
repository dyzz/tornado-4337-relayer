# tornado-4337-relayer

**Let today's Tornado Cash relayers sponsor atomic ERC-4337 withdrawals — without becoming bundlers, and
without leaving the DAO's relayer economics.**

English | [简体中文](#简体中文)

> Status: working proof of concept — Kohaku wallet integration, mainnet-fork tests against the real DAO
> contracts, live runs on Sepolia. Experimental, unaudited, not for production.

## What it does

A user withdraws a Tornado note and, in the **same transaction**, swaps the funds and deposits them into Aave.
Gas is paid from the note itself. The receiving account never needs ETH.

The relayer's job barely changes. It still quotes a fee, checks the withdrawal, gets paid by the pool, and burns
TORN from its stake on every withdrawal. The one thing it stops doing is sending the transaction: it **signs**
an authorization instead, and the user's wallet hands the operation to any ERC-4337 bundler.

This is an upgrade path for existing relayers, not a way around them:

- your pools, your fee policy, your price oracle (the same 1inch oracle `tornado-relayer` uses), your Tor setup;
- the DAO's rules still apply — withdrawals go through `TornadoRouter`, so `RelayerRegistry` burns the pool's
  TORN fee from your stake exactly as today;
- Tornado pool contracts and the circuit are untouched — the proof simply names your relayer as `relayer`;
- no custody, no user keys, no bundler to run, no mempool to babysit.

## How a withdrawal works

1. The wallet asks the relayer for a quote and puts the quoted fee and relayer address into the ZK proof.
2. The wallet builds a UserOperation from a fresh EIP-7702 account:
   `paymaster.relayWithdraw` → (swap) → `Aave.supply`.
3. The relayer checks proof, root, nullifier, fee and registry state, simulates the whole operation, and signs.
4. The wallet sends the signed operation to a bundler (Pimlico in the demo; any bundler works).
5. On-chain, the paymaster's signature is verified, then `relayWithdraw` forwards the withdrawal through
   `TornadoRouter`: the registry burns the pool's TORN fee from the relayer's stake, the pool pays out and pays
   the fee, the tail calls run, and `postOp` settles the fee.

If any step of the tail reverts, the withdrawal reverts with it. Nothing leaves the pool.

## Two ways to register the paymaster

The paymaster is the address the DAO's registry sees, so it has to be a registered relayer.

| | Worker mode | Master mode |
| --- | --- | --- |
| Setup | your existing master calls `registerWorker(master, paymaster)` | paymaster owns an ENS name, holds ≥ `minStakeAmount` TORN, calls `registerAsRelayer` |
| New stake | none — your existing stake is burned | yes |
| Proof names | your master address (`REWARD_ACCOUNT`) | the paymaster |
| Fee | fixed, paid to your master as today | paymaster keeps actual gas + margin + service fee, **refunds the rest** to the user |
| Gas | paymaster's EntryPoint deposit, topped up from earnings | self-funding: ETH fees are re-deposited automatically |

Worker mode is the zero-friction path for a running relayer; master mode gives users the refund.

## Live run on Sepolia

Driven end to end by the Kohaku CLI wallet (patched to talk to the relayer), bundled by Pimlico's public endpoint,
with the paymaster registered as relayer master `relayer.sandbox.eth` (5000 TORN staked).

| | |
| --- | --- |
| Paymaster | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) |
| Shield 0.1 ETH (Kohaku wallet) | [`0xa9af8368…d2d1`](https://sepolia.etherscan.io/tx/0xa9af8368fcc7a690fbf23285e2eb1f694dff06c0e8559548775ea981f655d2d1) |
| Unshield → router → burn → wrap → Aave, one transaction | [`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b) |
| TORN burned from the stake (`StakeBurned`) | 0.1137 TORN (5000 → 4999.8863) |
| Fee bound in the proof / actual gas / refund | 0.002564 ETH / 0.000837 ETH / 0.001290 ETH |
| Landed in the wallet | 0.097436 aWETH |
| Paymaster deposit | 0.050401 → 0.050809 ETH |

**Sepolia DAO sandbox.** The DAO never finished its Sepolia deployment (no router, no enabled pools, zero fee,
no way to obtain its test TORN), so the run above goes through our own copy of the relayer stack —
`contracts/src/dao-sandbox`, deployed by `script/DeploySandboxDao.s.sol`. Same ABIs as mainnet; governance is
the deployer, the TORN is a mintable test token (`SandboxTORN`, 10 M minted to governance) and its price is set
by governance instead of a Uniswap TWAP. Pools ETH 0.1 / ETH 1 / DAI 100 are enabled at 0.30 %
(379 TORN/ETH → 0.1137 / 1.137 / 0.045 TORN per withdrawal).

| | |
| --- | --- |
| TornadoRouter | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D) |
| RelayerRegistry | [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) |
| InstanceRegistry / FeeManager | [`0x1BDf1FE9…6424`](https://sepolia.etherscan.io/address/0x1BDf1FE9297ed844FE17DF70537A95a29dA66424) / [`0x7cFEFbDe…49c9`](https://sepolia.etherscan.io/address/0x7cFEFbDe09B5d0883966e153d6B6c2f8d70049c9) |
| StakingRewards / TORN / ENS | [`0x16AEE731…FBfA`](https://sepolia.etherscan.io/address/0x16AEE73159B43D1a783Ee025802BE43125B0FBfA) / [`0xf732fac9…bB8E`](https://sepolia.etherscan.io/address/0xf732fac951a97939A273b34c7Ca21b51C9AcbB8E) / [`0xa5c36Dc6…c0Ad`](https://sepolia.etherscan.io/address/0xa5c36Dc6Dd5927EA7B1964015Fa6f27292d4c0Ad) |

The mainnet-fork tests run the same flows against the real router `0xd90e…`, registry `0x58E8…`, FeeManager
and TORN token: ETH (swap → aUSDC) and DAI (→ aDAI, fee paid and refunded in DAI), the paymaster as a fresh
master (stake written into the fork) and as a worker of a really registered relayer.

## For relayer operators

```bash
# 1. deploy the paymaster once (owner key) and give it an EntryPoint deposit
#    mainnet: add TORNADO_ROUTER=0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<your signing address> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. register it (pick one)
#    worker: from your master address   RelayerRegistry.registerWorker(<master>, <paymaster>)
#    master: ENS name owned by the paymaster + TORN sent to it, then
#            paymaster.registerAsRelayer(<RelayerRegistry>, "you.eth", <stake>)   (script/RegisterSandboxRelayer.s.sol shows the sequence)

# 3. run the signing service next to your existing relayer
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS, RELAYER_PRIVATE_KEY, TORNADO_INSTANCES, SERVICE_FEE_BPS, PRICE_SOURCE
                                      # REWARD_ACCOUNT=<your master> in worker mode
pnpm start                            # JSON-RPC on :8787 (pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status)
```

The service refuses to start if the paymaster is wired to a router but not registered, or if `REWARD_ACCOUNT`
does not match the master the registry resolves it to. `tornado_status` reports the mode, the stake left and the
TORN burned per withdrawal for each pool. ERC-20 fees (master mode) accumulate in the contract until you sweep
and convert them.

## For wallets

Kohaku hosts add one line to the chain's paymaster config:

```ts
paymasterConfig[chainId] = { ...existing, paymasterAddress: '<paymaster>', relayer: { url: 'https://your-relayer/' } };
```

The rest of Kohaku's `mode: 'paymaster'` path (7702 sender, proof, tail calls, broadcaster) is reused.
Any viem / permissionless stack can use the relayer as an ERC-7677 paymaster client.
With the patched Kohaku CLI:

```bash
KOHAKU_TORNADO_RELAYER_URL=http://localhost:8787 KOHAKU_TORNADO_PAYMASTER=0x<paymaster> \
kohaku unshield --protocol tornado --wallet me --next --amount-formatted 0.1 \
  --tail-calls <zap>:<wrapEthAndSupply(you)>:max --broadcast
```

## Run the tests

```bash
pnpm install
(cd contracts && forge install && forge test)                    # paymaster + sandbox DAO unit tests
pnpm --filter @tornado-4337/relayer test                          # relayer unit tests
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # mainnet fork: ETH + DAI flows, real Router / RelayerRegistry burn (master + worker)
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # the same suites on a Sepolia fork, against the sandbox stack
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # real Kohaku SDK, Sepolia fork
```

## Repository

| Path | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymaster.sol` (verifying paymaster, EntryPoint v0.8), `SwapAndSupplyZap.sol`, `dao-sandbox/` (same-ABI copy of the DAO relayer stack for testnets) |
| `relayer/` | the signing service |
| `client/` | reference wallet flow, proof generation, e2e harness (anvil fork + alto) |
| `kohaku-integration/` | patches for `@kohaku-eth/tornado-cash` and `kohaku-cli`, Kohaku e2e |

## Trust model and limits

- The paymaster trusts the relayer's off-chain checks (that is what makes validation cheap and stake-free).
  A sponsored operation that reverts on-chain still costs the relayer gas; the pre-signing simulation keeps this rare.
- The relayer decides whether to sponsor; the bundler decides whether to include. Wallets should support several bundlers.
- `relayWithdraw` only accepts the note's recipient as caller, so nobody can burn your stake with someone else's
  proof; the registry itself rejects a worker relaying for the wrong master.
- Without a configured router the paymaster calls pools directly and nothing is burned. The Sepolia sandbox
  registry and its TORN are copies run by us, not the DAO's.
- Mainnet USDC/USDT pools are frozen by their issuers; DAI, cDAI and WBTC are the usable ERC-20 pools.
- The nullifier lock is in-memory; a multi-instance relayer needs a shared store.

---

# 简体中文

**让现有的 Tornado Cash relayer 直接为 ERC-4337 原子提现提供赞助——不用自己变成 bundler，也不脱离 DAO 的 relayer 经济模型。**

> 状态：可用的概念验证——Kohaku 钱包集成、对真实 DAO 合约的主网 fork 测试、Sepolia 实网记录。实验性质，未审计，不要用于生产。

## 做了什么

用户提一张 Tornado note，**同一笔交易**里换币并存进 Aave。gas 从 note 里扣，收款账户不需要有 ETH。

relayer 的工作几乎不变：照旧报价、检查提现、从池子收手续费、每笔从质押里烧 TORN。唯一不再做的事是发交易——改为**签一个授权**，由用户钱包把操作交给任意 ERC-4337 bundler。

这是给现有 relayer 的升级路径，不是绕开它们：

- 池子、手续费策略、价格预言机（沿用 `tornado-relayer` 的 1inch 预言机）、Tor 配置都是你自己的；
- DAO 的规则照旧生效——提现走 `TornadoRouter`，`RelayerRegistry` 照旧每笔从你的质押里烧掉该池的 TORN 费；
- Tornado 池合约和电路不动，证明里的 `relayer` 字段填你的 relayer 地址即可；
- 不托管资金、不碰用户私钥、不跑 bundler、不维护 mempool。

## 一笔提现的流程

1. 钱包向 relayer 要报价，把报价的 fee 和 relayer 地址写进 ZK 证明。
2. 钱包用一个新的 EIP-7702 账户组装 UserOperation：`paymaster.relayWithdraw` →（swap）→ `Aave.supply`。
3. relayer 检查证明、root、nullifier、fee 和 registry 状态，模拟整笔操作，然后签名。
4. 钱包把签好的操作发给 bundler（演示用 Pimlico，任何 bundler 都行）。
5. 链上先验证 paymaster 签名，再由 `relayWithdraw` 把提现转给 `TornadoRouter`：registry 从 relayer 的质押里烧掉该池的 TORN 费，池子放款并付 fee，尾调用执行，`postOp` 结算手续费。

尾调用任何一步失败，提现一起回滚，资金不会离开池子。

## paymaster 的两种登记方式

DAO 的 registry 看到的地址是 paymaster，所以它必须是一个已注册的 relayer。

| | worker 模式 | master 模式 |
| --- | --- | --- |
| 怎么登记 | 用你现有的 master 地址调 `registerWorker(master, paymaster)` | paymaster 持有一个 ENS 名字和 ≥ `minStakeAmount` 的 TORN，调 `registerAsRelayer` |
| 新质押 | 不需要，烧的是你现有的质押 | 需要 |
| 证明里的 relayer | 你的 master 地址（`REWARD_ACCOUNT`） | paymaster |
| 手续费 | 固定，照旧付到你的 master | paymaster 留下实际 gas + 加成 + 服务费，**多余的退给用户** |
| gas | paymaster 的 EntryPoint 押金出，从收入里补 | 自动循环：ETH 手续费自动存回 EntryPoint |

正在运行的 relayer 用 worker 模式零摩擦接入；master 模式能给用户退款。

## Sepolia 实网记录

由 Kohaku CLI 钱包（打了对接 relayer 的补丁）全程驱动，Pimlico 公共 bundler 打包；paymaster 注册为 relayer master `relayer.sandbox.eth`，质押 5000 TORN。

| | |
| --- | --- |
| Paymaster | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) |
| Shield 0.1 ETH（Kohaku 钱包） | [`0xa9af8368…d2d1`](https://sepolia.etherscan.io/tx/0xa9af8368fcc7a690fbf23285e2eb1f694dff06c0e8559548775ea981f655d2d1) |
| 提现 → router → 烧 TORN → wrap → 存 Aave，一笔交易 | [`0xc1581fa9…210b`](https://sepolia.etherscan.io/tx/0xc1581fa94cf85e018bc71a3b507415626631cba5ea171ef89f5ba5320563210b) |
| 从质押里烧掉的 TORN（`StakeBurned`） | 0.1137 TORN（5000 → 4999.8863） |
| 证明里绑定的 fee / 实际 gas / 退款 | 0.002564 ETH / 0.000837 ETH / 0.001290 ETH |
| 到账 | 0.097436 aWETH |
| Paymaster 押金 | 0.050401 → 0.050809 ETH |

**Sepolia 上的 DAO 沙盒。** DAO 在 Sepolia 的部署没有做完（没有 router、没有启用的池子、费用为 0、它的测试 TORN 也拿不到），所以上面这笔走的是我们自己部署的一套 relayer 栈副本——`contracts/src/dao-sandbox`，由 `script/DeploySandboxDao.s.sol` 部署。ABI 与主网一致；governance 是部署者，TORN 是可 mint 的测试币（`SandboxTORN`，给 governance 铸了 1000 万），价格由 governance 设定（代替 Uniswap TWAP）。启用了 ETH 0.1 / ETH 1 / DAI 100 三个池，费率 0.30 %（379 TORN/ETH → 每笔 0.1137 / 1.137 / 0.045 TORN）。

| | |
| --- | --- |
| TornadoRouter | [`0xF2DafFd7…a04D`](https://sepolia.etherscan.io/address/0xF2DafFd789ec02211a8f1be1034165cFf759a04D) |
| RelayerRegistry | [`0x30318086…a58e`](https://sepolia.etherscan.io/address/0x30318086d99E3cbf3D7378Fbd55BcF3EBDC1a58e) |
| InstanceRegistry / FeeManager | [`0x1BDf1FE9…6424`](https://sepolia.etherscan.io/address/0x1BDf1FE9297ed844FE17DF70537A95a29dA66424) / [`0x7cFEFbDe…49c9`](https://sepolia.etherscan.io/address/0x7cFEFbDe09B5d0883966e153d6B6c2f8d70049c9) |
| StakingRewards / TORN / ENS | [`0x16AEE731…FBfA`](https://sepolia.etherscan.io/address/0x16AEE73159B43D1a783Ee025802BE43125B0FBfA) / [`0xf732fac9…bB8E`](https://sepolia.etherscan.io/address/0xf732fac951a97939A273b34c7Ca21b51C9AcbB8E) / [`0xa5c36Dc6…c0Ad`](https://sepolia.etherscan.io/address/0xa5c36Dc6Dd5927EA7B1964015Fa6f27292d4c0Ad) |

主网 fork 测试对着真实的 router `0xd90e…`、registry `0x58E8…`、FeeManager 和真 TORN 跑同样的流程：ETH 池（swap → aUSDC）、DAI 池（→ aDAI，手续费和退款都是 DAI），paymaster 作为新注册的 master（质押是在 fork 上写进去的）、以及作为一个真实已注册 relayer 的 worker。

## Relayer 运营者怎么接

```bash
# 1. 部署一次 paymaster（owner key），并存入 EntryPoint 押金
#    主网加 TORNADO_ROUTER=0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<你的签名地址> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. 登记（二选一）
#    worker：用你的 master 地址调   RelayerRegistry.registerWorker(<master>, <paymaster>)
#    master：把一个 ENS 名字的 owner 设成 paymaster、给它转 TORN，然后
#            paymaster.registerAsRelayer(<RelayerRegistry>, "you.eth", <stake>)   （script/RegisterSandboxRelayer.s.sol 就是这个顺序）

# 3. 在现有 relayer 旁边跑签名服务
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS、RELAYER_PRIVATE_KEY、TORNADO_INSTANCES、SERVICE_FEE_BPS、PRICE_SOURCE
                                      # worker 模式加 REWARD_ACCOUNT=<你的 master>
pnpm start                            # :8787 上的 JSON-RPC（pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status）
```

paymaster 接了 router 却没登记、或 `REWARD_ACCOUNT` 与 registry 里解析出的 master 不一致时，服务会拒绝启动；`tornado_status` 会报告模式、剩余质押和每个池子每笔要烧的 TORN。master 模式下收到的 ERC-20 手续费留在合约里，由运营者定期提取换成 ETH。

## 钱包怎么接

Kohaku 宿主只需在该链的 paymaster 配置里加一行：

```ts
paymasterConfig[chainId] = { ...existing, paymasterAddress: '<paymaster>', relayer: { url: 'https://your-relayer/' } };
```

Kohaku 原有 `mode: 'paymaster'` 的其余部分（7702 sender、证明、尾调用、broadcaster）原样复用；任何 viem / permissionless 栈也可以把 relayer 当 ERC-7677 paymaster 用。打过补丁的 Kohaku CLI：

```bash
KOHAKU_TORNADO_RELAYER_URL=http://localhost:8787 KOHAKU_TORNADO_PAYMASTER=0x<paymaster> \
kohaku unshield --protocol tornado --wallet me --next --amount-formatted 0.1 \
  --tail-calls <zap>:<wrapEthAndSupply(you)>:max --broadcast
```

## 跑测试

```bash
pnpm install
(cd contracts && forge install && forge test)                    # paymaster + 沙盒 DAO 单测
pnpm --filter @tornado-4337/relayer test                          # relayer 单测
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 主网 fork：ETH + DAI 全流程、真实 Router / RelayerRegistry 烧 TORN（master + worker）
E2E_CHAIN=sepolia pnpm --filter @tornado-4337/client e2e          # 同一套测试跑 Sepolia fork，对着沙盒栈
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # 真实 Kohaku SDK，Sepolia fork
```

## 目录

| 路径 | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymaster.sol`（verifying paymaster，EntryPoint v0.8）、`SwapAndSupplyZap.sol`、`dao-sandbox/`（测试网用的同 ABI DAO relayer 栈副本） |
| `relayer/` | 签名服务 |
| `client/` | 参考钱包流程、证明生成、e2e 测试台（anvil fork + alto） |
| `kohaku-integration/` | `@kohaku-eth/tornado-cash` 与 `kohaku-cli` 的补丁、Kohaku e2e |

## 信任模型与限制

- paymaster 信任 relayer 的链下检查（这也是验证便宜、无需质押的原因）；被赞助的操作若在链上回滚，gas 由 relayer 承担，靠签名前的模拟把这种情况压到最低。
- relayer 决定赞不赞助，bundler 决定收不收；钱包应支持多个 bundler。
- `relayWithdraw` 只接受 note 的收款人调用，别人拿不到你的证明来烧你的质押；registry 本身也会拒绝 worker 替错误的 master 转发。
- 没配置 router 时 paymaster 直接调用池子、不烧 TORN。Sepolia 沙盒的 registry 和 TORN 都是我们运行的副本，不是 DAO 的。
- 主网 USDC/USDT 池已被发行方冻结，可用的 ERC-20 池是 DAI、cDAI、WBTC。
- nullifier 锁在内存里，多实例 relayer 需要共享存储。
