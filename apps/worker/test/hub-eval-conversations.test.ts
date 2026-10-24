import { describe, expect, it } from 'vitest';
import { classifyAutomated, parseMessage, threadIsAutomated } from '@voicespark/integrations/mime';
import { isRoleAddress, normalizeAddress } from '@voicespark/core/hub/normalize';
import { disallowedDomains, loadConversations, type EvalConversation } from '../eval/hub/format';

// T148/T149 (research R14): every eval conversation parses, keeps to synthetic domains, references its own
// records consistently, and its `automated` label agrees with the deterministic classifier. Loading goes through
// the same `loadConversations` the runner (T150) uses, so a file this test accepts is one the runner can run.

const conversations = await loadConversations();
const byId = new Map(conversations.map((c) => [c.id, c]));

const ownerAddresses = (c: EvalConversation) =>
  new Set(c.mailboxes.map((m) => normalizeAddress(m.address)));

describe('hub eval conversations', () => {
  it('holds the ported reference set and at least 15 held-out conversations', () => {
    const reference = conversations.filter((c) => c.set === 'reference');
    const holdout = conversations.filter((c) => c.set === 'holdout');
    expect(reference).toHaveLength(53);
    expect(holdout.length).toBeGreaterThanOrEqual(15);
    expect(holdout.every((c) => c.id.startsWith('holdout-'))).toBe(true);
    expect(reference.every((c) => /^(pl|en|x)-/.test(c.id))).toBe(true);
    // Held-out coverage asked for by T149.
    const tags = new Set(holdout.flatMap((c) => c.categories));
    for (const tag of [
      'newsletter',
      'notification',
      'role-address',
      'freemail',
      'multi-address',
      'generic-project',
      'owner-conflict',
    ])
      expect(tags, tag).toContain(tag);
    for (const language of ['pl', 'en', 'mixed'] as const)
      expect(
        holdout.some((c) => c.language === language),
        language,
      ).toBe(true);
  });

  it('uses only *.example, example.com and free-mail domains', () => {
    const offending = Object.fromEntries(
      conversations
        .map((c): [string, string[]] => [c.id, disallowedDomains(c)])
        .filter(([, d]) => d.length > 0),
    );
    expect(offending).toEqual({});
  });

  it('has unique thread and message refs, and threads in a listed mailbox', () => {
    for (const c of conversations) {
      const mailboxes = ownerAddresses(c);
      const refs = new Set<string>();
      for (const t of c.threads) {
        expect(mailboxes, `${c.id} ${t.ref}`).toContain(t.mailbox);
        expect(refs.has(t.ref), `${c.id} ${t.ref}`).toBe(false);
        refs.add(t.ref);
        for (const m of t.messages) {
          expect(refs.has(m.ref), `${c.id} ${m.ref}`).toBe(false);
          refs.add(m.ref);
        }
      }
    }
  });

  it('labels reference records the file defines', () => {
    for (const c of conversations) {
      const { expected: e, seed } = c;
      const people = new Set(e.people.map((p) => p.email));
      const companies = new Set(
        e.companies.flatMap((x) => [x.domain, x.name]).filter((x): x is string => !!x),
      );
      for (const x of seed?.companies ?? []) {
        companies.add(x.name);
        if (x.domain) companies.add(x.domain);
      }
      const projects = new Set([...e.projects, ...(seed?.projects ?? [])].map((x) => x.name));
      for (const p of e.people)
        if (p.companyDomain) expect(companies, `${c.id} ${p.email}`).toContain(p.companyDomain);
      for (const l of e.links) {
        const [ka, kb] = l.kind.split('_') as ['person' | 'company', 'company' | 'project'];
        const pool = { person: people, company: companies, project: projects };
        expect(pool[ka], `${c.id} link ${l.kind} ${l.a}`).toContain(l.a);
        expect(pool[kb], `${c.id} link ${l.kind} ${l.b}`).toContain(l.b);
      }
      const seeded = new Set((seed?.people ?? []).map((p) => p.email));
      for (const s of e.suggestions) {
        if (s.type === 'person_email') expect(seeded, `${c.id} suggestion`).toContain(s.person);
        if (s.type === 'field') expect(seeded, `${c.id} suggestion`).toContain(s.person);
        if (s.address) expect(people, `${c.id} suggestion`).toContain(s.address);
      }
      if (e.automated) {
        expect(e.people, c.id).toEqual([]);
        expect(e.links, c.id).toEqual([]);
        expect(e.summaryMentions, c.id).toEqual([]);
      }
      // Owners, role addresses and free-mail domains never appear where a company or a person is not possible.
      for (const p of e.people) {
        expect(ownerAddresses(c).has(p.email), `${c.id} owner as person`).toBe(false);
        expect(isRoleAddress(p.email), `${c.id} role address as person`).toBe(false);
      }
      for (const x of e.companies)
        if (x.domain)
          expect(disallowedDomains({ ...c, expected: { ...e, companies: [x] } })).toEqual([]);
    }
  });

  it('parses every raw message and agrees with the header classifier on the automated label', async () => {
    for (const c of conversations) {
      const owners = ownerAddresses(c);
      for (const t of c.threads) {
        const flags: { direction: 'inbound' | 'outbound'; automated: boolean }[] = [];
        let senders = new Set<string>();
        for (const m of t.messages) {
          const parsed = await parseMessage(Buffer.from(m.raw), {
            authored: m.direction === 'outbound',
            folders: m.folders,
          });
          expect(parsed.messageId, `${c.id} ${m.ref}`).toBeTruthy();
          expect(parsed.date, `${c.id} ${m.ref}`).toBeInstanceOf(Date);
          expect(parsed.from, `${c.id} ${m.ref}`).toBeTruthy();
          const from = normalizeAddress(parsed.from.match(/<([^>]+)>/)?.[1] ?? parsed.from);
          expect(m.direction, `${c.id} ${m.ref} direction`).toBe(
            owners.has(from) ? 'outbound' : 'inbound',
          );
          senders = senders.add(from);
          flags.push({
            direction: m.direction,
            automated: classifyAutomated(parsed, m.folders).automated,
          });
        }
        const byHeaders = threadIsAutomated(flags);
        if (byHeaders)
          expect(c.expected.automated, `${c.id} ${t.ref} is header-automated`).toBe(true);
        // A label the headers do not justify relies on the triage call, which only runs for a single
        // non-owner sender and no owner message (`shouldTriage`).
        if (c.expected.automated && !byHeaders) {
          expect(
            flags.some((f) => f.direction === 'outbound'),
            `${c.id} ${t.ref}`,
          ).toBe(false);
          expect(senders.size, `${c.id} ${t.ref} senders`).toBe(1);
        }
      }
    }
  });

  it('keeps the cross-mailbox files as one message under two mailboxes', async () => {
    for (const c of conversations.filter((x) => x.categories.includes('cross-mailbox'))) {
      expect(c.mailboxes.length, c.id).toBeGreaterThan(1);
      expect(new Set(c.threads.map((t) => t.mailbox)).size, c.id).toBe(c.threads.length);
      const ids = new Set<string>();
      for (const t of c.threads) {
        for (const m of t.messages) {
          const parsed = await parseMessage(Buffer.from(m.raw), {
            authored: false,
            folders: m.folders,
          });
          ids.add(parsed.messageId!);
        }
      }
      expect(ids.size, c.id).toBe(1);
    }
    expect(byId.get('x-01')?.threads).toHaveLength(2);
  });
});
