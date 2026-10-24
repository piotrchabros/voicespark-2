import type { HubExtraction, HubTriage } from '@voicespark/core/hub/extraction-schema';
import {
  companyMatchName,
  foldName,
  normalizeAddress,
  normalizeDomain,
} from '@voicespark/core/hub/normalize';
import { companyNameFromDomain } from '@voicespark/core/hub/policy';
import type { LlmClient } from '@voicespark/integrations/anthropic';
import type { EvalConversation } from './format';
import { sameProject } from './grade';
import { parseKnownRecords } from './llm';

// Synthetic model for checking the runner and the grader without recordings (dev flag `--synthetic`, and
// test/hub-eval-runner.integration.test.ts): it answers every extraction with what the conversation's `expected`
// block says, keyed to the participant keys and known-record ids of the actual prompt. Run through the real policy
// and apply code, a `perfect` answer must grade at 100% on SC-004; `wrong` renames every person and drops every
// company and link, so the grader must report misses. Its scores say nothing about the real model.

export type SyntheticMode = 'perfect' | 'wrong';

interface PromptParticipant {
  key: string;
  address: string;
  owner: boolean;
}

function parseParticipants(user: string): PromptParticipant[] {
  const start = user.indexOf('<participants>');
  const end = user.indexOf('</participants>');
  if (start < 0 || end < start) return [];
  return user
    .slice(start, end)
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      const [key, , address, flags] = line.split(' | ');
      if (!key || !address) return [];
      return [
        {
          key,
          address: normalizeAddress(address),
          owner: (flags ?? '').split(',').includes('owner'),
        },
      ];
    });
}

export function syntheticExtraction(
  conversation: EvalConversation,
  user: string,
  mode: SyntheticMode,
): HubExtraction {
  const exp = conversation.expected;
  const participants = parseParticipants(user);
  const known = parseKnownRecords(user);
  const knownId = (kind: 'people' | 'companies' | 'projects', match: (name: string) => boolean) =>
    [...known[kind]].find(([, name]) => match(name))?.[0] ?? null;
  const keyOf = (email: string) =>
    participants.find((p) => p.address === normalizeAddress(email))?.key ?? null;

  if (exp.automated) {
    return {
      relevant: false,
      language: 'other',
      summary: '',
      people: [],
      companies: [],
      projects: [],
      links: [],
    };
  }

  const seedCompanies = conversation.seed?.companies ?? [];
  const companyRef = new Map<string, string>();
  const companies: HubExtraction['companies'] = [];
  for (const c of exp.companies) {
    const domain = c.domain ? normalizeDomain(c.domain) : null;
    const name = c.name ?? (domain ? companyNameFromDomain(domain) : '');
    if (name === '') continue;
    const seeded = seedCompanies.find(
      (s) => s.domain && domain && normalizeDomain(s.domain) === domain,
    );
    const ref = `C${companies.length + 1}`;
    if (domain) companyRef.set(domain, ref);
    companyRef.set(companyMatchName(name), ref);
    companies.push({
      ref,
      existingCompanyId: knownId(
        'companies',
        (n) => companyMatchName(n) === companyMatchName(seeded?.name ?? name),
      ),
      name,
      domain,
      website: null,
      industry: null,
      industryConfidence: null,
      basis: 'signature',
      confidence: 0.95,
      evidence: 'signature',
    });
  }
  const companyRefOf = (ref: string) =>
    companyRef.get(normalizeDomain(ref) ?? '') ?? companyRef.get(companyMatchName(ref)) ?? null;

  const projectNames = [...exp.projects.map((p) => p.name)];
  for (const l of exp.links)
    if (l.kind !== 'person_company' && !projectNames.some((n) => sameProject(n, l.b)))
      projectNames.push(l.b);
  const projects: HubExtraction['projects'] = projectNames.map((name, i) => ({
    ref: `J${i + 1}`,
    existingProjectId: knownId('projects', (n) => sameProject(n, name)),
    name,
    description: null,
    status: null,
    explicitlyNamed: true,
    confidence: 0.95,
    evidence: name,
  }));
  const projectRefOf = (name: string) =>
    projects.find((p) => sameProject(p.name, name))?.ref ?? null;

  const people: HubExtraction['people'] = [];
  for (const p of exp.people) {
    const key = keyOf(p.email);
    if (key === null || people.some((x) => x.participantKey === key)) continue;
    people.push({
      participantKey: key,
      existingPersonId: knownId('people', (n) => foldName(n) === foldName(p.name)),
      name: mode === 'wrong' ? `${p.name} Nieznany` : p.name,
      isHuman: true,
      roleTitle: p.roleTitle ?? null,
      roleTitleBasis: p.roleTitle ? 'signature' : null,
      phone: null,
      phoneBasis: null,
      companyRef: p.companyDomain ? companyRefOf(p.companyDomain) : null,
      confidence: 0.95,
      evidence: 'signature',
    });
  }

  const links: HubExtraction['links'] = [];
  for (const l of exp.links) {
    const from = l.kind === 'company_project' ? companyRefOf(l.a) : keyOf(l.a);
    const to = l.kind === 'person_company' ? companyRefOf(l.b) : projectRefOf(l.b);
    if (from === null || to === null) continue;
    links.push({
      kind: l.kind,
      from,
      to,
      role: null,
      roleConfidence: null,
      basis: 'signature',
      confidence: 0.95,
      evidence: 'signature',
    });
  }

  return {
    relevant: true,
    language: conversation.language === 'pl' ? 'pl' : 'en',
    summary: `${exp.summaryMentions.join(', ')}.`,
    people: mode === 'wrong' ? people.map((p) => ({ ...p, companyRef: null })) : people,
    companies: mode === 'wrong' ? [] : companies,
    projects,
    links: mode === 'wrong' ? [] : links,
  };
}

/** Synthetic answers for one conversation: triage by the `automated` label, extraction from `expected`. */
export function createSyntheticLlm(
  conversation: EvalConversation,
  mode: SyntheticMode = 'perfect',
): LlmClient {
  return {
    parseStructured: async (args) => {
      if (args.user.includes('<participants>'))
        return args.schema.parse(syntheticExtraction(conversation, args.user, mode));
      const triage: HubTriage = {
        kind: conversation.expected.automated ? 'automated' : 'human',
        confidence: 0.95,
        reason: 'synthetic',
      };
      return args.schema.parse(triage);
    },
  };
}
