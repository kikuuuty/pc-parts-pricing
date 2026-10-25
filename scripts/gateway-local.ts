// Local-only driver. Never imported by either deployed Worker. No credentials,
// persistence, remote bindings or live Catalog/Provider access are used.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import type { ProductRef } from '../src/pricing/model';
import { INITIAL_CONFIG, readGatewayConfig } from './gateway-config';

export async function localGateway(rpc: boolean, fixture = 'fresh-complete', port = 8788) {
  // Deliberately independent of production origins, enable flag and limits.
  const config = readGatewayConfig(INITIAL_CONFIG, 'initial');
  const fixtures = JSON.parse(readFileSync('test/fixtures/gateway-http.json', 'utf8'));
  if (!fixtures[fixture]?.ok && fixture !== '503') throw new Error('Unknown fixture (429 uses the native limiter, not RPC)');
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })).outputFiles[0].text;
  const [gateway, pricing] = await Promise.all([bundle('src/gateway/worker.ts'), rpc ? bundle('src/worker.ts') : Promise.resolve('')]);
  const refs: ProductRef[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    port, host: '127.0.0.1', log: new Log(LogLevel.ERROR), cf: false,
    workers: [
      { name: 'pc-parts-pricing-gateway', modules: true, compatibilityDate: config.compatibility_date, script: gateway,
        bindings: { SUMMARY_ENABLED: 'true', ALLOWED_ORIGINS: '["http://localhost:5173","http://127.0.0.1:5173"]' },
        serviceBindings: { PRICING: 'pc-parts-pricing' },
        ratelimits: Object.fromEntries(config.ratelimits.map(r => [r.name, { namespace_id: r.namespace_id, simple: r.simple }])),
        outboundService: () => { throw new Error('No Gateway Internet access'); },
      },
      rpc ? { name: 'pc-parts-pricing', modules: true, compatibilityDate: config.compatibility_date, script: pricing,
        d1Databases: { DB: 'local-gateway-only' },
        queueProducers: { REFRESH_QUEUE: 'local-background', INTERACTIVE_QUEUE: 'local-interactive' },
        queueConsumers: { 'local-background': { maxBatchSize: 1, maxBatchTimeout: 0 }, 'local-interactive': { maxBatchSize: 1, maxBatchTimeout: 0 } },
        bindings: { YAHOO_SHOPPING_APP_ID: 'synthetic-not-a-secret' },
        serviceBindings: { PRICING_BATCH: { name: 'pc-parts-pricing', entrypoint: 'PricingBatch' }, CATALOG: async request => {
          const path = new URL(request.url).pathname;
          if (path.endsWith('/resolve')) {
            const { products } = await request.json() as { products: ProductRef[] };
            return MFResponse.json({ products: products.map(ref => {
              let id = refs.findIndex(r => r.source === ref.source && r.upstream_key === ref.upstream_key);
              if (id < 0) { id = refs.length; refs.push(ref); }
              return { ...ref, id: id + 1, active: true, status: 'active' };
            }) });
          }
          const id = Number(path.split('/').at(-1));
          if (!refs[id - 1]) throw new Error('Unexpected mock Catalog call');
          return MFResponse.json({ ...refs[id - 1], id, identifiers: [{ type: 'jan', value: '0012345678905', region: 'all' }] });
        } },
        outboundService: request => {
          if (new URL(request.url).hostname !== 'shopping.yahooapis.jp') throw new Error('Unexpected outbound call');
          return MFResponse.json({ totalResultsAvailable: 1, totalResultsReturned: 1, hits: [{ janCode: '0012345678905',
            code: 'mock_item', name: 'Synthetic test only', url: 'https://example.test/item', price: 57800,
            seller: { sellerId: 'mock', name: 'Synthetic' }, inStock: true, condition: 'new' }] });
        },
      } : { name: 'pc-parts-pricing', modules: true, compatibilityDate: config.compatibility_date,
        bindings: { FIXTURE: fixtures[fixture] },
        script: `import { WorkerEntrypoint } from 'cloudflare:workers';
          export default class extends WorkerEntrypoint {
            async getPriceSummaries(refs) {
              const f = this.env.FIXTURE;
              return f.ok ? { ok: true, data: refs.map(ref => ({ ...ref, providers: f.data[0].providers })) } : f;
            }
          }`,
      },
    ],
  }));
  try {
    await mf.ready;
    if (rpc) {
      const db = await mf.getD1Database('DB', 'pc-parts-pricing');
      const sql = ['0001_pricing.sql', '0002_demand_warmup.sql', '0003_provider_recovery.sql']
        .map(file => readFileSync(`migrations/${file}`, 'utf8')).join('\n');
      await db.batch(sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
    }
    return mf;
  } catch (error) { await mf.dispose(); throw error; }
}
