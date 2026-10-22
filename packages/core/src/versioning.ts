export interface DiffEntry {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isKeyed = (v: unknown): v is Record<string, unknown> =>
  isObject(v) && typeof v.key === 'string';

/** Arrays whose items all carry a string `key` (definition dimensions) are matched by it, not by index. */
const keyedArray = (a: unknown[]): boolean => a.length > 0 && a.every(isKeyed);

function join(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffInto(a: unknown, b: unknown, path: string, out: DiffEntry[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (keyedArray(a) && keyedArray(b)) {
      const byKeyA = new Map(a.map((v) => [(v as { key: string }).key, v]));
      const byKeyB = new Map(b.map((v) => [(v as { key: string }).key, v]));
      for (const [k, v] of byKeyA) {
        const p = `${path}[${k}]`;
        if (!byKeyB.has(k)) out.push({ path: p, op: 'removed', before: v });
        else diffInto(v, byKeyB.get(k), p, out);
      }
      for (const [k, v] of byKeyB) {
        if (!byKeyA.has(k)) out.push({ path: `${path}[${k}]`, op: 'added', after: v });
      }
      return;
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, op: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: p, op: 'removed', before: a[i] });
      else diffInto(a[i], b[i], p, out);
    }
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = join(path, k);
      if (!(k in b)) out.push({ path: p, op: 'removed', before: a[k] });
      else if (!(k in a)) out.push({ path: p, op: 'added', after: b[k] });
      else diffInto(a[k], b[k], p, out);
    }
    return;
  }
  if (!same(a, b)) out.push({ path, op: 'changed', before: a, after: b });
}

/** Structural JSON diff: objects by key, arrays by index (arrays of `{ key }` items matched by that key). */
export function jsonDiff(a: unknown, b: unknown, path = ''): DiffEntry[] {
  const out: DiffEntry[] = [];
  diffInto(a, b, path, out);
  return out;
}
