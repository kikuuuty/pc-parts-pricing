import type { Identifier, ProductRef } from '../pricing/model';
import { RefreshError, retryAfter } from '../providers/errors';
import { boundedJson, object, withTimeout } from '../providers/http';

export interface Catalog { identifiers(ref: ProductRef): Promise<Identifier[] | null> }
export class CatalogClient implements Catalog {
  constructor(private binding: Pick<Fetcher, 'fetch'>, private timeoutMs = 5000) {}

  async identifiers(ref: ProductRef): Promise<Identifier[] | null> {
    // Numeric ID lives only between resolve and detail. The durable pair must
    // match again after detail (a catalog rebuild can race these two requests).
    // Queue messages structurally extend ProductRef; never forward their metadata.
    const productRef = { source: ref.source, upstream_key: ref.upstream_key };
    const resolved = await this.request('/v1/products/resolve', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: [productRef] }) });
    if (!object(resolved) || !Array.isArray(resolved.products) || resolved.products.length !== 1)
      throw new RefreshError('catalog_invalid');
    const product = resolved.products[0];
    if (!object(product) || product.source !== ref.source || product.upstream_key !== ref.upstream_key)
      throw new RefreshError('catalog_invalid');
    if (product.status === 'missing' || product.status === 'inactive') return null;
    if (product.status !== 'active' || product.active !== true || !Number.isSafeInteger(product.id) || (product.id as number) <= 0)
      throw new RefreshError('catalog_invalid');
    const detail = await this.request(`/v1/products/${product.id}`);
    if (detail === null) return null;
    if (!object(detail) || detail.source !== ref.source || detail.upstream_key !== ref.upstream_key ||
      detail.id !== product.id || !Array.isArray(detail.identifiers) || detail.identifiers.length > 256)
      throw new RefreshError('catalog_invalid');
    const identifiers: Identifier[] = [];
    for (const item of detail.identifiers) {
      if (!object(item) || typeof item.type !== 'string' || typeof item.value !== 'string' ||
        typeof item.region !== 'string' || (item.origin !== undefined && typeof item.origin !== 'string') ||
        (item.origins !== undefined && (!Array.isArray(item.origins) ||
          !item.origins.every(o => object(o) && typeof o.origin === 'string')))) throw new RefreshError('catalog_invalid');
      identifiers.push(item as unknown as Identifier);
    }
    return identifiers;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    try {
      return await withTimeout(async signal => {
        // Service binding fetch, never a public Internet fallback. Origin is
        // stable to preserve Catalog's origin-keyed detail cache.
        const response = await this.binding.fetch(`https://catalog.internal${path}`, { ...init, signal, redirect: 'manual' });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 404 && !init) return null;
          throw new RefreshError('catalog_unavailable', response.status === 429 ? retryAfter(response) : 30);
        }
        return boundedJson(response);
      }, this.timeoutMs);
    } catch (error) {
      if (error instanceof RefreshError && error.reason === 'catalog_unavailable') throw error;
      throw new RefreshError('catalog_unavailable');
    }
  }
}
