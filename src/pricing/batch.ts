import { chunks, RPC_CHUNK_SIZE } from '../config';
import { refKey, uniqueRefs, validateProducts, type ProductRef, type ProductSummary } from './model';

export interface PricingBatchRpc {
  summaries(products: ProductRef[]): Promise<ProductSummary[]>;
  refresh(products: ProductRef[]): Promise<{ enqueued: number }>;
  seed(products: ProductRef[]): Promise<{ registered: number }>;
  syncDefaults(): Promise<{ synced: number; failed: number }>;
}

// Validate the whole input before any side effect, dedupe across chunk boundaries,
// and restore order/duplicates only at the caller boundary. Child RPCs bound the
// D1 work per invocation; this is not a UI/gateway request-size rule.
export async function batchSummaries(input: unknown, rpc: PricingBatchRpc): Promise<ProductSummary[]> {
  const products = validateProducts(input), rows = new Map<string, ProductSummary>();
  for (const part of chunks(uniqueRefs(products), RPC_CHUNK_SIZE)) {
    for (const row of await rpc.summaries(part)) rows.set(refKey(row), row);
  }
  return products.map(ref => rows.get(refKey(ref))!);
}
export async function batchWrite(input: unknown, rpc: PricingBatchRpc, method: 'refresh' | 'seed'): Promise<number> {
  const products = uniqueRefs(validateProducts(input));
  let count = 0;
  for (const part of chunks(products, RPC_CHUNK_SIZE)) {
    if (method === 'refresh') count += (await rpc.refresh(part)).enqueued;
    else count += (await rpc.seed(part)).registered;
  }
  return count;
}
