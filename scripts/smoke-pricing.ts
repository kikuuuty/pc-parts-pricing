import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { refKey, uniqueRefs, validateProducts, type ProductRef, type ProductSummary } from '../src/pricing/model';
import type { PricingRpc } from '../src/pricing/contracts';

// Test limits, NOT backend RPC limits. Never split excess input into batches.
export const LIMITS = Object.freeze({ products: 10, polls: 8, minInterval: 10_000,
  maxInterval: 30_000, duration: 180_000, call: 10_000 });
export const TARGET = Object.freeze({ account: 'ac7e9239a1eb4f0c95b2558dc6298eb5',
  service: 'pc-parts-pricing', environment: 'production' });
export interface Options { production: boolean; confirm?: string; polls: number;
  intervalMs: number; durationMs: number; duplicatePending: boolean }
interface Session { rpc: Pick<PricingRpc, 'getPriceSummaries'>; dispose(): Promise<void> }
interface Dependencies { connect(): Promise<Session>; now(): number; sleep(ms: number): Promise<void>;
  emit(event: Record<string, unknown>): void }
function fail(code: string): never { throw new Error(code); }
export function validate(input: unknown, options: Options): ProductRef[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.products) fail('INVALID_TARGETS');
  const refs = validateProducts(input);
  if (uniqueRefs(refs).length !== refs.length) fail('DUPLICATE_TARGETS');
  for (const [value, min, max] of [[options.polls, 0, LIMITS.polls],
    [options.intervalMs, LIMITS.minInterval, LIMITS.maxInterval], [options.durationMs, 1000, LIMITS.duration]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_LIMITS');
  }
  if (options.production && options.confirm !== `${TARGET.service}@${TARGET.account}`) fail('CONFIRM_REQUIRED');
  return refs;
}
async function bounded<T>(work: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) fail('TIME_LIMIT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIME_LIMIT')), ms);
  })]); } finally { clearTimeout(timer); }
}
function summaries(value: unknown, refs: ProductRef[]): ProductSummary[] {
  const result = value as Awaited<ReturnType<PricingRpc['getPriceSummaries']>>;
  if (!result || result.ok !== true || !Array.isArray(result.data) || result.data.length !== refs.length) fail('RPC_FAILED');
  for (const [i, p] of result.data.entries()) {
    const s = p?.providers?.yahoo;
    if (!p || refKey(p) !== refKey(refs[i]) || !s || s.provider !== 'yahoo' ||
      !['complete', 'empty', 'unsupported', 'pending', 'missing'].includes(s.status) || typeof s.stale !== 'boolean') fail('INVALID_RESPONSE');
  }
  return result.data;
}
const waiting = (rows: ProductSummary[]) => rows.some(p => p.providers.yahoo.status === 'pending' ||
  (['complete', 'empty'].includes(p.providers.yahoo.status) && p.providers.yahoo.stale));

export async function runSmoke(input: unknown, options: Options, deps: Dependencies): Promise<string> {
  const refs = validate(input, options);
  deps.emit({ event: 'plan', mode: options.production ? 'production' : 'dry-run', ...TARGET,
    products: refs.length, rpc: 'getPriceSummaries', maxCalls: 1 + options.polls + Number(options.duplicatePending),
    intervalMs: options.intervalMs, durationMs: options.durationMs,
    effects: 'may touch D1, enqueue interactive work and trigger Yahoo; no requestRefresh' });
  // In particular: do not import Wrangler, authenticate or start a remote proxy here.
  if (!options.production) return 'dry-run';
  const deadline = deps.now() + options.durationMs;
  let session: Session | undefined, closed = false;
  const left = () => Math.min(LIMITS.call, deadline - deps.now());
  try {
    session = await bounded(async () => {
      const connected = await deps.connect();
      if (closed) { await connected.dispose(); fail('TIME_LIMIT'); }
      return connected;
    }, left());
    let calls = 0;
    const read = async () => {
      // Any connection/RPC/429/config error stops immediately; never retry it.
      const rows = summaries(await bounded(() => session!.rpc.getPriceSummaries(refs), left()), refs);
      deps.emit({ event: 'summary', call: ++calls,
        states: rows.map(p => {
          const { status, stale, lowest_price, offer_count, fetched_at, expires_at } = p.providers.yahoo;
          return { status, stale, lowest_price, offer_count, fetched_at, expires_at };
        }) });
      return rows;
    };
    let rows = await read();
    if (options.duplicatePending && rows.some(p => p.providers.yahoo.status === 'pending')) rows = await read();
    for (let poll = 0; waiting(rows) && poll < options.polls; poll++) {
      if (deadline - deps.now() <= options.intervalMs) return 'time-limit';
      await bounded(() => deps.sleep(options.intervalMs), deadline - deps.now());
      rows = await read();
    }
    // A terminal RPC response alone does NOT establish real Yahoo success.
    return waiting(rows) ? 'pending-or-stale-at-limit' : 'responses-terminal-observation-required';
  } finally {
    closed = true;
    if (session) await bounded(() => session!.dispose(), 5000);
  }
}

