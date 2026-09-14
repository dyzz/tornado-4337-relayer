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
- Tornado pool contracts and the circuit are untouched — the proof simply names your paymaster as `relayer`;
- no custody, no user keys, no bundler to run, no mempool to babysit.

## How a withdrawal works

1. The wallet asks the relayer for a quote and puts the quoted fee into the ZK proof (`relayer = paymaster`).
2. The wallet builds a UserOperation: `withdraw` → (swap) → `Aave.supply`, all from a fresh EIP-7702 account.
3. The relayer checks the proof, root, nullifier and fee, simulates the whole operation, and signs.
4. The wallet sends the signed operation to a bundler (Pimlico in the demo, but any bundler works).
5. On-chain: the paymaster's signature is verified, the pool pays the fee to the paymaster, the tail calls run,
   and `postOp` keeps actual gas + margin + service fee and **refunds the rest** to the user.

If any step of the tail reverts, the withdrawal reverts with it. Nothing leaves the pool.

## Live run on Sepolia

Driven end to end by the Kohaku CLI wallet (patched to talk to the relayer), bundled by Pimlico's public endpoint.

| | |
| --- | --- |
| Paymaster | [`0xA05e1201…6E94`](https://sepolia.etherscan.io/address/0xA05e12016882b2FE01A080b04F5D2F6FC3AC6E94) |
| Shield 0.1 ETH (Kohaku wallet) | [`0x14c3daaa…73ac`](https://sepolia.etherscan.io/tx/0x14c3daaa20829573465c0c5a96b6eb5fbcbae42a114b8dfedf9c93c5496e73ac) |
| Unshield → wrap → Aave, one transaction | [`0x5d61d705…7000`](https://sepolia.etherscan.io/tx/0x5d61d705186b06381a29c23a272c7aba92a15b2cb6012c8548105524b41b7000) |
| Fee bound in the proof / actual gas / refund | 0.00238 ETH / 0.00093 ETH / 0.00103 ETH |
| Landed in the wallet | 0.09762 aWETH |
| Paymaster deposit | 0.05 → 0.050417 ETH |

Mainnet-fork tests cover ETH (swap → aUSDC) and ERC-20 pools (DAI → aDAI, fee paid and refunded in DAI).

## For relayer operators

```bash
# 1. deploy the paymaster once (owner key) and give it an EntryPoint deposit
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<your signing address> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. run the signing service next to your existing relayer
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS, RELAYER_PRIVATE_KEY, TORNADO_INSTANCES, SERVICE_FEE_BPS, PRICE_SOURCE
pnpm start                            # JSON-RPC on :8787 (pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status)
```

Economics: the paymaster keeps `actual gas × (1 + margin) + service fee` per withdrawal and re-deposits ETH fees
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
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # mainnet fork: ETH + DAI flows
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
- Withdrawals call the pool directly for now; routing through `TornadoRouter` so the paymaster acts as a registered
  relayer worker (TORN burn, registry accounting) is the next step.
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
- Tornado 池合约和电路不动，证明里的 `relayer` 字段填你的 paymaster 地址即可；
- 不托管资金、不碰用户私钥、不跑 bundler、不维护 mempool。

## 一笔提现的流程

1. 钱包向 relayer 要报价，把报价的 fee 写进 ZK 证明（`relayer = paymaster`）。
2. 钱包组装 UserOperation：`withdraw` →（swap）→ `Aave.supply`，全部由一个新的 EIP-7702 账户执行。
3. relayer 检查证明、root、nullifier、fee，模拟整笔操作，然后签名。
4. 钱包把签好的操作发给 bundler（演示用 Pimlico，任何 bundler 都行）。
5. 链上：验证 paymaster 签名 → 池子把 fee 付给 paymaster → 执行尾调用 → `postOp` 留下实际 gas + 加成 + 服务费，**差价退给用户**。

尾调用任何一步失败，提现一起回滚，资金不会离开池子。

## Sepolia 实网记录

由 Kohaku CLI 钱包（打了对接 relayer 的补丁）全程驱动，Pimlico 公共 bundler 打包。

| | |
| --- | --- |
| Paymaster | [`0xA05e1201…6E94`](https://sepolia.etherscan.io/address/0xA05e12016882b2FE01A080b04F5D2F6FC3AC6E94) |
| Kohaku 钱包存入 0.1 ETH | [`0x14c3daaa…73ac`](https://sepolia.etherscan.io/tx/0x14c3daaa20829573465c0c5a96b6eb5fbcbae42a114b8dfedf9c93c5496e73ac) |
| 提现 → wrap → Aave，一笔交易 | [`0x5d61d705…7000`](https://sepolia.etherscan.io/tx/0x5d61d705186b06381a29c23a272c7aba92a15b2cb6012c8548105524b41b7000) |
| 证明中的 fee / 实际 gas / 退款 | 0.00238 ETH / 0.00093 ETH / 0.00103 ETH |
| 钱包收到 | 0.09762 aWETH |
| Paymaster 押金 | 0.05 → 0.050417 ETH |

主网 fork 测试覆盖 ETH 池（swap → aUSDC）和 ERC-20 池（DAI → aDAI，手续费和退款都是 DAI）。

## Relayer 运营者怎么接

```bash
# 1. 部署一次 paymaster（owner key），并存入 EntryPoint 押金
cd contracts && PRIVATE_KEY=0x… RELAYER_SIGNER=0x<你的签名地址> DEPOSIT_WEI=100000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# 2. 在现有 relayer 旁边跑签名服务
cd relayer && cp .env.example .env    # PAYMASTER_ADDRESS、RELAYER_PRIVATE_KEY、TORNADO_INSTANCES、SERVICE_FEE_BPS、PRICE_SOURCE
pnpm start                            # :8787 上的 JSON-RPC（pm_getPaymasterStubData / pm_getPaymasterData / tornado_quote / tornado_status）
```

收益：每笔提现 paymaster 留下 `实际 gas × (1 + 加成) + 服务费`；ETH 手续费自动存回 EntryPoint，ERC-20 手续费留在合约里，由运营者定期提取换成 ETH。

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
MAINNET_RPC_URL=… pnpm --filter @tornado-4337/client e2e          # 主网 fork：ETH + DAI 全流程
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
- 目前提现直接调用池子；改走 `TornadoRouter`、让 paymaster 作为注册 relayer 的 worker（烧 TORN、登记进 registry）是下一步。
- 主网 USDC/USDT 池已被发行方冻结，可用的 ERC-20 池是 DAI、cDAI、WBTC。
- nullifier 锁在内存里，多实例 relayer 需要共享存储。
