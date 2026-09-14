import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';
import { mimcHasherAbi, mimcHasherBytecode } from './hasher.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

export function forgeArtifact(project: 'contracts' | 'contracts-tornado', file: string, name: string): ForgeArtifact {
  const path = join(ROOT, project, 'out', file, `${name}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ForgeArtifact;
  } catch {
    throw new Error(`missing forge artifact ${path}; run \`forge build\` in ${project}/`);
  }
}

type Signer = WalletClient & { account: NonNullable<WalletClient['account']> };

async function deploy(
  wallet: Signer,
  publicClient: PublicClient,
  artifact: ForgeArtifact,
  args: unknown[],
  value = 0n,
): Promise<Address> {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
    value,
    chain: wallet.chain,
    account: wallet.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deployment produced no address');
  return receipt.contractAddress;
}

/**
 * Deploy a MiMC hasher for fresh Tornado instances: the circomlibjs sponge
 * (3-argument ABI) behind a shim exposing the legacy `MiMCSponge(uint256,uint256)`
 * the instance contracts call. Returns the shim address.
 */
export async function deployMimcHasher(wallet: Signer, publicClient: PublicClient): Promise<Address> {
  const inner = await deploy(
    wallet,
    publicClient,
    { abi: mimcHasherAbi, bytecode: { object: mimcHasherBytecode() } },
    [],
  );
  const shim = forgeArtifact('contracts-tornado', 'MiMCHasherShim.sol', 'MiMCHasherShim');
  return deploy(wallet, publicClient, shim, [inner]);
}

/** Deploy a fresh ETHTornado (tornado-core) bound to an existing Groth16 verifier. */
export async function deployEthTornado(
  wallet: Signer,
  publicClient: PublicClient,
  params: { verifier: Address; hasher: Address; denomination: bigint; levels?: number },
): Promise<Address> {
  const artifact = forgeArtifact('contracts-tornado', 'ETHTornado.sol', 'ETHTornado');
  return deploy(wallet, publicClient, artifact, [
    params.verifier,
    params.hasher,
    params.denomination,
    params.levels ?? 20,
  ]);
}

export async function deployPaymaster(
  wallet: Signer,
  publicClient: PublicClient,
  params: { entryPoint: Address; verifyingSigner: Address; gasMarginBps: bigint; postOpGasOverhead: bigint },
): Promise<Address> {
  const artifact = forgeArtifact('contracts', 'TornadoRelayerPaymaster.sol', 'TornadoRelayerPaymaster');
  return deploy(wallet, publicClient, artifact, [
    params.entryPoint,
    params.verifyingSigner,
    params.gasMarginBps,
    params.postOpGasOverhead,
  ]);
}

export async function deployZap(
  wallet: Signer,
  publicClient: PublicClient,
  params: { weth: Address; swapRouter: Address; aavePool: Address },
): Promise<Address> {
  const artifact = forgeArtifact('contracts', 'SwapAndSupplyZap.sol', 'SwapAndSupplyZap');
  return deploy(wallet, publicClient, artifact, [params.weth, params.swapRouter, params.aavePool]);
}
