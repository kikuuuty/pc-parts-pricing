import type { Identifier } from '../../pricing/model';
export interface Candidate { strategy: 'jan' | 'ean13_as_jan'; value: string }
export const MAX_CANDIDATES = 3;
function validCheckDigit(code: string): boolean {
  if (/^0+$/.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight)
    sum += (code.charCodeAt(i) - 48) * weight;
  return (10 - sum % 10) % 10 === code.charCodeAt(code.length - 1) - 48;
}
export function validJan(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9]{8}|[0-9]{13})$/.test(value.trim()) && validCheckDigit(value.trim());
}
export function validEan13(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{13}$/.test(value) && validCheckDigit(value);
}
export function candidates(identifiers: Identifier[]): Candidate[] {
  const eligible = identifiers.filter(i => ['jp', 'all'].includes(i.region) &&
    (i.type === 'jan' ? validJan(i.value) : i.type === 'ean' && validEan13(i.value)));
  const local = (i: Identifier) => (i.origins ?? [i]).some(o => o.origin === 'local') ? 0 : 1;
  eligible.sort((a, b) => Number(a.type !== 'jan') - Number(b.type !== 'jan') ||
    Number(a.region !== 'jp') - Number(b.region !== 'jp') || local(a) - local(b) ||
    (a.value.trim() < b.value.trim() ? -1 : a.value.trim() > b.value.trim() ? 1 : 0));
  const seen = new Set<string>();
  return eligible.flatMap(i => {
    const value = i.type === 'jan' ? i.value.trim() : i.value;
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ strategy: i.type === 'jan' ? 'jan' as const : 'ean13_as_jan' as const, value }];
  }).slice(0, MAX_CANDIDATES);
}
