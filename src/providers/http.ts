import { RefreshError } from './errors';

export async function boundedJson(response: Response, maxBytes = 262144): Promise<unknown> {
  if (!response.body) throw new RefreshError('invalid_json');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new RefreshError('malformed_response');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new RefreshError('invalid_json'); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RefreshError('timeout')); }, timeoutMs);
  });
  try { return await Promise.race([timeout, work(controller.signal)]); }
  catch (error) {
    if (controller.signal.aborted) throw new RefreshError('timeout');
    if (error instanceof RefreshError) throw error;
    throw new RefreshError('network');
  } finally { clearTimeout(timer); }
}

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
