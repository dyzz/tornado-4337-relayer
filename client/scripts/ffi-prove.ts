// Foundry ffi helper: create a fresh note for a pool, build the merkle path against the committed
// leaf fixture (plus this note at `nextIndex`), prove the withdrawal, and print one ABI-encoded line:
//   (bytes32 commitment, bytes32 root, bytes32 nullifierHash, bytes proof)
// Args: <leaves.json.gz> <forkBlock> <nextIndex> <recipient> <relayer> <feeWei>
import { createReadStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { encodeAbiParameters, toHex } from 'viem';

import { loadArtifacts } from '../src/artifacts.js';
import { merklePath } from '../src/merkle.js';
import { commitmentHex, createNote, nullifierHashHex } from '../src/note.js';
import { createTornadoProver } from '../src/prover.js';

const [leavesFile, forkBlockArg, nextIndexArg, recipient, relayer, feeArg] = process.argv.slice(2);
if (!leavesFile || !forkBlockArg || !nextIndexArg || !recipient || !relayer || feeArg === undefined) {
  throw new Error('usage: ffi-prove <leaves.json.gz> <forkBlock> <nextIndex> <recipient> <relayer> <feeWei>');
}
if (!existsSync(leavesFile)) throw new Error(`missing ${leavesFile}`);

const chunks: Buffer[] = [];
await pipeline(createReadStream(leavesFile), createGunzip(), async function* (src) {
  for await (const c of src) chunks.push(c as Buffer);
});
const cache = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { leaves: string[]; leafBlocks?: string[] };
const forkBlock = BigInt(forkBlockArg);
const nextIndex = Number(nextIndexArg);
// Only leaves deposited by the fork block exist on the fork.
let keep = cache.leaves.length;
if (cache.leafBlocks) {
  keep = 0;
  while (keep < cache.leafBlocks.length && BigInt(cache.leafBlocks[keep]!) <= forkBlock) keep++;
}
cache.leaves = cache.leaves.slice(0, keep);
if (cache.leaves.length !== nextIndex) {
  throw new Error(`leaf fixture has ${cache.leaves.length} leaves at block ${forkBlock} but the pool's nextIndex is ${nextIndex}`);
}

const note = createNote();
const leaves = [...cache.leaves, note.commitment.toString()];
const path = merklePath(leaves, note.commitment);
const { circuit, provingKey } = await loadArtifacts();
const prover = await createTornadoProver(circuit, provingKey);
const proof = await prover.prove({
  nullifier: note.nullifier,
  secret: note.secret,
  pathElements: path.pathElements,
  pathIndices: path.pathIndices,
  root: path.root,
  nullifierHash: note.nullifierHash,
  recipient: BigInt(recipient),
  relayer: BigInt(relayer),
  fee: BigInt(feeArg),
  refund: 0n,
});
process.stdout.write(
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes' }],
    [commitmentHex(note), toHex(path.root, { size: 32 }), nullifierHashHex(note), proof.proof],
  ),
);
// The prover keeps worker threads alive; exit explicitly so ffi returns.
process.exit(0);
