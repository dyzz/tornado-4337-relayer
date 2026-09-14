import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
const POOL = '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b';
const ev = parseAbiItem('event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)');
const rpcs = ['https://ethereum-sepolia-rpc.publicnode.com','https://sepolia.gateway.tenderly.co','https://rpc.sepolia.ethpandaops.io','https://ethereum-sepolia.blockpi.network/v1/rpc/public','https://rpc2.sepolia.org','https://sepolia.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161'];
const HEAD = 11700236n;
for (const [i, url] of rpcs.entries()) {
  for (const chunk of [5000n, 1000n]) {
    if (i > 0 && chunk === 1000n) continue;
    const client = createPublicClient({ chain: sepolia, transport: http(url, { timeout: 30_000, retryCount: 1 }) });
    let count = 0, errs = 0; const t0 = Date.now();
    try {
      for (let start = 11067999n; start <= HEAD; start += chunk) {
        const end = start + chunk > HEAD ? HEAD : start + chunk;
        try { const logs = await client.getLogs({ address: POOL, event: ev, fromBlock: start, toBlock: end }); count += logs.length; } catch (e) { errs++; }
      }
      console.log(url, 'chunk', chunk, '-> logs', count, 'errors', errs, `${((Date.now()-t0)/1000).toFixed(0)}s`);
    } catch (e) { console.log(url, 'FAILED', String(e).slice(0, 80)); }
  }
}
