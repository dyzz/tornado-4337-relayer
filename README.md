# tornado-4337-relayer

**Let today's Tornado Cash relayers sponsor atomic ERC-4337 withdrawals — without becoming bundlers.**

English | [简体中文](#简体中文)

> Status: working proof of concept — Kohaku wallet integration, mainnet-fork tests, one live run on Sepolia.
> Experimental, unaudited, not for production.

## What it does

A user withdraws a Tornado note and, in the **same transaction**, swaps the funds and deposits them into Aave.
Gas is paid from the note itself. The receiving account never needs ETH.

The relayer's job barely changes. It still quotes a fee, checks the withdrawal, and gets paid by the pool.
The one thing it stops doing is sending the transaction: it **signs** an authorization instead, and the user's
wallet hands the operation to any ERC-4337 bundler.

This is meant as an upgrade path for existing relayers, not a way around them:

- your pools, your fee policy, your price oracle (the same 1inch oracle `tornado-relayer` uses), your Tor setup;
- the DAO's rules still apply: withdrawals go through `TornadoRouter`, so `RelayerRegistry` burns the pool's TORN
  fee from your stake on every withdrawal — the paymaster is registered as a **worker** of your existing relayer
  (keep your stake, fee still lands on your master address) or as a relayer **master** of its own;
- Tornado pool contracts and the circuit are untouched — the proof simply names your relayer address as `relayer`;
- no custody, no user keys, no bundler to run, no mempool to babysit.

## How a withdrawal works

1. The wallet asks the relayer for a quote and puts the quoted fee and relayer address into the ZK proof.
2. The wallet builds a UserOperation: `paymaster.relayWithdraw` → (swap) → `Aave.supply`, all from a fresh
   EIP-7702 account.
3. The relayer checks the proof, root, nullifier, fee and registry state, simulates the whole operation, and signs.
4. The wallet sends the signed operation to a bundler (Pimlico in the demo, but any bundler works).
5. On-chain: the paymaster's signature is verified; `relayWithdraw` forwards the withdrawal through
   `TornadoRouter`, which burns the pool's TORN fee from the relayer's stake and calls the pool; the pool pays
   the fee; the tail calls run; and `postOp` keeps actual gas + margin + service fee and **refunds the rest**
   to the user (master mode — in worker mode the fee goes to your master address as today, fixed).

If any step of the tail reverts, the withdrawal reverts with it. Nothing leaves the pool.

## Live run on Sepolia

Driven end to end by the Kohaku CLI wallet (patched to talk to the relayer), bundled by Pimlico's public endpoint.

| | |
| --- | --- |
| Paymaster | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) |
| Shield 0.1 ETH (Kohaku wallet) | [`0x3ae621fe…9172`](https://sepolia.etherscan.io/tx/0x3ae621fe42bedf3b581ffee6d0d6d25a558f411cf50b30ba932c52ba13089172) |
| Unshield via `relayWithdraw` → wrap → Aave, one transaction | [`0x42f07d41…1609`](https://sepolia.etherscan.io/tx/0x42f07d41fa7fc7315419c44f6855faa5daf048c200093b240fa7090a04e91609) |
| Fee bound in the proof / actual gas / refund | 0.002168 ETH / 0.000762 ETH / 0.000975 ETH |
| Landed in the wallet | 0.097832 aWETH |
| Paymaster deposit | 0.05 → 0.050401 ETH |

Mainnet-fork tests cover ETH (swap → aUSDC) and ERC-20 pools (DAI → aDAI, fee paid and refunded in DAI), and the
DAO path against the real `TornadoRouter` / `RelayerRegistry`: the paymaster as a fresh master and as a worker
of a real registered relayer, TORN burned from the stake on each withdrawal. Sepolia has no router deployed by
the DAO, so the live run above calls the pool directly.

## For relayer operators

```bash
# 1. deploy the paymaster once (owner key) and give it an EntryPoint deposit
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<your signing address> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. register the paymaster with the DAO (mainnet: TORNADO_ROUTER=0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b above)
#    a) worker of your existing relayer — from your master address, no new stake:
#       RelayerRegistry.registerWorker(<your master>, <paymaster>)      then REWARD_ACCOUNT=<your master> below
#    b) a new relayer master — ENS name owned by the paymaster + ≥ minStakeAmount TORN sent to it, then:
#       paymaster.registerAsRelayer(<RelayerRegistry>, "you.eth", <stake>)

# 3. run the signing service next to your existing relayer
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS, RELAYER_PRIVATE_KEY, TORNADO_INSTANCES, SERVICE_FEE_BPS, PRICE_SOURCE, REWARD_ACCOUNT
pnpm start                            # JSON-RPC on :8787 (pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status)
```

The service refuses to start if the paymaster is wired to a router but not registered, or if `REWARD_ACCOUNT`
does not match the master the registry resolves it to. `tornado_status` reports the mode, the stake left and the
TORN burned per withdrawal for each pool.

Economics, worker mode: the user pays a fixed fee to your master address as today; the paymaster's EntryPoint
deposit pays the gas and you top it up from earnings. Master mode: the paymaster keeps
`actual gas × (1 + margin) + service fee` per withdrawal, refunds the rest to the user and re-deposits ETH fees
automatically; ERC-20 fees accumulate in the contract until you sweep and convert them.

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
(cd contracts && forge install && forge test)                    # paymaster unit tests
pnpm --filter @tornado-4337/relayer test                          # relayer unit tests
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # mainnet fork: ETH + DAI flows, Router / RelayerRegistry burn (master + worker)
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # real Kohaku SDK, Sepolia fork
```

## Repository

| Path | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymaster.sol` (verifying paymaster, EntryPoint v0.8), `SwapAndSupplyZap.sol` |
| `relayer/` | the signing service |
| `client/` | reference wallet flow, proof generation, e2e harness (anvil fork + alto) |
| `kohaku-integration/` | patches for `@kohaku-eth/tornado-cash` and `kohaku-cli`, Kohaku e2e |

## Trust model and limits

- The paymaster trusts the relayer's off-chain checks (that is what makes validation cheap and stake-free).
  A sponsored operation that reverts on-chain still costs the relayer gas; the pre-signing simulation keeps this rare.
- The relayer decides whether to sponsor; the bundler decides whether to include. Wallets should support several bundlers.
- `relayWithdraw` only accepts the note's recipient as caller, so nobody can burn your stake with someone else's
  proof; the registry itself rejects a worker relaying for the wrong master (`only relayer`).
- Where the DAO has no router (Sepolia) the paymaster calls pools directly and nothing is burned.
- Mainnet USDC/USDT pools are frozen by their issuers; DAI, cDAI and WBTC are the usable ERC-20 pools.
- The nullifier lock is in-memory; a multi-instance relayer needs a shared store.

---

# 简体中文

**让现有的 Tornado Cash relayer 直接为 ERC-4337 原子提现提供赞助——不用自己变成 bundler。**

> 状态：可用的概念验证——Kohaku 钱包集成、主网 fork 测试、Sepolia 实网跑通一笔。实验性质，未审计，不要用于生产。

## 做了什么

用户提一张 Tornado note，**同一笔交易**里换币并存进 Aave。gas 从 note 里扣，收款账户不需要有 ETH。

relayer 的工作几乎不变：照旧报价、检查提现、从池子收手续费。唯一不再做的事是发交易——改为**签一个授权**，
由用户钱包把操作交给任意 ERC-4337 bundler。

这是给现有 relayer 的升级路径，不是绕开它们：

- 池子、手续费策略、价格预言机（沿用 `tornado-relayer` 的 1inch 预言机）、Tor 配置都是你自己的；
- DAO 的规则照旧生效：提现走 `TornadoRouter`，`RelayerRegistry` 每笔从你的质押里烧掉该池的 TORN 费——paymaster 登记为你现有 relayer 的 **worker**（质押不动、手续费照旧到你的 master 地址），或者登记为独立的 relayer **master**；
- Tornado 池合约和电路不动，证明里的 `relayer` 字段填你的 relayer 地址即可；
- 不托管资金、不碰用户私钥、不跑 bundler、不维护 mempool。

## 一笔提现的流程

1. 钱包向 relayer 要报价，把报价的 fee 和 relayer 地址写进 ZK 证明。
2. 钱包组装 UserOperation：`paymaster.relayWithdraw` →（swap）→ `Aave.supply`，全部由一个新的 EIP-7702 账户执行。
3. relayer 检查证明、root、nullifier、fee 和 registry 状态，模拟整笔操作，然后签名。
4. 钱包把签好的操作发给 bundler（演示用 Pimlico，任何 bundler 都行）。
5. 链上：验证 paymaster 签名 → `relayWithdraw` 把提现转给 `TornadoRouter`，从 relayer 的质押里烧掉该池的 TORN 费再调用池子 → 池子付 fee → 执行尾调用 → `postOp` 留下实际 gas + 加成 + 服务费，**差价退给用户**（master 模式；worker 模式下 fee 照旧固定付到你的 master 地址）。

尾调用任何一步失败，提现一起回滚，资金不会离开池子。

## Sepolia 实网记录

由 Kohaku CLI 钱包（打了对接 relayer 的补丁）全程驱动，Pimlico 公共 bundler 打包。

| | |
| --- | --- |
| Paymaster | [`0x0205938E…6dD9`](https://sepolia.etherscan.io/address/0x0205938E251010683788e6013Dd0A72eB7296dD9) |
| Shield 0.1 ETH（Kohaku 钱包） | [`0x3ae621fe…9172`](https://sepolia.etherscan.io/tx/0x3ae621fe42bedf3b581ffee6d0d6d25a558f411cf50b30ba932c52ba13089172) |
| 经 `relayWithdraw` 提现 → wrap → 存 Aave，一笔交易 | [`0x42f07d41…1609`](https://sepolia.etherscan.io/tx/0x42f07d41fa7fc7315419c44f6855faa5daf048c200093b240fa7090a04e91609) |
| 证明里绑定的 fee / 实际 gas / 退款 | 0.002168 ETH / 0.000762 ETH / 0.000975 ETH |
| 到账 | 0.097832 aWETH |
| Paymaster 押金 | 0.05 → 0.050401 ETH |

主网 fork 测试覆盖 ETH 池（swap → aUSDC）、ERC-20 池（DAI → aDAI，手续费和退款都是 DAI），以及走真实 `TornadoRouter` / `RelayerRegistry` 的 DAO 路径：paymaster 作为新注册的 master、以及作为一个真实已注册 relayer 的 worker，每笔提现都从质押里烧掉 TORN。Sepolia 上 DAO 没部署 router，所以上面的实网记录是直接调用池子。

## Relayer 运营者怎么接

```bash
# 1. 部署一次 paymaster（owner key），并存入 EntryPoint 押金
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<你的签名地址> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. 把 paymaster 登记进 DAO（主网部署时加 TORNADO_ROUTER=0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b）
#    a) 作为你现有 relayer 的 worker——用 master 地址调用，不用新质押：
#       RelayerRegistry.registerWorker(<你的 master>, <paymaster>)      然后下面配 REWARD_ACCOUNT=<你的 master>
#    b) 作为新的 relayer master——把一个 ENS 名字的 owner 设成 paymaster、给它转 ≥ minStakeAmount 的 TORN，然后：
#       paymaster.registerAsRelayer(<RelayerRegistry>, "you.eth", <stake>)

# 3. 在现有 relayer 旁边跑签名服务
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS、RELAYER_PRIVATE_KEY、TORNADO_INSTANCES、SERVICE_FEE_BPS、PRICE_SOURCE、REWARD_ACCOUNT
pnpm start                            # :8787 上的 JSON-RPC（pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status）
```

paymaster 接了 router 却没登记、或 `REWARD_ACCOUNT` 与 registry 里解析出的 master 不一致时，服务会拒绝启动；`tornado_status` 会报告模式、剩余质押和每个池子每笔要烧的 TORN。

收益：worker 模式下用户照旧付固定手续费到你的 master 地址，paymaster 的 EntryPoint 押金出 gas，你从收入里补；master 模式下每笔提现 paymaster 留下 `实际 gas × (1 + 加成) + 服务费`、多余的退给用户，ETH 手续费自动存回 EntryPoint，ERC-20 手续费留在合约里，由运营者定期提取换成 ETH。

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
(cd contracts && forge install && forge test)                    # paymaster 单测
pnpm --filter @tornado-4337/relayer test                          # relayer 单测
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 主网 fork：ETH + DAI 全流程、Router / RelayerRegistry 烧 TORN（master + worker）
pnpm --filter @tornado-4337/kohaku-integration setup && pnpm --filter @tornado-4337/kohaku-integration e2e   # 真实 Kohaku SDK，Sepolia fork
```

## 目录

| 路径 | |
| --- | --- |
| `contracts/` | `TornadoRelayerPaymaster.sol`（verifying paymaster，EntryPoint v0.8）、`SwapAndSupplyZap.sol` |
| `relayer/` | 签名服务 |
| `client/` | 参考钱包流程、证明生成、e2e 测试台（anvil fork + alto） |
| `kohaku-integration/` | `@kohaku-eth/tornado-cash` 与 `kohaku-cli` 的补丁、Kohaku e2e |

## 信任模型与限制

- paymaster 信任 relayer 的链下检查（这也是验证便宜、无需质押的原因）；被赞助的操作若在链上回滚，gas 由 relayer 承担，靠签名前的模拟把这种情况压到最低。
- relayer 决定赞不赞助，bundler 决定收不收；钱包应支持多个 bundler。
- `relayWithdraw` 只接受 note 的收款人调用，别人拿不到你的证明来烧你的质押；registry 本身也会拒绝 worker 替错误的 master 转发（`only relayer`）。
- DAO 没部署 router 的链（Sepolia）上 paymaster 直接调用池子，不烧 TORN。
- 主网 USDC/USDT 池已被发行方冻结，可用的 ERC-20 池是 DAI、cDAI、WBTC。
- nullifier 锁在内存里，多实例 relayer 需要共享存储。
