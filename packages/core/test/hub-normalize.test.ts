import { describe, expect, it } from 'vitest';
import { hmacHex } from '../src/crypto';
import { factFingerprint, markerKey } from '../src/hub/fingerprint';
import { FREE_MAIL_DOMAINS, ROLE_LOCAL_PARTS } from '../src/hub/lists';
import {
  addressHash,
  companyMatchName,
  foldName,
  isFreeMailDomain,
  isRoleAddress,
  matchHash,
  matchKey,
  nameKey,
  normalizeDomain,
  normalizeWebsite,
  projectMatchName,
} from '../src/hub/normalize';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

const U = '11111111-1111-1111-1111-111111111111';
const V = '22222222-2222-2222-2222-222222222222';

describe('names', () => {
  it('foldName lower-cases, trims and folds diacritics', () => {
    expect(foldName('  Łódź ')).toBe('lodz');
    expect(foldName('Żółć GĘŚLĄ')).toBe('zolc gesla');
  });

  it('companyMatchName strips legal suffixes', () => {
    for (const s of ['sp. z o.o.', 'S.A.', 'sp.k.', 'sp.j.', 's.c.', 'Ltd', 'Limited', 'LLC', 'Inc', 'GmbH', 'AG', 'BV', 'PLC', 'Corp', 'Co']) {
      expect(companyMatchName(`Acme ${s}`)).toBe('acme');
    }
    expect(companyMatchName('Acme, Inc.')).toBe('acme');
    expect(companyMatchName('Zażółć Sp. z o.o.')).toBe('zazolc');
    expect(companyMatchName('Acme Corporation')).toBe('acme corporation');
  });

  it('projectMatchName strips leading project, projekt, the', () => {
    expect(projectMatchName('Project Phoenix')).toBe('phoenix');
    expect(projectMatchName('Projekt Łódź')).toBe('lodz');
    expect(projectMatchName('The Phoenix')).toBe('phoenix');
    expect(projectMatchName('Phoenix project')).toBe('phoenix project');
  });

  it('nameKey is the HMAC of hubname:{uid}:{kind}:{lower(trim(name))}', () => {
    expect(nameKey(U, 'person', '  Jan Kowalski ')).toBe(hmacHex(`hubname:${U}:person:jan kowalski`));
    expect(nameKey(U, 'person', 'Jan')).not.toBe(nameKey(V, 'person', 'Jan'));
    expect(nameKey(U, 'person', 'Jan')).not.toBe(nameKey(U, 'company', 'Jan'));
    expect(nameKey(U, 'person', 'Łódź')).not.toBe(nameKey(U, 'person', 'Lodz'));
  });

  it('matchKey ignores diacritics, legal suffixes and project prefixes', () => {
    expect(matchKey(U, 'person', 'Łukasz Żółć')).toBe(matchKey(U, 'person', 'lukasz zolc'));
    expect(matchKey(U, 'company', 'Acme Sp. z o.o.')).toBe(matchKey(U, 'company', 'ACME'));
    expect(matchKey(U, 'project', 'The Phoenix')).toBe(matchKey(U, 'project', 'phoenix'));
    expect(matchKey(U, 'company', 'Acme')).not.toBe(matchKey(V, 'company', 'Acme'));
    expect(matchKey(U, 'company', 'Acme')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('addresses', () => {
  it('addressHash is the HMAC of the lower-cased address', () => {
    expect(addressHash(' Jan@Acme.com ')).toBe(hmacHex('jan@acme.com'));
  });

  it('matchHash strips a +tag', () => {
    expect(matchHash('jan+x@acme.com')).toBe(matchHash('jan@acme.com'));
    expect(matchHash('Jan+x@Acme.com')).toBe(hmacHex('jan@acme.com'));
    expect(addressHash('jan+x@acme.com')).not.toBe(addressHash('jan@acme.com'));
    expect(matchHash('jan@acme.com')).not.toBe(matchHash('ann@acme.com'));
  });
});

describe('domains and websites', () => {
  it('normalizeDomain lower-cases and removes www.', () => {
    expect(normalizeDomain(' WWW.Acme.COM ')).toBe('acme.com');
    expect(normalizeDomain('sub.acme.co.uk')).toBe('sub.acme.co.uk');
    expect(normalizeDomain('acme')).toBeNull();
    expect(normalizeDomain('ac me.com')).toBeNull();
    expect(normalizeDomain('-acme.com')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('normalizeWebsite turns a bare domain into https and keeps http(s) URLs', () => {
    expect(normalizeWebsite('acme.com')).toBe('https://acme.com/');
    expect(normalizeWebsite('http://acme.com/path')).toBe('http://acme.com/path');
    expect(normalizeWebsite('https://www.acme.com')).toBe('https://www.acme.com/');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('ftp://acme.com')).toBeNull();
    expect(normalizeWebsite('not a url')).toBeNull();
  });
});

describe('lists', () => {
  it('has 46 role local parts', () => {
    expect(ROLE_LOCAL_PARTS.size).toBe(46);
    for (const p of ['info', 'office', 'sales', 'biuro', 'kontakt']) expect(ROLE_LOCAL_PARTS.has(p)).toBe(true);
  });

  it('isRoleAddress matches the local part, ignoring case and +tag', () => {
    expect(isRoleAddress('info@acme.com')).toBe(true);
    expect(isRoleAddress('Biuro@acme.pl')).toBe(true);
    expect(isRoleAddress('sales+eu@acme.com')).toBe(true);
    expect(isRoleAddress('jan.kowalski@acme.com')).toBe(false);
    expect(isRoleAddress('information@acme.com')).toBe(false);
  });

  it('has about 38 free-mail entries', () => {
    expect(FREE_MAIL_DOMAINS.size).toBeGreaterThanOrEqual(36);
    expect(FREE_MAIL_DOMAINS.size).toBeLessThanOrEqual(40);
  });

  it('isFreeMailDomain handles exact entries and wildcards', () => {
    for (const d of ['gmail.com', 'GMAIL.com', 'wp.pl', 'onet.pl', 'hotmail.com', 'hotmail.pl', 'yahoo.co.uk', 'live.fr', 'gmx.de', 'acme.onmicrosoft.com']) {
      expect(isFreeMailDomain(d), d).toBe(true);
    }
    for (const d of ['acme.com', 'gmail.com.evil.io', 'onmicrosoft.com', 'mygmail.com', 'hotmail']) {
      expect(isFreeMailDomain(d), d).toBe(false);
    }
  });
});

describe('fingerprints and marker keys', () => {
  it('factFingerprint is the HMAC of hubfact:{userId}:{type}:{target}:{value}', () => {
    expect(factFingerprint(U, 'person_email', 'person:abc', ' Jan@Acme.com ')).toBe(
      hmacHex(`hubfact:${U}:person_email:person:abc:jan@acme.com`),
    );
    expect(factFingerprint(U, 'company', 't', 'v')).not.toBe(factFingerprint(V, 'company', 't', 'v'));
  });

  it('marker keys are HMACs of the documented key strings', () => {
    expect(markerKey.personEmail('Jan@Acme.com')).toBe(hmacHex('person:email:jan@acme.com'));
    expect(markerKey.companyDomain('acme.com')).toBe(hmacHex('company:domain:acme.com'));
    expect(markerKey.companyName('Acme')).toBe(hmacHex('company:name:acme'));
    expect(markerKey.projectName('Phoenix')).toBe(hmacHex('project:name:phoenix'));
    expect(markerKey.link('person_company', 'a', 'b')).toBe(hmacHex('link:person_company:a:b'));
    expect(markerKey.field('person', 'id1', 'role', 'CEO')).toBe(hmacHex(`field:person:id1:role:${hmacHex('ceo')}`));
    const fp = factFingerprint(U, 'company', 't', 'v');
    expect(markerKey.fact(fp)).toBe(hmacHex(`fact:${fp}`));
  });
});
