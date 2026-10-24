import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type InspectionInput, type Policy } from '../../src/categories';
import { createRecordedClassifier } from '../../src/classifier/recorded';
import { inspect } from '../../src/pipeline';
import { inspectForHubExtraction } from '../../src/hub';

const ALL: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const NONE: Policy = { selectedCategories: [], rules: [] };
const deps = { classifier: createRecordedClassifier() };

function input(bodyText: string, over: Partial<InspectionInput> = {}): InspectionInput {
  return {
    kind: 'email',
    subject: 'Notes',
    bodyText,
    headers: { from: 'Anna Kowalska <anna@friends.example>' },
    folders: [],
    ownAddresses: ['me@voicespark.test'],
    ...over,
  };
}

async function accepted(i: InspectionInput, policy: Policy = ALL, d = deps) {
  const r = await inspectForHubExtraction(i, policy, d);
  if (r.excluded) throw new Error(`unexpected exclusion: ${r.category}`);
  return r;
}

describe('inspectForHubExtraction: contacts', () => {
  it('keeps emails and phones when third_party_contacts is selected, unlike normal mode', async () => {
    const body = 'Contact Jan at jan.kowalski@acme.example or on +48 601 234 567.';
    const normal = await inspect(input(body), ALL, deps);
    expect(normal.text).not.toContain('jan.kowalski@acme.example');
    const hub = await accepted(input(body));
    expect(hub.text).toContain('jan.kowalski@acme.example');
    expect(hub.text).toContain('+48 601 234 567');
    expect(hub.counts.find((c) => c.category === 'third_party_contacts')).toBeUndefined();
    expect(hub.redactedValues).toBe(0);
  });

  it('keeps the From address even when third_party_contacts is selected', async () => {
    const hub = await accepted(input('Hello.'));
    expect(hub.text).toContain('anna@friends.example');
  });
});

