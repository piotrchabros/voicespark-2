import { describe, expect, it } from 'vitest';
import { FILTER_CATEGORY_KEYS, type Classifier, type Policy } from '@voicespark/filters';
import { createFakeLlm, LlmRefusedError, type LlmClient, type ParseStructuredArgs } from '@voicespark/integrations/anthropic';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';

const { loadEnv } = await import('../src/env');
const { hubExtractionSchema, hubTriageSchema } = await import('../src/hub/extraction-schema');
const { HUB_EXTRACTION_PROMPT_V1, HUB_EXTRACTION_PROMPT_VERSION, HUB_TRIAGE_PROMPT } = await import('../src/hub/prompts');
const { createFakeGenerationLlm, FAKE_HUB_FIXTURES, FAKE_HUB_SWITCHES, fakeHubMarker } = await import('../src/prompting');
const {
  EMPTY_IGNORE_RULES,
  HubExtractionError,
  extract,
  ignoreRuleHash,
  inspectExtractionOutputs,
  inspectThreadForExtraction,
  selectParticipants,
  shouldTriage,
  toPromptParticipants,
  triage,
} = await import('../src/services/hub/extraction');
type Extraction = import('../src/hub/extraction-schema').HubExtraction;
type Parts = import('../src/hub/prompts').HubExtractionParts;
type CallRecord = import('../src/services/hub/extraction').HubLlmCallRecord;
type InspectMessage = import('../src/services/hub/extraction').HubInspectMessage;

const CTX = { userId: '11111111-1111-4111-8111-111111111111', threadId: '22222222-2222-4222-8222-222222222222' };
const OWNER = 'anna@owner.example';
const POLICY: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const CLEAN: Classifier = { classify: async () => ({ spans: [], mostlySensitive: false }) };
const BROKEN: Classifier = {
  classify: async () => {
    throw new Error('classifier down');
  },
};
const PERSON_ID = '6f1c2a40-0000-4000-8000-000000000001';
const COMPANY_ID = '6f1c2a40-0000-4000-8000-0000000000c1';

function recorder(): { rows: CallRecord[]; recordCall: (row: CallRecord) => Promise<void> } {
  const rows: CallRecord[] = [];
  return { rows, recordCall: async (row) => void rows.push(row) };
}

/** A client that records every call's arguments and answers with `respond`. */
function spyLlm(respond: (args: ParseStructuredArgs<unknown>, call: number) => unknown): {
  llm: LlmClient;
  calls: ParseStructuredArgs<unknown>[];
} {
  const calls: ParseStructuredArgs<unknown>[] = [];
  const inner = createFakeLlm((args) => respond(args, calls.length));
  return {
    calls,
    llm: {
      parseStructured: (args) => {
        calls.push(args as ParseStructuredArgs<unknown>);
        return inner.parseStructured(args);
      },
    },
  };
}

function msg(from: string, to: string, cc = '', automated = false) {
  return { from, to, cc, automated };
}

function inspectMessage(overrides: Partial<InspectMessage> = {}): InspectMessage {
  return {
    subject: 'Oferta na dostawę',
    from: 'Jan Kowalski <jan@acme.example>',
    to: OWNER,
    cc: '',
    body: 'Dzień dobry, proszę o ofertę na dostawę stali.',
    signature: 'Jan Kowalski\nAcme Sp. z o.o.\n+48 601 234 567',
    sentAt: new Date('2026-03-02T10:00:00Z'),
    direction: 'inbound',
    folders: [],
    ...overrides,
  };
}

function parts(marker: string, overrides: Partial<Parts> = {}): Parts {
  return {
    participants: [
      { key: 'P1', name: 'Jan Kowalski', address: 'jan@acme.example', flags: [], sent: true },
      { key: 'P2', name: 'Anna', address: OWNER, flags: ['owner'], sent: false },
    ],
    knownRecords: { people: [], companies: [], projects: [] },
    previousSummary: null,
    attachments: [],
    messages: [
      {
        sentAt: new Date('2026-03-02T10:00:00Z'),
        direction: 'inbound',
        text: `Subject: Oferta\nFrom: Jan Kowalski <jan@acme.example>\n\nDzień dobry ${marker}` as never,
      },
    ],
    ...overrides,
  };
}

