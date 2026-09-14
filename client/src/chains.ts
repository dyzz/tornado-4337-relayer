import type { Address } from 'viem';
import { mainnet, sepolia, type Chain } from 'viem/chains';

/** Per-chain addresses used by the demo flow and the e2e harness. */
export interface ChainSetup {
  chain: Chain;
  entryPoint: Address;
  simple7702Implementation: Address;
  /** Canonical Tornado ETH instances (denomination -> address). */
  tornadoEth: Record<string, Address>;
  /** Canonical Tornado ERC-20 instances (label -> address). */
  tornadoErc20: Record<string, Address>;
  /** ERC-20 used by the ERC-20 demo (an Aave reserve); `balanceSlot` lets a fork mint it via storage. */
  demoErc20: { address: Address; symbol: string; decimals: number; denomination: bigint; balanceSlot?: number; whale?: Address };
  /** Groth16 verifier shared by the ETH instances (used for fresh deployments on forks). */
  tornadoVerifier: Address;
  /** MiMC hasher, when the chain's instances expose one (else deploy from circomlibjs). */
  tornadoHasher?: Address;
  weth: Address;
  /** WETH accepted by the Aave market when it differs from the canonical WETH (Sepolia mocks). */
  aaveWeth?: Address;
  uniswapSwapRouter02: Address;
  aavePool: Address;
  /** Token the demo swaps into and supplies to Aave, with the Uniswap V3 fee tier of its WETH pool. */
  demoTokenOut: { address: Address; symbol: string; uniswapFee: number };
  publicRpc: string;
  pimlicoPublicBundler: string;
}

export const ENTRY_POINT_V08: Address = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
export const SIMPLE_7702_IMPLEMENTATION: Address = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';

export const CHAINS: Record<'mainnet' | 'sepolia', ChainSetup> = {
  mainnet: {
    chain: mainnet,
    entryPoint: ENTRY_POINT_V08,
    simple7702Implementation: SIMPLE_7702_IMPLEMENTATION,
    tornadoEth: {
      '0.1': '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
      '1': '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936',
      '10': '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF',
      '100': '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291',
    },
    tornadoErc20: {
      'dai-100': '0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3',
      'dai-1000': '0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144',
      'dai-10000': '0x07687e702b410Fa43f4cB4Af7FA097918ffD2730',
      'dai-100000': '0x23773E65ed146A459791799d01336DB287f25334',
      'wbtc-0.1': '0x178169B423a011fff22B9e3F3abeA13414dDD0F1',
      'wbtc-1': '0x610B717796ad172B316836AC95a2ffad065CeaB4',
      'wbtc-10': '0xbB93e510BbCD0B7beb5A853875f9eC60275CF498',
    },
    demoErc20: {
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      symbol: 'DAI',
      decimals: 18,
      denomination: 100n * 10n ** 18n,
      balanceSlot: 2,
    },
    tornadoVerifier: '0xce172ce1F20EC0B3728c9965470eaf994A03557A',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    uniswapSwapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    demoTokenOut: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', uniswapFee: 500 },
    publicRpc: 'https://ethereum-rpc.publicnode.com',
    pimlicoPublicBundler: 'https://public.pimlico.io/v2/1/rpc',
  },
  sepolia: {
    chain: sepolia,
    entryPoint: ENTRY_POINT_V08,
    simple7702Implementation: SIMPLE_7702_IMPLEMENTATION,
    tornadoEth: {
      '0.1': '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b',
      '1': '0x8cc930096B4Df705A007c4A039BDFA1320Ed2508',
    },
    tornadoErc20: {
      'dai-100': '0x6921fd1a97441dd603a997ED6DDF388658daf754',
    },
    demoErc20: {
      address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
      symbol: 'DAI',
      decimals: 18,
      denomination: 100n * 10n ** 18n,
      whale: '0xc0dEC722b431c02a0787F349587B783A0f2F3281',
    },
    tornadoVerifier: '0xAE523682eB597e057acA3dC009161a122656F00e',
    tornadoHasher: '0x20bc314FC55345d74235731B6C0Cd57ede6cdF2F',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    aaveWeth: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c',
    uniswapSwapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
    aavePool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    // Aave's Sepolia DAI is also the token behind the DAI/WETH 0.05% pool Kohaku's tests use.
    demoTokenOut: { address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357', symbol: 'DAI', uniswapFee: 500 },
    // publicnode's Sepolia log index is incomplete (drops ~half the Tornado Deposit logs); tenderly and
    // rpc.sepolia.ethpandaops.io return complete eth_getLogs results.
    publicRpc: 'https://sepolia.gateway.tenderly.co',
    pimlicoPublicBundler: 'https://public.pimlico.io/v2/11155111/rpc',
  },
};
