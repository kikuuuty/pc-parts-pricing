import { localGateway } from './gateway-local';

const args = process.argv.slice(2);
const index = args.indexOf('--fixture');
const mf = await localGateway(args.includes('--rpc'), index < 0 ? 'fresh-complete' : args[index + 1]);
console.log(`Local Gateway: ${await mf.ready} (synthetic ${args.includes('--rpc') ? 'real Pricing RPC + D1/Queue' : 'mock RPC'}; Ctrl+C to stop; data is ephemeral)`);
let stopping = false;
const stop = async () => { if (!stopping) { stopping = true; await mf.dispose(); } };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
