import { WorkerEntrypoint } from 'cloudflare:workers';
import { config, type Variables } from './config';
import { CatalogClient } from './catalog/client';
import { PricingService } from './pricing/service';
import type { RefreshMessage } from './pricing/model';
import type { PricingRpc, PricingAdminRpc, RpcResult } from './pricing/contracts';
import { SummaryStore } from './storage/summaries';
import { YahooBudget } from './storage/budget';
import { YahooProvider } from './providers/yahoo/service';
import { Enqueuer } from './queue/enqueue';
import { Consumer } from './queue/consumer';
import { schedule } from './scheduler/cron';
import { log } from './telemetry';

export interface Env extends Variables {
  DB: D1Database;
  REFRESH_QUEUE: Queue<RefreshMessage>;
  CATALOG: Fetcher;
  YAHOO_SHOPPING_APP_ID?: string;
}
function services(env: Env) {
  const cfg = config(env), store = new SummaryStore(env.DB);
  const enqueue = new Enqueuer(store, env.REFRESH_QUEUE, cfg, log);
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
    return boundary(() => services(this.env).pricing.getPriceSummaries(products, task => this.ctx.waitUntil(task)));
  }
  async requestRefresh(products: unknown) {
    return boundary(() => services(this.env).pricing.requestRefresh(products));
  }
  fetch() { return new Response('Not Found', { status: 404 }); }

  async queue(batch: MessageBatch<unknown>) {
    try {
      const { cfg, store } = services(this.env);
      const provider = new YahooProvider(cfg, this.env.YAHOO_SHOPPING_APP_ID,
        new YahooBudget(this.env.DB, cfg, log), log, caches.default);
      const consumer = new Consumer(store, new CatalogClient(this.env.CATALOG), provider, log);
      for (const message of batch.messages) {
        try { await consumer.process(message.body); message.ack(); }
        catch { log({ event: 'queue', queue_result: 'retry' }); message.retry({ delaySeconds: 180 }); }
      }
    } catch {
      log({ event: 'queue', queue_result: 'retry' });
      batch.retryAll({ delaySeconds: 180 });
    }
  }

  async scheduled() {
    try {
      const { cfg, store, enqueue } = services(this.env);
      await schedule(store, enqueue, cfg, log);
    } catch { log({ event: 'scheduler', queue_result: 'error' }); }
  }
}

// Bind only from an operator/ingestion Worker, never the public gateway.
export class PricingAdmin extends WorkerEntrypoint<Env> implements PricingAdminRpc {
  async seedWarmup(products: unknown) {
    return boundary(() => services(this.env).pricing.seedWarmup(products));
  }
  fetch() { return new Response('Not Found', { status: 404 }); }
}
