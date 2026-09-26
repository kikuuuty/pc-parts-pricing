import { WorkerEntrypoint } from 'cloudflare:workers';
import { config, RPC_CHUNK_SIZE, type Variables } from './config';
import { CatalogClient } from './catalog/client';
import { PricingService } from './pricing/service';
import { laneFor, validateMessage, validateProducts, type RefreshMessage } from './pricing/model';
import { batchSummaries, batchWrite, type PricingBatchRpc } from './pricing/batch';
import type { PricingRpc, PricingAdminRpc, RpcResult } from './pricing/contracts';
import { SummaryStore } from './storage/summaries';
import { YahooBudget } from './storage/budget';
import { YahooProvider } from './providers/yahoo/service';
import { Enqueuer } from './queue/enqueue';
import { Consumer } from './queue/consumer';
import { schedule } from './scheduler/cron';
import { DefaultWarmup } from './scheduler/defaults';
import { log } from './telemetry';

export interface Env extends Variables {
  DB: D1Database;
  REFRESH_QUEUE: Queue<RefreshMessage>;
  INTERACTIVE_QUEUE: Queue<RefreshMessage>;
  PRICING_BATCH: PricingBatchRpc;
  CATALOG: Fetcher;
  YAHOO_SHOPPING_APP_ID?: string;
}
function services(env: Env) {
  const cfg = config(env), store = new SummaryStore(env.DB);
  const enqueue = new Enqueuer(store, env.REFRESH_QUEUE, cfg, log, Date.now, env.INTERACTIVE_QUEUE);
  return { cfg, store, enqueue, pricing: new PricingService(store, enqueue, cfg, log) };
}
async function boundary<T>(work: () => Promise<T>): Promise<RpcResult<T>> {
  try { return { ok: true, data: await work() }; }
  catch (error) {
    return { ok: false, error: { code: error instanceof Error && error.message === 'INVALID_REQUEST'
      ? 'INVALID_REQUEST' : 'PRICING_UNAVAILABLE' } };
  }
}

export default class PricingWorker extends WorkerEntrypoint<Env> implements PricingRpc {
  async getPriceSummaries(products: unknown) {
    return boundary(() => batchSummaries(products, this.env.PRICING_BATCH));
  }
  async requestRefresh(products: unknown) {
    return boundary(async () => ({ enqueued: await batchWrite(products, this.env.PRICING_BATCH, 'refresh') }));
  }
  fetch() { return new Response('Not Found', { status: 404 }); }

  async queue(batch: MessageBatch<unknown>) {
    try {
      const { cfg, store } = services(this.env);
      for (const message of batch.messages) {
        let body: RefreshMessage;
        try { body = validateMessage(message.body); }
        catch { log({ event: 'queue', queue_result: 'invalid' }); message.ack(); continue; }
        const provider = new YahooProvider(cfg, this.env.YAHOO_SHOPPING_APP_ID,
          new YahooBudget(this.env.DB, cfg, log, Date.now, undefined, laneFor(body.reason)), log, caches.default);
        const consumer = new Consumer(store, new CatalogClient(this.env.CATALOG), provider, log);
        try { await consumer.process(body); message.ack(); }
        catch { log({ event: 'queue', queue_result: 'retry' }); message.retry({ delaySeconds: 360 }); }
      }
    } catch {
      log({ event: 'queue', queue_result: 'retry' });
      batch.retryAll({ delaySeconds: 360 });
    }
  }

  async scheduled() {
    try {
      const { cfg, store, enqueue } = services(this.env);
      try { await this.env.PRICING_BATCH.syncDefaults(); }
      catch { log({ event: 'scheduler', queue_result: 'error' }); }
      await schedule(store, enqueue, cfg, log);
    } catch { log({ event: 'scheduler', queue_result: 'error' }); }
  }
}

// Bind only from an operator/ingestion Worker, never the public gateway.
export class PricingAdmin extends WorkerEntrypoint<Env> implements PricingAdminRpc {
  async seedWarmup(products: unknown) {
    return boundary(async () => ({ registered: await batchWrite(products, this.env.PRICING_BATCH, 'seed') }));
  }
  async syncDefaultWarmup() {
    return boundary(() => this.env.PRICING_BATCH.syncDefaults());
  }
  fetch() { return new Response('Not Found', { status: 404 }); }
}

// Self Service Binding: each execution has a bounded D1 query workload. Never
// bind this entrypoint to the public gateway. No additional Worker is deployed.
export class PricingBatch extends WorkerEntrypoint<Env> implements PricingBatchRpc {
  private products(input: unknown) {
    const products = validateProducts(input);
    if (products.length > RPC_CHUNK_SIZE) throw new Error('INVALID_REQUEST');
    return products;
  }
  async summaries(input: unknown) {
    return services(this.env).pricing.getPriceSummaries(this.products(input), task => this.ctx.waitUntil(task));
  }
  async refresh(input: unknown) { return services(this.env).pricing.requestRefresh(this.products(input)); }
  async seed(input: unknown) { return services(this.env).pricing.seedWarmup(this.products(input)); }
  async syncDefaults() {
    const { store, cfg } = services(this.env);
    const result = await new DefaultWarmup(store, new CatalogClient(this.env.CATALOG), cfg).sync();
    log({ event: 'scheduler', reason: 'default_warmup', count: result.synced,
      queue_result: result.failed ? 'error' : 'saved' });
    return result;
  }
  fetch() { return new Response('Not Found', { status: 404 }); }
}