function emptyOutput(overrides: Partial<Extraction> = {}): Extraction {
  return { relevant: true, language: 'pl', summary: 'Rozmowa o ofercie.', people: [], companies: [], projects: [], links: [], ...overrides };
}

describe('selectParticipants', () => {
  it('takes From of every message, To of small messages and never CC', () => {
    const many = Array.from({ length: 11 }, (_, i) => `r${i}@big.example`).join(', ');
    const sel = selectParticipants(
      [
        msg('Jan Kowalski <jan@acme.example>', `Anna <${OWNER}>, ola@acme.example`, 'cc.person@acme.example'),
        msg(OWNER, many),
        msg('"Nowak, Piotr" <piotr@beta.example>', OWNER, Array.from({ length: 19 }, (_, i) => `c${i}@x.example`).join(', ')),
      ],
      [OWNER],
      EMPTY_IGNORE_RULES,
    );
    const addresses = sel.participants.map((p) => p.address);
    expect(addresses).toEqual(['jan@acme.example', OWNER, 'ola@acme.example', 'piotr@beta.example']);
    expect(sel.participants.map((p) => p.key)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(sel.participants.find((p) => p.address === 'piotr@beta.example')!.name).toBe('Nowak, Piotr');
    expect(sel.participants.find((p) => p.address === 'jan@acme.example')!.sent).toBe(true);
    expect(sel.participants.find((p) => p.address === 'ola@acme.example')!.sent).toBe(false);
    expect(sel.skip).toBeNull();
  });

  it('drops To of a message with more than 20 To and CC together', () => {
    const cc = Array.from({ length: 20 }, (_, i) => `c${i}@x.example`).join(', ');
    const sel = selectParticipants([msg('jan@acme.example', 'ola@acme.example', cc)], [OWNER], EMPTY_IGNORE_RULES);
    expect(sel.participants.map((p) => p.address)).toEqual(['jan@acme.example']);
  });

  it('flags owner, role address, free mail and automated senders', () => {
    const sel = selectParticipants(
      [
        msg('info@acme.example', 'old@owner-disconnected.example'),
        msg('ola@gmail.com', OWNER),
        msg('no-reply@shop.example', OWNER, '', true),
      ],
      [OWNER, 'OLD@owner-disconnected.example'],
      EMPTY_IGNORE_RULES,
    );
    const by = (a: string) => sel.participants.find((p) => p.address === a)!;
    expect(by('info@acme.example').roleAddress).toBe(true);
    expect(by('old@owner-disconnected.example').owner).toBe(true);
    expect(by(OWNER).owner).toBe(true);
    expect(by('ola@gmail.com').freeMail).toBe(true);
    expect(by('no-reply@shop.example').automated).toBe(true);
    expect(by('ola@gmail.com').automated).toBe(false);
    expect(toPromptParticipants(sel.participants).find((p) => p.address === 'info@acme.example')!.flags).toEqual([
      'role_address',
    ]);
  });

  it('matches ignored addresses and domains with their subdomains', () => {
    const rules = {
      addressHashes: new Set([ignoreRuleHash('address', 'Spam@Other.example')]),
      domainHashes: new Set([ignoreRuleHash('domain', 'acme.example')]),
    };
    const sel = selectParticipants(
      [msg('jan@mail.acme.example', OWNER), msg('spam@other.example', OWNER), msg('ola@notacme.example', OWNER)],
      [OWNER],
      rules,
    );
    const by = (a: string) => sel.participants.find((p) => p.address === a)!;
    expect(by('jan@mail.acme.example').ignored).toBe(true);
    expect(by('spam@other.example').ignored).toBe(true);
    expect(by('ola@notacme.example').ignored).toBe(false);
    expect(sel.skip).toBeNull();
    expect(toPromptParticipants(sel.participants).map((p) => p.address)).toEqual([OWNER, 'ola@notacme.example']);
  });

  it('skips as ignored when every other candidate is ignored, as owner_only when only the owner is left', () => {
    const rules = { addressHashes: new Set<string>(), domainHashes: new Set([ignoreRuleHash('domain', 'acme.example')]) };
    expect(selectParticipants([msg('jan@acme.example', OWNER)], [OWNER], rules).skip).toBe('ignored');
    expect(selectParticipants([msg(OWNER, OWNER)], [OWNER], EMPTY_IGNORE_RULES).skip).toBe('owner_only');
    expect(selectParticipants([msg(OWNER, '')], [OWNER], EMPTY_IGNORE_RULES).skip).toBe('owner_only');
  });
});

describe('shouldTriage', () => {
  const single = selectParticipants([msg('jan@acme.example', OWNER)], [OWNER], EMPTY_IGNORE_RULES);
  const inbound = [{ direction: 'inbound' as const, automatedReason: null }];

  it('runs only with no owner-sent message, one sender, no header flag and an unknown sender', () => {
    expect(shouldTriage(single, inbound, false)).toBe(true);
    expect(shouldTriage(single, inbound, true)).toBe(false);
    expect(shouldTriage(single, [{ direction: 'inbound', automatedReason: 'list_header' }], false)).toBe(false);
    expect(shouldTriage(single, [...inbound, { direction: 'outbound', automatedReason: null }], false)).toBe(false);
    const two = selectParticipants([msg('jan@acme.example', OWNER), msg('ola@acme.example', OWNER)], [OWNER], EMPTY_IGNORE_RULES);
    expect(shouldTriage(two, [...inbound, ...inbound], false)).toBe(false);
    const ownerSent = selectParticipants([msg(OWNER, 'jan@acme.example')], [OWNER], EMPTY_IGNORE_RULES);
    expect(shouldTriage(ownerSent, inbound, false)).toBe(false);
  });

  it('a sender-pattern or label flag is not a header flag', () => {
    expect(shouldTriage(single, [{ direction: 'inbound', automatedReason: 'sender_pattern' }], false)).toBe(true);
    expect(shouldTriage(single, [{ direction: 'inbound', automatedReason: 'gmail_category' }], false)).toBe(true);
  });
});

describe('triage', () => {
  const input = {
    from: 'Shop <hello@shop.example>',
    toCount: 1,
    headerNames: ['return-path'],
    first: inspectMessage({ body: `Twoje zamówienie zostało wysłane. ${'x'.repeat(3000)}`, signature: '' }),
  };
  const deps = (llm: LlmClient, rec = recorder()) => ({ llm, recordCall: rec.recordCall, policy: POLICY, ownAddresses: [OWNER], classifier: CLEAN });

  it('uses the classifier model at low effort and sends at most 1500 chars of the inspected body', async () => {
    const spy = spyLlm(() => ({ kind: 'automated', confidence: 0.9, reason: 'Order notification.' }));
    const rec = recorder();
    expect(await triage(CTX, input, deps(spy.llm, rec))).toBe('automated_llm');
    const args = spy.calls[0]!;
    expect(args.model).toBe(loadEnv().LLM_CLASSIFIER_MODEL);
    expect(args.effort).toBe('low');
    expect(args.system).toBe(HUB_TRIAGE_PROMPT);
    expect(args.schema).toBe(hubTriageSchema);
    expect(args.user).toContain('To count: 1');
    expect(args.user).toContain('Headers: return-path');
    expect(args.user).toContain('Subject: Oferta na dostawę');
    expect(args.user.match(/x/g)!.length).toBeLessThanOrEqual(1500);
    expect(rec.rows).toEqual([
      expect.objectContaining({ purpose: 'triage', model: loadEnv().LLM_CLASSIFIER_MODEL, stopReason: 'end_turn' }),
    ]);
  });

  it('keeps the thread below 0.7 or for a human', async () => {
    expect(await triage(CTX, input, deps(spyLlm(() => ({ kind: 'automated', confidence: 0.69, reason: 'r' })).llm))).toBeNull();
    expect(await triage(CTX, input, deps(spyLlm(() => ({ kind: 'human', confidence: 0.99, reason: 'r' })).llm))).toBeNull();
  });

  it('falls through on any error', async () => {
    const failing: LlmClient = {
      parseStructured: async () => {
        throw Object.assign(new Error('overloaded'), { status: 529 });
      },
    };
    expect(await triage(CTX, input, deps(failing))).toBeNull();
    const refusing: LlmClient = {
      parseStructured: async () => {
        throw new LlmRefusedError();
      },
    };
    expect(await triage(CTX, input, deps(refusing))).toBeNull();
    expect(await triage(CTX, input, { ...deps(spyLlm(() => ({})).llm), classifier: BROKEN })).toBeNull();
  });

  it('answers from the fake LLM triage fixture', async () => {
    const llm = createFakeGenerationLlm();
    expect(await triage(CTX, input, deps(llm))).toBeNull();
    const automated = { ...input, first: inspectMessage({ body: `Newsletter ${fakeHubMarker(FAKE_HUB_SWITCHES.triageAutomated)}` }) };
    expect(await triage(CTX, automated, deps(llm))).toBe('automated_llm');
  });
});

describe('inspectThreadForExtraction', () => {
  const deps = { policy: POLICY, ownAddresses: [OWNER], classifier: CLEAN };

  it('builds prompt messages with the Subject and From lines and keeps contacts', async () => {
    const r = await inspectThreadForExtraction([inspectMessage(), inspectMessage({ sentAt: null, direction: 'outbound', from: OWNER, body: 'Dziękuję.', signature: '' })], deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.text).toContain('Subject: Oferta na dostawę');
    expect(r.messages[0]!.text).toContain('jan@acme.example');
    expect(r.messages[0]!.text).toContain('+48 601 234 567');
    expect(r.messages[1]!.direction).toBe('outbound');
    expect(r.excludedMessages).toBe(0);
  });

  it('shows a repeated signature of the same sender once', async () => {
    const r = await inspectThreadForExtraction([inspectMessage(), inspectMessage({ body: 'Przypominam.' })], deps);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.messages[1]!.text).toContain('[signature as above]');
    expect(r.messages[1]!.text).not.toContain('+48 601 234 567');
  });

  it('drops a wholly excluded message and skips when every message is excluded', async () => {
    const policy: Policy = { ...POLICY, rules: [{ type: 'keyword', value: 'tajne' }] };
    const r = await inspectThreadForExtraction(
      [inspectMessage({ body: 'To jest tajne.' }), inspectMessage({ body: 'Zwykła wiadomość.' })],
      { ...deps, policy },
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.messages).toHaveLength(1);
      expect(r.excludedMessages).toBe(1);
    }
    const all = await inspectThreadForExtraction([inspectMessage({ body: 'tajne' })], { ...deps, policy });
    expect(all).toEqual({ status: 'excluded', excludedMessages: 1 });
  });

  it('fails closed when the inspection cannot complete', async () => {
    await expect(inspectThreadForExtraction([inspectMessage()], { ...deps, classifier: BROKEN })).rejects.toMatchObject({
      code: 'inspection_failed',
    });
  });
});

