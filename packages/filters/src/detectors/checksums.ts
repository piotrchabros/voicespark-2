/** Checksum and structure validators. All accept spaces and dashes as separators. */

function compact(s: string): string {
  return s.replace(/[\s-]/g, '');
}

function digitsOnly(s: string): number[] | null {
  const c = compact(s);
  return /^\d+$/.test(c) ? [...c].map(Number) : null;
}

/** Luhn (mod 10) check over a digit string. */
export function luhnValid(d: string): boolean {
  const digits = digitsOnly(d);
  if (!digits || digits.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let v = digits[digits.length - 1 - i]!;
    if (i % 2 === 1) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN: country code, check digits, 11-30 char BBAN, mod-97 === 1. */
export function ibanValid(s: string): boolean {
  const c = compact(s).toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(c)) return false;
  const rearranged = c.slice(4) + c.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** Polish NRB: 26 digits, validated as the IBAN `PL` + NRB. */
export function nrbValid(s: string): boolean {
  const c = compact(s);
  return /^\d{26}$/.test(c) && ibanValid(`PL${c}`);
}

/** US ABA routing number: 9 digits, weights 3-7-1. */
export function abaValid(s: string): boolean {
  const d = digitsOnly(s);
  if (!d || d.length !== 9) return false;
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

/** PESEL: 11 digits, weighted checksum, plausible month (century-encoded). */
export function peselValid(s: string): boolean {
  const d = digitsOnly(s);
  if (!d || d.length !== 11) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = weights.reduce((acc, w, i) => acc + w * d[i]!, 0);
  if ((10 - (sum % 10)) % 10 !== d[10]) return false;
  const month = (d[2]! * 10 + d[3]!) % 20;
  const day = d[4]! * 10 + d[5]!;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** German Steuer-ID: 11 digits, no leading zero, ISO 7064 MOD 11,10 check digit. */
export function steuerIdValid(s: string): boolean {
  const d = digitsOnly(s);
  if (!d || d.length !== 11 || d[0] === 0) return false;
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (d[i]! + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = 11 - product === 10 ? 0 : 11 - product;
  return check === d[10];
}

/** US SSN structure: area not 000/666/900-999, group not 00, serial not 0000. */
export function ssnValid(s: string): boolean {
  const c = compact(s);
  if (!/^\d{9}$/.test(c)) return false;
  const area = Number(c.slice(0, 3));
  const group = Number(c.slice(3, 5));
  const serial = Number(c.slice(5));
  return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0;
}

const NINO_BANNED_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

/** UK National Insurance number: two prefix letters, six digits, suffix A-D. */
export function ninoValid(s: string): boolean {
  const c = compact(s).toUpperCase();
  if (!/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(c)) return false;
  return !NINO_BANNED_PREFIXES.has(c.slice(0, 2));
}