describe('inspectForHubExtraction: everything else behaves as in normal mode', () => {
  it('redacts a password next to an email', async () => {
    const hub = await accepted(input('Hi,\nlogin: jan@acme.example / password: Xk9mQ2vLp7\nThanks'));
    expect(hub.text).toContain('jan@acme.example');
    expect(hub.text).not.toContain('Xk9mQ2vLp7');
    expect(hub.counts).toContainEqual({ category: 'passwords', redactedValues: 1, wholeItem: false });
    expect(hub.redactedValues).toBe(1);
  });

  it('redacts a reset link next to an address and a token in a signature', async () => {
    const reset = await accepted(
      input('Write to jan@acme.example. Reset: https://accounts.acme.example/reset-password?token=GGXXvg2SRXJUCkKIUDrEZ00BDS4kpD4O'),
    );
    expect(reset.text).toContain('jan@acme.example');
    expect(reset.text).not.toContain('GGXXvg2SRXJUCkKIUDrEZ00BDS4kpD4O');
    const token = await accepted(
      input('Regards,\nJan\njan@acme.example\ntoken: ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU'),
    );
    expect(token.text).toContain('jan@acme.example');
    expect(token.text).not.toContain('ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU');
  });

  it('excludes the whole item for an OTP message and keeps the reason', async () => {
    const r = await inspectForHubExtraction(
      input('Call me on +48 601 234 567. Your verification code is 482913. It expires in 10 minutes.'),
      ALL,
      deps,
    );
    expect(r).toEqual({ excluded: true, category: 'otp_codes' });
  });

  it('excludes credential delivery as a whole item', async () => {
    const r = await inspectForHubExtraction(
      input(
        'Hello,\n\nAn account has been created for you on Northwind Cloud. Your temporary password is:\nQgCzt15!qM\nYou will be asked to change it at first sign-in.\n\nNorthwind Cloud',
        { subject: 'Your temporary password', headers: { from: 'Northwind Cloud <do-not-reply@northwind-cloud.example>' } },
      ),
      ALL,
      deps,
    );
    expect(r).toEqual({ excluded: true, category: 'passwords' });
  });

  it('redacts cards, IBANs and government ids, and a phone beside a card stays only as written', async () => {
    const card = await accepted(input('Card number: 4195 4147 2233 9041 (expires 07/30). Call +48 601 234 567.'));
    expect(card.text).not.toContain('4195 4147 2233 9041');
    expect(card.text).not.toContain('4195');
    expect(card.counts.map((c) => c.category)).toContain('payment_cards');
    const iban = await accepted(input('IBAN: DE57771707652489594255'));
    expect(iban.text).not.toContain('DE57771707652489594255');
    const pesel = await accepted(input('PESEL: 77081952528'));
    expect(pesel.text).not.toContain('77081952528');
  });

  it('keeps a phone inside a redacted card span redacted', async () => {
    // The card digits also parse as a phone number; contacts being skipped must not reveal them.
    const hub = await accepted(input('Card number: 4195 4147 2233 9041 end.'));
    expect(hub.text).not.toMatch(/4147|2233|9041/);
  });

  it('keeps an email inside a user:pass@ URL redacted', async () => {
    const hub = await accepted(input('Use https://jan@acme.example:Sup3rS3cret@files.acme.example/x to log in.'));
    expect(hub.text).not.toContain('Sup3rS3cret');
    const plain = await accepted(input('Also ftp://deploy:Sup3rS3cret99@files.acme.example/'));
    expect(plain.text).not.toContain('Sup3rS3cret99');
  });

  it('applies locked categories even when no category is selected', async () => {
    const hub = await accepted(input('Mail jan@acme.example. token: ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU'), NONE);
    expect(hub.text).toContain('jan@acme.example');
    expect(hub.text).not.toContain('ghp_8hJuQoN86WVSTAZKtlDIlSNJuELijmlyWdyU');
  });

  it('still applies the classifier postal-address sense when selected', async () => {
    const classifier = createRecordedClassifier({
      spans: [{ category: 'third_party_contacts', text: 'ul. Lipowa 12/4, 00-950 Warszawa' }],
      mostlySensitive: false,
    });
    const hub = await accepted(
      input('Send it to ul. Lipowa 12/4, 00-950 Warszawa or mail jan@acme.example.'),
      ALL,
      { classifier },
    );
    expect(hub.text).not.toContain('Lipowa');
    expect(hub.text).toContain('jan@acme.example');
    expect(hub.counts.find((c) => c.category === 'third_party_contacts')?.redactedValues).toBe(1);
  });

  it('applies exclusion rules', async () => {
    const bySender = await inspectForHubExtraction(
      input('Hello', { headers: { from: 'Anna <anna@friends.example>' } }),
      { selectedCategories: [], rules: [{ type: 'sender', value: 'anna@friends.example' }] },
      deps,
    );
    expect(bySender).toEqual({ excluded: true, category: 'user_rule' });
    const byKeyword = await inspectForHubExtraction(
      input('this is sensitive'),
      { selectedCategories: [], rules: [{ type: 'keyword', value: 'sensitive' }] },
      deps,
    );
    expect(byKeyword).toEqual({ excluded: true, category: 'user_rule' });
  });
});

describe('inspectForHubExtraction: fail closed', () => {
  it('returns inspection_failed when the classifier throws', async () => {
    const classifier = {
      classify: async () => {
        throw new Error('boom');
      },
    };
    const r = await inspectForHubExtraction(input('Hello'), ALL, { classifier });
    expect(r).toEqual({ excluded: true, category: 'inspection_failed' });
  });

  it('returns inspection_failed on timeout and never throws', async () => {
    const classifier = { classify: () => new Promise<never>(() => undefined) };
    const r = await inspectForHubExtraction(input('Hello'), ALL, { classifier, timeoutMs: 20 });
    expect(r).toEqual({ excluded: true, category: 'inspection_failed' });
  });
});