describe('extract', () => {
  it('calls parseStructured with the extraction model, effort and 16000 tokens and nothing else', async () => {
    const spy = spyLlm(() => emptyOutput());
    const rec = recorder();
    const r = await extract(CTX, parts(''), { llm: spy.llm, recordCall: rec.recordCall });
    expect(r.calls).toBe(1);
    const args = spy.calls[0]!;
    expect(Object.keys(args).sort()).toEqual(['effort', 'maxTokens', 'model', 'schema', 'system', 'user']);
    expect(args.model).toBe(loadEnv().LLM_HUB_EXTRACTION_MODEL);
    expect(args.effort).toBe(loadEnv().LLM_HUB_EXTRACTION_EFFORT);
    expect(args.maxTokens).toBe(16000);
    expect(args.system).toBe(HUB_EXTRACTION_PROMPT_V1);
    expect(args.schema).toBe(hubExtractionSchema);
    expect(args.user).toContain('<participants>');
    expect(rec.rows).toHaveLength(1);
    expect(Object.keys(rec.rows[0]!).sort()).toEqual(['inputTokens', 'model', 'outputTokens', 'promptVersion', 'purpose', 'stopReason']);
    expect(rec.rows[0]).toMatchObject({ purpose: 'extract', promptVersion: HUB_EXTRACTION_PROMPT_VERSION, stopReason: 'end_turn' });
    expect(rec.rows[0]!.inputTokens).toBeGreaterThan(0);
  });

  it('post-validates: unknown participant keys are dropped', async () => {
    const out = emptyOutput({
      people: [
        { participantKey: 'P9', existingPersonId: null, name: 'Ghost', isHuman: true, roleTitle: null, roleTitleBasis: null, phone: null, phoneBasis: null, companyRef: null, confidence: 0.9, evidence: '' },
      ],
    });
    const r = await extract(CTX, parts(''), { llm: spyLlm(() => out).llm, recordCall: recorder().recordCall });
    expect(r.output.people).toEqual([]);
  });

  it('retries once on a schema failure', async () => {
    const spy = spyLlm((_args, call) => (call === 1 ? { relevant: 'yes' } : emptyOutput()));
    const rec = recorder();
    const r = await extract(CTX, parts(''), { llm: spy.llm, recordCall: rec.recordCall });
    expect(r.calls).toBe(2);
    expect(spy.calls[1]!.user).toBe(spy.calls[0]!.user);
    expect(rec.rows.map((x) => x.stopReason)).toEqual([null, 'end_turn']);
  });

  it('gives llm_bad_output after two schema failures', async () => {
    const spy = spyLlm(() => ({ relevant: 'yes' }));
    await expect(extract(CTX, parts(''), { llm: spy.llm, recordCall: recorder().recordCall })).rejects.toMatchObject({
      code: 'llm_bad_output',
    });
    expect(spy.calls).toHaveLength(2);
  });

  it('gives llm_refused on a refusal, without a retry', async () => {
    let n = 0;
    const llm: LlmClient = {
      parseStructured: async () => {
        n++;
        throw new LlmRefusedError();
      },
    };
    const rec = recorder();
    const err = await extract(CTX, parts(''), { llm, recordCall: rec.recordCall }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubExtractionError);
    expect(err).toMatchObject({ code: 'llm_refused' });
    expect(n).toBe(1);
    expect(rec.rows.map((x) => x.stopReason)).toEqual(['refusal']);
  });

  it('maps 429 to llm_rate_limited and 5xx or transport errors to llm_unavailable', async () => {
    const failing = (err: unknown): LlmClient => ({
      parseStructured: async () => {
        throw err;
      },
    });
    const run = (err: unknown) => extract(CTX, parts(''), { llm: failing(err), recordCall: recorder().recordCall });
    await expect(run(Object.assign(new Error('rate'), { status: 429 }))).rejects.toMatchObject({ code: 'llm_rate_limited' });
    await expect(run(Object.assign(new Error('down'), { status: 503 }))).rejects.toMatchObject({ code: 'llm_unavailable' });
    await expect(run(new TypeError('fetch failed'))).rejects.toMatchObject({ code: 'llm_unavailable' });
  });
});

