import { hmacHex } from '../crypto';
import { FREE_MAIL_DOMAINS, ROLE_LOCAL_PARTS } from './lists';

export type HubNameKind = 'person' | 'company' | 'project';

const COMPANY_SUFFIXES = [
  'sp z oo', 'sp k', 'sp j', 'spk', 'spj', 'sa', 'sc', 'ltd', 'limited', 'llc', 'inc', 'gmbh', 'ag', 'bv', 'plc', 'corp', 'co',
];
const PROJECT_PREFIXES = ['project', 'projekt', 'the'];
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-case, trim, diacritics folded (`Łódź` -> `lodz`), whitespace collapsed. */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/ł/gi, 'l')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Folded name with trailing legal suffixes (`sp. z o.o.`, `inc`, ...) removed. */
export function companyMatchName(name: string): string {
  let s = foldName(name).replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** Folded name with leading `project`, `projekt`, `the` removed. */
export function projectMatchName(name: string): string {
  let s = foldName(name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const prefix of PROJECT_PREFIXES) {
      if (s.startsWith(`${prefix} `)) {
        s = s.slice(prefix.length + 1).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

/** HMAC of the exact (lower-cased, trimmed) name, per user and kind. */
export function nameKey(userId: string, kind: HubNameKind, name: string): string {
  return hmacHex(`hubname:${userId}:${kind}:${name.trim().toLowerCase()}`);
}

/** HMAC of the kind-specific folded name, used for extraction matching. */
export function matchKey(userId: string, kind: HubNameKind, name: string): string {
  const folded = kind === 'company' ? companyMatchName(name) : kind === 'project' ? projectMatchName(name) : foldName(name);
  return hmacHex(`hubmatch:${userId}:${kind}:${folded}`);
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Address with a `+tag` removed from the local part. */
export function stripPlusTag(address: string): string {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf('@');
  if (at < 0) return a;
  const local = a.slice(0, at).split('+')[0] ?? '';
  return `${local}${a.slice(at)}`;
}

export function addressHash(address: string): string {
  return hmacHex(normalizeAddress(address));
}

export function matchHash(address: string): string {
  return hmacHex(stripPlusTag(address));
}

/** Lower-case, `www.` removed; null when not a valid domain name. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^www\./, '');
  return DOMAIN_RE.test(d) ? d : null;
}

/** http(s) URL; a bare domain becomes `https://domain`. Null when invalid. */
export function normalizeWebsite(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!normalizeDomain(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function isRoleAddress(address: string): boolean {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf('@');
  const local = (at < 0 ? a : a.slice(0, at)).split('+')[0] ?? '';
  return ROLE_LOCAL_PARTS.has(local);
}

export function isFreeMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  if (FREE_MAIL_DOMAINS.has(d)) return true;
  const dot = d.indexOf('.');
  if (dot <= 0 || dot === d.length - 1) return false;
  if (FREE_MAIL_DOMAINS.has(`${d.slice(0, dot)}.*`)) return true;
  for (let i = dot; i !== -1; i = d.indexOf('.', i + 1)) {
    if (FREE_MAIL_DOMAINS.has(`*${d.slice(i)}`)) return true;
  }
  return false;
}