async function connectProduction(): Promise<Session> {
  const directory = resolve('.local/production-verification');
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, `caller-${process.pid}.json`);
  // Caller-side development config only. Never deploy this or change Pricing bindings.
  await writeFile(configPath, JSON.stringify({ name: 'pricing-verification-local', account_id: TARGET.account,
    compatibility_date: '2026-09-26', workers_dev: false, preview_urls: false,
    services: [{ binding: 'PRICING', service: TARGET.service, remote: true }] }));
  try {
    const { getPlatformProxy } = await import('wrangler');
    const platform = await getPlatformProxy<{ PRICING: Session['rpc'] }>({ configPath, persist: false,
      envFiles: [], remoteBindings: true });
    return { rpc: platform.env.PRICING, dispose: async () => {
      try { await platform.dispose(); } finally { await rm(configPath, { force: true }); }
    } };
  } catch { await rm(configPath, { force: true }); fail('CONNECTION_FAILED'); }
}
export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { targets: { type: 'string' }, production: { type: 'boolean' },
    confirm: { type: 'string' }, polls: { type: 'string' }, 'interval-seconds': { type: 'string' },
    'duration-seconds': { type: 'string' }, 'duplicate-pending': { type: 'boolean' } }, strict: true });
  if (!values.targets) fail('TARGETS_REQUIRED');
  if ((await stat(values.targets)).size > 8192) fail('INPUT_TOO_LARGE');
  const text = await readFile(values.targets, 'utf8');
  if (Buffer.byteLength(text) > 8192) fail('INPUT_TOO_LARGE');
  const input: unknown = JSON.parse(text);
  const options: Options = { production: !!values.production, confirm: values.confirm,
    polls: Number(values.polls ?? 8), intervalMs: Number(values['interval-seconds'] ?? 10) * 1000,
    durationMs: Number(values['duration-seconds'] ?? 120) * 1000, duplicatePending: !!values['duplicate-pending'] };
  validate(input, options);
  // Hard process bound also covers a stuck Wrangler startup/cleanup. It cannot cancel
  // already admitted server work; stopping this client does not purge Queue messages.
  const watchdog = options.production ? setTimeout(() => {
    console.error('{"event":"stopped","reason":"TIME_LIMIT"}'); process.exit(2);
  }, options.durationMs) : undefined;
  try {
    const outcome = await runSmoke(input, options, { connect: connectProduction, now: Date.now,
      sleep: ms => new Promise(done => setTimeout(done, ms)), emit: e => console.log(JSON.stringify(e)) });
    console.log(JSON.stringify({ event: 'finished', outcome }));
    if (outcome === 'time-limit' || outcome === 'pending-or-stale-at-limit') process.exitCode = 2;
  } finally { clearTimeout(watchdog); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Never print exception text, RPC errors, input, URLs, headers or credentials.
    console.error('{"event":"stopped","reason":"VALIDATION_OR_CONNECTION_OR_RPC_FAILED"}'); process.exitCode = 1;
  });
}