describe('fake LLM hub fixtures', () => {
  const deps = () => ({ llm: createFakeGenerationLlm(), recordCall: recorder().recordCall });

  it('answers a recorded fixture by the id in <messages>, keyed to the participants', async () => {
    const r = await extract(CTX, parts(fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer)), deps());
    expect(r.output.relevant).toBe(true);
    expect(r.output.people).toEqual([expect.objectContaining({ participantKey: 'P1', name: 'Jan Kowalski', companyRef: 'C1' })]);
    expect(r.output.companies).toEqual([expect.objectContaining({ ref: 'C1', domain: 'acme.example' })]);
    expect(r.output.links).toEqual([expect.objectContaining({ kind: 'person_company', from: 'P1', to: 'C1' })]);
  });

  it('uses known record ids by name match', async () => {
    const p = parts(fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer), {
      knownRecords: {
        people: [{ id: PERSON_ID, name: 'Jan Kowalski', hash: 'h1' }],
        companies: [{ id: COMPANY_ID, name: 'Acme Sp. z o.o.', hash: 'h2' }],
        projects: [],
      },
    });
    const r = await extract(CTX, p, deps());
    expect(r.output.people[0]!.existingPersonId).toBe(PERSON_ID);
    expect(r.output.companies[0]!.existingCompanyId).toBe(COMPANY_ID);
  });

  it('drops fixture people that are not participants and returns an irrelevant output without a fixture id', async () => {
    const p = parts(fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer), {
      participants: [{ key: 'P1', name: null, address: OWNER, flags: ['owner'], sent: true }],
    });
    const r = await extract(CTX, p, deps());
    expect(r.output.people).toEqual([]);
    expect(r.output.links).toEqual([]);
    const none = await extract(CTX, parts('no marker'), deps());
    expect(none.output).toMatchObject({ relevant: false, people: [], companies: [] });
  });

  it('switches: refusal, bad output once, bad output twice', async () => {
    await expect(extract(CTX, parts(fakeHubMarker(FAKE_HUB_SWITCHES.refuse)), deps())).rejects.toMatchObject({ code: 'llm_refused' });
    const once = await extract(CTX, parts(`${fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer)} ${fakeHubMarker(FAKE_HUB_SWITCHES.badOnce)}`), deps());
    expect(once.calls).toBe(2);
    expect(once.output.people).toHaveLength(1);
    await expect(extract(CTX, parts(fakeHubMarker(FAKE_HUB_SWITCHES.badTwice)), deps())).rejects.toMatchObject({ code: 'llm_bad_output' });
  });
});

