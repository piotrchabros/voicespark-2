import { ZodError } from 'zod';
import { getDb, hubLlmCall } from '@voicespark/db';
import {
  inspect,
  inspectForHubExtraction,
  inspectSegments,
  parseFromAddress,
  validateContactValue,
  type Classifier,
  type Policy,
} from '@voicespark/filters';
import { LlmRefusedError, type LlmClient } from '@voicespark/integrations/anthropic';
import { SIGNATURE_CAP, THREAD_CAP, type AutomatedReason } from '@voicespark/integrations/mime';
import { loadEnv } from '../../env';
import { MAX_LLM_CALLS, hubExtractionSchema, hubTriageSchema, postValidateExtraction, type HubExtraction } from '../../hub/extraction-schema';
import { addressHash, isFreeMailDomain, isRoleAddress, normalizeAddress } from '../../hub/normalize';
import {
  HUB_EXTRACTION_PROMPT_VERSION,
  HUB_TRIAGE_PROMPT,
  buildExtractionMessages,
  type HubExtractionParts,
  type HubParticipantFlag,
  type HubPromptMessage,
  type HubPromptParticipant,
} from '../../hub/prompts';
import { HUB_POLICY_V1 } from '../../hub/policy';
import { getClassifier } from '../inspection';
import type { ApplyParticipant } from './apply';
import { domainHash } from './records';

// The model-facing steps of `hub.thread` (contracts/hub-extraction.md sections 4 to 7): participants, hub-mode
// inspection, the optional triage call, the extraction call and the inspection of its outputs. No database lock is
// held here; the only write is the `hub_llm_call` cost row. This is the only module allowed to import
// `inspectForHubExtraction` (lint). Errors carry codes only: messages never echo content.

export const HUB_TRIAGE_PROMPT_VERSION = 'hub-triage-v1';

const EXTRACT_MAX_TOKENS = 16_000;
const TRIAGE_MAX_TOKENS = 1_000;
const TRIAGE_BODY_CHARS = 1_500;
const TRIAGE_AUTOMATED_MIN = 0.7;
const MAX_TO = 10;
const MAX_TO_CC = 20;
/** Rough token estimate for the cost row: the client does not return usage. */
const CHARS_PER_TOKEN = 4;
const NO_STRUCTURED_OUTPUT = 'LLM response did not contain structured output';
const SIGNATURE_REPEAT = '[signature as above]';
/** Header-based reasons of `classifyAutomated` (rules 1 to 6); the sender pattern and Gmail labels are not headers. */
const HEADER_REASONS: ReadonlySet<AutomatedReason> = new Set([
  'list_header',
  'precedence',
  'auto_submitted',
  'auto_response_suppress',
  'null_return_path',
  'esp_header',
]);

export type HubExtractionErrorCode =
  | 'llm_refused'
  | 'llm_bad_output'
  | 'llm_rate_limited'
  | 'llm_unavailable'
  | 'inspection_failed';

/** The `hub_thread.last_error_code` of a failed step. The message is the code: it never carries content. */
export class HubExtractionError extends Error {
  constructor(readonly code: HubExtractionErrorCode) {
    super(code);
    this.name = 'HubExtractionError';
  }
}

// ---------------------------------------------------------------------------
// Participants (section 4)
// ---------------------------------------------------------------------------

/** `hub_ignore_rule.value_hash` values of one user, split by kind. */
export interface HubIgnoreRules {
  addressHashes: ReadonlySet<string>;
  domainHashes: ReadonlySet<string>;
}

export const EMPTY_IGNORE_RULES: HubIgnoreRules = { addressHashes: new Set(), domainHashes: new Set() };

/**
 * `hub_ignore_rule.value_hash`: an address rule hashes the lower-cased address, a domain rule the domain as for
 * `hub_company_domain.domain_hash`. The matcher hashes the participant's address and every suffix of its domain.
 */
export function ignoreRuleHash(kind: 'address' | 'domain', value: string): string {
  return kind === 'address' ? addressHash(value) : domainHash(value);
}

/** Header data of one message, as parsed (`ParsedMessage.from`, `to`, `cc`). */
export interface HubParticipantMessage {
  from: string;
  to: string;
  cc: string;
  /** `classifyAutomated(...).automated` of the message. */
  automated: boolean;
}

