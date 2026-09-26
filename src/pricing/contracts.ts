import type { ProductRef, ProductSummary } from './model';

export type RpcResult<T> = { ok: true; data: T }
  | { ok: false; error: { code: 'INVALID_REQUEST' | 'PRICING_UNAVAILABLE' } };

/** Plain-data contract for callers; no runtime dependency on the Worker bundle. */
export interface PricingRpc {
  getPriceSummaries(products: ProductRef[]): Promise<RpcResult<ProductSummary[]>>;
  requestRefresh(products: ProductRef[]): Promise<RpcResult<{ enqueued: number }>>;
}

export interface PricingAdminRpc {
  seedWarmup(products: ProductRef[]): Promise<RpcResult<{ registered: number }>>;
}