describe('inspectExtractionOutputs', () => {
  const deps = { policy: POLICY, classifier: CLEAN };

  it('redacts a planted password in evidence', async () => {
    const r = await extract(CTX, parts(`${fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer)} ${fakeHubMarker(FAKE_HUB_SWITCHES.plantedPassword)}`), {
      llm: createFakeGenerationLlm(),
      recordCall: recorder().recordCall,
    });
    expect(r.output.people[0]!.evidence).toContain('Tr0ub4dor&3xQ');
    const inspected = await inspectExtractionOutputs(r.output, deps);
    if (inspected.status !== 'ok') throw new Error('expected ok');
    expect(inspected.output.people[0]!.evidence).not.toContain('Tr0ub4dor&3xQ');
    expect(inspected.output.people[0]!.evidence).toContain('[excluded:');
    expect(inspected.redactedValues).toBeGreaterThan(0);
    expect(inspected.summaryExcluded).toBe(false);
  });

  it('drops a wholly excluded summary', async () => {
    const r = await extract(CTX, parts(`${fakeHubMarker(FAKE_HUB_FIXTURES.acmeOffer)} ${fakeHubMarker(FAKE_HUB_SWITCHES.excludedSummary)}`), {
      llm: createFakeGenerationLlm(),
      recordCall: recorder().recordCall,
    });
    const inspected = await inspectExtractionOutputs(r.output, deps);
    if (inspected.status !== 'ok') throw new Error('expected ok');
    expect(inspected.summaryExcluded).toBe(true);
    expect(inspected.output.summary).toBe('');
    expect(inspected.output.people).toHaveLength(1);
  });

  it('drops an item whose name is wholly excluded, with its links', async () => {
    const out = emptyOutput({
      companies: [
        { ref: 'C1', existingCompanyId: null, name: 'ghp_0123456789abcdefghijABCDEFGHIJ012345', domain: null, website: null, industry: null, industryConfidence: null, basis: 'text', confidence: 0.9, evidence: '' },
      ],
      people: [
        { participantKey: 'P1', existingPersonId: null, name: 'Jan Kowalski', isHuman: true, roleTitle: null, roleTitleBasis: null, phone: null, phoneBasis: null, companyRef: 'C1', confidence: 0.9, evidence: '' },
      ],
      links: [{ kind: 'person_company', from: 'P1', to: 'C1', role: null, roleConfidence: null, basis: 'text', confidence: 0.9, evidence: '' }],
    });
    const inspected = await inspectExtractionOutputs(out, deps);
    if (inspected.status !== 'ok') throw new Error('expected ok');
    expect(inspected.output.companies).toEqual([]);
    expect(inspected.output.links).toEqual([]);
    expect(inspected.output.people[0]!.companyRef).toBeNull();
  });

  it('checks contacts through validateContactValue', async () => {
    const out = emptyOutput({
      people: [
        { participantKey: 'P1', existingPersonId: null, name: 'Jan', isHuman: true, roleTitle: null, roleTitleBasis: null, phone: '123', phoneBasis: 'signature', companyRef: null, confidence: 0.9, evidence: '' },
      ],
      companies: [
        { ref: 'C1', existingCompanyId: null, name: 'Acme', domain: 'Acme.Example', website: null, industry: null, industryConfidence: null, basis: 'domain', confidence: 0.9, evidence: '' },
      ],
    });
    const inspected = await inspectExtractionOutputs(out, deps);
    if (inspected.status !== 'ok') throw new Error('expected ok');
    expect(inspected.output.people[0]!.phone).toBeNull();
    expect(inspected.output.people[0]!.phoneBasis).toBeNull();
    expect(inspected.output.companies[0]!.domain).toBe('acme.example');
  });

  it('fails closed when the inspection cannot complete', async () => {
    await expect(inspectExtractionOutputs(emptyOutput(), { ...deps, classifier: BROKEN })).rejects.toMatchObject({
      code: 'inspection_failed',
    });
  });
});