/** A candidate of the thread: the apply participant (data-model shape plus key and counts) and the ignore flag. */
export interface SelectedParticipant extends ApplyParticipant {
  /** Matches a `hub_ignore_rule` (FR-021); never sent to the model or applied. */
  ignored: boolean;
}

export interface ParticipantSelection {
  /** `P1..Pn` in order of first appearance; addresses lower-cased. */
  participants: SelectedParticipant[];
  /** `owner_only` when no other candidate is left; `ignored` when every other candidate is ignored. */
  skip: 'ignored' | 'owner_only' | null;
}

/** Splits an address list header on commas outside quotes and angle brackets. */
function splitAddressList(header: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function parseList(header: string): { name: string | null; address: string }[] {
  const out: { name: string | null; address: string }[] = [];
  for (const entry of splitAddressList(header)) {
    const parsed = parseFromAddress(entry);
    if (parsed.address !== undefined) out.push({ name: parsed.name ?? null, address: normalizeAddress(parsed.address) });
  }
  return out;
}

function isIgnored(address: string, rules: HubIgnoreRules): boolean {
  if (rules.addressHashes.size > 0 && rules.addressHashes.has(ignoreRuleHash('address', address))) return true;
  if (rules.domainHashes.size === 0) return false;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  for (let i = -1; ; i = domain.indexOf('.', i + 1)) {
    const suffix = domain.slice(i + 1);
    if (!suffix.includes('.')) return false;
    if (rules.domainHashes.has(ignoreRuleHash('domain', suffix))) return true;
  }
}

/**
 * Candidates are the `From` of every message and the `To` of messages with at most 10 `To` and at most 20 `To`
 * plus `CC`; `CC` never adds a candidate (it only adds the `cc` role to one). `ownerAddresses` holds the user's
 * identities and the addresses of all connected and disconnected sources.
 */
export function selectParticipants(
  messages: readonly HubParticipantMessage[],
  ownerAddresses: Iterable<string>,
  ignoreRules: HubIgnoreRules,
): ParticipantSelection {
  const owners = new Set([...ownerAddresses].map(normalizeAddress));
  const byAddress = new Map<string, SelectedParticipant>();
  const ccAddresses = new Set<string>();
  const add = (entry: { name: string | null; address: string }, role: 'from' | 'to', automated: boolean) => {
    let p = byAddress.get(entry.address);
    if (p === undefined) {
      const domain = entry.address.slice(entry.address.lastIndexOf('@') + 1);
      p = {
        key: `P${byAddress.size + 1}`,
        name: entry.name,
        address: entry.address,
        roles: [],
        owner: owners.has(entry.address),
        roleAddress: isRoleAddress(entry.address),
        freeMail: isFreeMailDomain(domain),
        ignored: isIgnored(entry.address, ignoreRules),
        automated: false,
        sent: false,
        messagesSent: 0,
        directToOnOwnerSent: false,
      };
      byAddress.set(entry.address, p);
    }
    p.name ??= entry.name;
    if (!p.roles.includes(role)) p.roles.push(role);
    if (role === 'from') {
      p.sent = true;
      p.messagesSent++;
    }
    if (automated) p.automated = true;
    return p;
  };
  for (const m of messages) {
    const from = parseList(m.from).slice(0, 1);
    for (const f of from) add(f, 'from', m.automated);
    const ownerSent = from.some((f) => owners.has(f.address));
    const to = parseList(m.to);
    const cc = parseList(m.cc);
    for (const c of cc) ccAddresses.add(c.address);
    if (to.length <= MAX_TO && to.length + cc.length <= MAX_TO_CC) {
      for (const t of to) {
        const p = add(t, 'to', false);
        if (ownerSent && to.length <= HUB_POLICY_V1.maxOwnerToRecipients) p.directToOnOwnerSent = true;
      }
    }
  }
  const participants = [...byAddress.values()];
  for (const p of participants) if (ccAddresses.has(p.address) && !p.roles.includes('cc')) p.roles.push('cc');
  const others = participants.filter((p) => !p.owner);
  const skip = others.length === 0 ? 'owner_only' : others.every((p) => p.ignored) ? 'ignored' : null;
  return { participants, skip };
}

/** The `<participants>` lines: ignored participants are left out, so the model can not reference them. */
export function toPromptParticipants(participants: readonly SelectedParticipant[]): HubPromptParticipant[] {
  return participants
    .filter((p) => !p.ignored)
    .map((p) => {
      const flags: HubParticipantFlag[] = [];
      if (p.owner) flags.push('owner');
      if (p.roleAddress) flags.push('role_address');
      if (p.freeMail) flags.push('free_mail');
      if (p.automated) flags.push('automated');
      return { key: p.key, name: p.name, address: p.address, flags, sent: p.sent };
    });
}

// ---------------------------------------------------------------------------
// Hub-mode inspection of the thread (section 4)
// ---------------------------------------------------------------------------

/** One fetched message after `cleanHubBody`. */
export interface HubInspectMessage {
  subject: string;
  from: string;
  to: string;
  cc: string;
  body: string;
  signature: string;
  sentAt: Date | null;
  direction: 'inbound' | 'outbound';
  folders: string[];
}

export interface HubInspectDeps {
  /** The user's full policy (`loadPolicy`). */
  policy: Policy;
  /** The user's own addresses (`loadOwnAddresses`). */
  ownAddresses: string[];
  classifier?: Classifier;
}

export type ThreadInspection =
  | { status: 'excluded'; excludedMessages: number }
  | {
      status: 'ok';
      /** Oldest first, for `buildExtractionMessages`. */
      messages: HubPromptMessage[];
      excludedMessages: number;
      /** Messages left out by THREAD_CAP (the first and the newest are kept). */
      omittedMessages: number;
      redactedValues: number;
    };

/** Body plus the first signature per sender; an identical repeat becomes `[signature as above]`. */
function withSignatures(messages: readonly HubInspectMessage[]): string[] {
  const seen = new Map<string, Set<string>>();
  return messages.map((m) => {
    const signature = m.signature.slice(0, SIGNATURE_CAP).trim();
    if (signature === '') return m.body;
    const sender = parseFromAddress(m.from).address ?? m.from.trim().toLowerCase();
    const norm = signature.replace(/\s+/g, ' ');
    const known = seen.get(sender) ?? new Set<string>();
    seen.set(sender, known);
    if (known.has(norm)) return `${m.body}\n${SIGNATURE_REPEAT}`;
    known.add(norm);
    return `${m.body}\n-- \n${signature}`;
  });
}

/** Within THREAD_CAP: the first message, then the newest that fit. */
function capThread(messages: HubPromptMessage[]): { kept: HubPromptMessage[]; omitted: number } {
  const total = messages.reduce((n, m) => n + m.text.length, 0);
  if (total <= THREAD_CAP || messages.length <= 1) return { kept: messages, omitted: 0 };
  let size = messages[0]!.text.length;
  let firstKept = messages.length;
  while (firstKept > 1 && size + messages[firstKept - 1]!.text.length <= THREAD_CAP) size += messages[--firstKept]!.text.length;
  return { kept: [messages[0]!, ...messages.slice(firstKept)], omitted: firstKept - 1 };
}

/**
 * Subject and each cleaned body through `inspectForHubExtraction` (contacts kept, everything else applied). A whole-item
 * exclusion drops that message; when every message is dropped the thread is `excluded`. An inspection that can not
 * complete throws `inspection_failed` (fail-closed: nothing is sent).
 */
export async function inspectThreadForExtraction(
  messages: readonly HubInspectMessage[],
  deps: HubInspectDeps,
): Promise<ThreadInspection> {
  const classifier = deps.classifier ?? getClassifier();
  const bodies = withSignatures(messages);
  const kept: HubPromptMessage[] = [];
  let excludedMessages = 0;
  let redactedValues = 0;
  for (const [i, m] of messages.entries()) {
    const r = await inspectForHubExtraction(
      {
        kind: 'email',
        subject: m.subject,
        bodyText: bodies[i]!,
        headers: { from: m.from, to: m.to, cc: m.cc },
        folders: m.folders,
        ownAddresses: deps.ownAddresses,
      },
      deps.policy,
      { classifier },
    );
    if (r.excluded) {
      if (r.category === 'inspection_failed') throw new HubExtractionError('inspection_failed');
      excludedMessages++;
      continue;
    }
    redactedValues += r.redactedValues;
    kept.push({ sentAt: m.sentAt, direction: m.direction, text: r.text });
  }
  if (kept.length === 0) return { status: 'excluded', excludedMessages };
  const { kept: capped, omitted } = capThread(kept);
  return { status: 'ok', messages: capped, excludedMessages, omittedMessages: omitted, redactedValues };
}

// ---------------------------------------------------------------------------
// LLM calls and their cost rows
// ---------------------------------------------------------------------------

export interface HubCallContext {
  userId: string;
  threadId: string | null;
}

/** A `hub_llm_call` row without its ids: counts only, never content. */
export interface HubLlmCallRecord {
  purpose: 'triage' | 'extract';
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface HubLlmDeps {
  llm: LlmClient;
  /** Default: inserts a `hub_llm_call` row for `ctx`. */
  recordCall?: (row: HubLlmCallRecord) => Promise<void>;
}

const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

async function insertLlmCall(ctx: HubCallContext, row: HubLlmCallRecord): Promise<void> {
  await getDb()
    .insert(hubLlmCall)
    .values({ userId: ctx.userId, threadId: ctx.threadId, ...row });
}

const recorderFor = (ctx: HubCallContext, deps: HubLlmDeps) =>
  deps.recordCall ?? ((row: HubLlmCallRecord) => insertLlmCall(ctx, row));

const isUnparseable = (err: unknown): boolean =>
  err instanceof ZodError || err instanceof SyntaxError || (err instanceof Error && err.message === NO_STRUCTURED_OUTPUT);

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** 429 is `llm_rate_limited`; any other API or transport error is `llm_unavailable` (both back off). */
const transportError = (err: unknown): HubExtractionError =>
  new HubExtractionError(statusOf(err) === 429 ? 'llm_rate_limited' : 'llm_unavailable');

// ---------------------------------------------------------------------------
// Triage (section 5)
// ---------------------------------------------------------------------------

/**
 * Triage runs only when no message was sent by the owner, there is exactly one distinct sender, no message carries a
 * header-automated flag and the sender is not a known person (`senderKnown`: an `address_hash` match).
 */
export function shouldTriage(
  selection: ParticipantSelection,
  messages: readonly { direction: 'inbound' | 'outbound'; automatedReason: AutomatedReason | null }[],
  senderKnown: boolean,
): boolean {
  if (senderKnown) return false;
  if (messages.some((m) => m.direction === 'outbound')) return false;
  if (messages.some((m) => m.automatedReason !== null && HEADER_REASONS.has(m.automatedReason))) return false;
  const senders = selection.participants.filter((p) => p.sent);
  return senders.length === 1 && !senders[0]!.owner;
}

export interface HubTriageInput {
  /** `From` header of the first message. */
  from: string;
  toCount: number;
  /** Names of the whitelisted headers present on the first message. */
  headerNames: string[];
  first: HubInspectMessage;
}

/**
 * The optional triage call (`LLM_CLASSIFIER_MODEL`, effort low) over From, To count, Subject, header names and the first
 * 1500 chars of the first message under the normal (full-policy) inspection. Returns `automated_llm` for `automated`
 * with confidence at least 0.7. Any error, an excluded first message included, falls through to extraction (null).
 */
export async function triage(
  ctx: HubCallContext,
  input: HubTriageInput,
  deps: HubLlmDeps & HubInspectDeps,
): Promise<'automated_llm' | null> {
  const model = loadEnv().LLM_CLASSIFIER_MODEL;
  const record = recorderFor(ctx, deps);
  let user: string;
  try {
    const r = await inspect(
      {
        kind: 'email',
        subject: input.first.subject,
        bodyText: input.first.body,
        headers: { from: input.from },
        folders: input.first.folders,
        ownAddresses: deps.ownAddresses,
      },
      deps.policy,
      { classifier: deps.classifier ?? getClassifier() },
    );
    if (r.outcome !== 'accepted' || r.text === undefined) return null;
    const f = r.fields ?? {};
    const from = f.fromName !== undefined && f.fromAddress !== undefined ? `${f.fromName} <${f.fromAddress}>` : (f.fromName ?? f.fromAddress ?? '-');
    user = [
      `From: ${from}`,
      `To count: ${input.toCount}`,
      `Subject: ${f.subject ?? ''}`,
      `Headers: ${input.headerNames.length > 0 ? input.headerNames.join(', ') : '-'}`,
      '',
      r.text.slice(0, TRIAGE_BODY_CHARS),
    ].join('\n');
  } catch {
    return null;
  }
  try {
    const out = await deps.llm.parseStructured({
      model,
      effort: 'low',
      maxTokens: TRIAGE_MAX_TOKENS,
      system: HUB_TRIAGE_PROMPT,
      user,
      schema: hubTriageSchema,
    });
    await record({
      purpose: 'triage',
      model,
      promptVersion: HUB_TRIAGE_PROMPT_VERSION,
      inputTokens: estimateTokens(HUB_TRIAGE_PROMPT.length + user.length),
      outputTokens: estimateTokens(JSON.stringify(out).length),
      stopReason: 'end_turn',
    });
    return out.kind === 'automated' && out.confidence >= TRIAGE_AUTOMATED_MIN ? 'automated_llm' : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extraction (section 6)
// ---------------------------------------------------------------------------

export interface ExtractResult {
  /** Parsed and post-validated (`postValidateExtraction`) against the keys and ids of `parts`. */
  output: HubExtraction;
  calls: number;
}

/**
 * The extraction call: `parseStructured` with `LLM_HUB_EXTRACTION_MODEL`, `LLM_HUB_EXTRACTION_EFFORT` and 16000 max tokens
 * (no temperature, prefill or tool_choice). One retry with the same prompt on a schema or parse failure, then
 * `llm_bad_output`; a refusal is `llm_refused`; 429 `llm_rate_limited`; other API or transport errors `llm_unavailable`.
 * Every answered call writes a `hub_llm_call` row.
 */
export async function extract(ctx: HubCallContext, parts: HubExtractionParts, deps: HubLlmDeps): Promise<ExtractResult> {
  const env = loadEnv();
  const model = env.LLM_HUB_EXTRACTION_MODEL;
  const record = recorderFor(ctx, deps);
  const { system, user } = buildExtractionMessages(parts);
  const row = (outputChars: number, stopReason: string | null): HubLlmCallRecord => ({
    purpose: 'extract',
    model,
    promptVersion: HUB_EXTRACTION_PROMPT_VERSION,
    inputTokens: estimateTokens(system.length + user.length),
    outputTokens: estimateTokens(outputChars),
    stopReason,
  });
  for (let call = 1; call <= MAX_LLM_CALLS; call++) {
    let output: HubExtraction;
    try {
      output = await deps.llm.parseStructured({
        model,
        effort: env.LLM_HUB_EXTRACTION_EFFORT,
        maxTokens: EXTRACT_MAX_TOKENS,
        system,
        user,
        schema: hubExtractionSchema,
      });
    } catch (err) {
      if (err instanceof LlmRefusedError) {
        await record(row(0, 'refusal'));
        throw new HubExtractionError('llm_refused');
      }
      if (!isUnparseable(err)) throw transportError(err);
      await record(row(0, null));
      continue;
    }
    await record(row(JSON.stringify(output).length, 'end_turn'));
    const validated = postValidateExtraction(output, {
      participantKeys: parts.participants.map((p) => p.key),
      knownPersonIds: parts.knownRecords.people.map((r) => r.id),
      knownCompanyIds: parts.knownRecords.companies.map((r) => r.id),
      knownProjectIds: parts.knownRecords.projects.map((r) => r.id),
    });
    return { output: validated, calls: call };
  }
  throw new HubExtractionError('llm_bad_output');
}

// ---------------------------------------------------------------------------
// Output inspection (section 7)
// ---------------------------------------------------------------------------

export type InspectedExtraction =
  | {
      status: 'ok';
      /** Free-text fields redacted under the full policy; wholly excluded segments dropped. */
      output: HubExtraction;
      /** The summary was wholly excluded: no summary is stored. */
      summaryExcluded: boolean;
      redactedValues: number;
    }
  /** The whole output was excluded (user rule or credential delivery): nothing from this call is stored. */
  | { status: 'excluded'; category: string };

const REDACTION_TOKEN = /\[excluded: [^\]]*\]/g;

/** Nothing but redaction tokens, whitespace and punctuation left. */
const whollyExcluded = (original: string, inspected: string): boolean =>
  original.trim() !== '' && !/[\p{L}\p{N}]/u.test(inspected.replace(REDACTION_TOKEN, ''));

/**
 * One `inspectSegments` call (full policy) over `summary`, every `evidence`, `description`, `name`, `roleTitle`, link
 * `role`, `industry` and `website`. A wholly excluded `name` drops its item (and the links and `companyRef`s to it), any
 * other wholly excluded segment becomes empty or null; a changed `website` is dropped. Phones and domains go through
 * `validateContactValue`. An inspection that can not complete throws `inspection_failed` (fail-closed).
 */
export async function inspectExtractionOutputs(
  output: HubExtraction,
  deps: { policy: Policy; classifier?: Classifier },
): Promise<InspectedExtraction> {
  const out: HubExtraction = structuredClone(output);
  const segments: string[] = [];
  const apply: ((inspected: string, original: string) => void)[] = [];
  const dropped = { people: new Set<number>(), companies: new Set<number>(), projects: new Set<number>() };
  let summaryExcluded = false;

  const text = (value: string, set: (v: string) => void, onExcluded: () => void) => {
    segments.push(value);
    apply.push((inspected, original) => (whollyExcluded(original, inspected) ? onExcluded() : set(inspected)));
  };
  const optional = (value: string | null, set: (v: string | null) => void) => {
    if (value !== null) text(value, set, () => set(null));
  };

  text(out.summary, (v) => (out.summary = v), () => {
    out.summary = '';
    summaryExcluded = true;
  });
  out.people.forEach((p, i) => {
    text(p.name, (v) => (p.name = v), () => dropped.people.add(i));
    text(p.evidence, (v) => (p.evidence = v), () => (p.evidence = ''));
    optional(p.roleTitle, (v) => {
      p.roleTitle = v;
      if (v === null) p.roleTitleBasis = null;
    });
  });
  out.companies.forEach((c, i) => {
    text(c.name, (v) => (c.name = v), () => dropped.companies.add(i));
    text(c.evidence, (v) => (c.evidence = v), () => (c.evidence = ''));
    optional(c.industry, (v) => {
      c.industry = v;
      if (v === null) c.industryConfidence = null;
    });
    if (c.website !== null) {
      const original = c.website;
      segments.push(original);
      apply.push((inspected) => (c.website = inspected === original ? original : null));
    }
  });
  out.projects.forEach((j, i) => {
    text(j.name, (v) => (j.name = v), () => dropped.projects.add(i));
    text(j.evidence, (v) => (j.evidence = v), () => (j.evidence = ''));
    optional(j.description, (v) => (j.description = v));
  });
  out.links.forEach((l) => {
    text(l.evidence, (v) => (l.evidence = v), () => (l.evidence = ''));
    optional(l.role, (v) => {
      l.role = v;
      if (v === null) l.roleConfidence = null;
    });
  });

  let result: Awaited<ReturnType<typeof inspectSegments>>;
  try {
    result = await inspectSegments(segments, deps.policy, { classifier: deps.classifier ?? getClassifier() });
  } catch {
    throw new HubExtractionError('inspection_failed');
  }
  if (result.excluded) {
    if (result.category === 'inspection_failed') throw new HubExtractionError('inspection_failed');
    return { status: 'excluded', category: result.category };
  }
  result.segments.forEach((inspected, i) => apply[i]!(inspected, segments[i]!));

  for (const p of out.people) {
    const phone = p.phone === null ? null : validateContactValue('phone', p.phone);
    p.phone = phone;
    if (phone === null) p.phoneBasis = null;
  }
  for (const c of out.companies) c.domain = c.domain === null ? null : validateContactValue('domain', c.domain);

  const goneKeys = new Set<string>([
    ...out.people.filter((_, i) => dropped.people.has(i)).map((p) => p.participantKey),
    ...out.companies.filter((_, i) => dropped.companies.has(i)).map((c) => c.ref),
    ...out.projects.filter((_, i) => dropped.projects.has(i)).map((j) => j.ref),
  ]);
  out.people = out.people.filter((_, i) => !dropped.people.has(i));
  out.companies = out.companies.filter((_, i) => !dropped.companies.has(i));
  out.projects = out.projects.filter((_, i) => !dropped.projects.has(i));
  for (const p of out.people) if (p.companyRef !== null && goneKeys.has(p.companyRef)) p.companyRef = null;
  out.links = out.links.filter((l) => !goneKeys.has(l.from) && !goneKeys.has(l.to));

  return { status: 'ok', output: out, summaryExcluded, redactedValues: result.redactedValues };
}
