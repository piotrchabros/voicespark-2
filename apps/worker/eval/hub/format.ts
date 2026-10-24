import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isFreeMailDomain } from '@voicespark/core/hub/normalize';

// Conversation file format of the hub extraction eval (research R14, tasks T148-T151). README.md in this
// directory describes the fields; this module is what the port script, the runner and the vitest check share.

export const CONVERSATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'conversations',
);

export const EVAL_PROVIDERS = ['gmail', 'microsoft', 'imap'] as const;
export const EVAL_LINK_KINDS = ['person_company', 'person_project', 'company_project'] as const;
export const EVAL_SUGGESTION_TYPES = [
  'person',
  'person_email',
  'field',
  'project',
  'link',
] as const;
export const EVAL_SUGGESTION_REASONS = [
  'low_confidence',
  'conflict',
  'name_only_match',
  'inferred_project',
] as const;

const address = z.string().email().toLowerCase();
const domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]+$/);

const seedSchema = z.strictObject({
  people: z
    .array(
      z.strictObject({
        email: address,
        name: z.string().min(1),
        roleTitle: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
        /** The role was typed by the owner (`owner_fields` holds `roleTitle`): email evidence never overwrites it. */
        roleSource: z.literal('owner').optional(),
      }),
    )
    .optional(),
  companies: z
    .array(z.strictObject({ name: z.string().min(1), domain: domain.optional() }))
    .optional(),
  projects: z
    .array(z.strictObject({ name: z.string().min(1), companyDomains: z.array(domain).optional() }))
    .optional(),
});

const expectedSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      email: address,
      name: z.string().min(1),
      roleTitle: z.string().min(1).optional(),
      companyDomain: domain.optional(),
    }),
  ),
  companies: z.array(
    z.strictObject({ domain: domain.optional(), name: z.string().min(1).optional() }),
  ),
  projects: z.array(z.strictObject({ name: z.string().min(1) })),
  links: z.array(
    z.strictObject({
      kind: z.enum(EVAL_LINK_KINDS),
      a: z.string().min(1),
      b: z.string().min(1),
      role: z.string().min(1).optional(),
    }),
  ),
  /** The thread must be skipped as `automated`; every other label is then empty. */
  automated: z.boolean(),
  /** Findings the policy must queue (state `suggested`) rather than apply or drop. Not exhaustive. */
  suggestions: z.array(
    z.strictObject({
      type: z.enum(EVAL_SUGGESTION_TYPES),
      reason: z.enum(EVAL_SUGGESTION_REASONS),
      /** Email of the existing person the suggestion targets (`person_email`, `field`). */
      person: address.optional(),
      /** The address to attach (`person_email`) or the address of the person to create (`person`). */
      address: address.optional(),
      field: z.enum(['roleTitle', 'phone']).optional(),
      project: z.string().min(1).optional(),
    }),
  ),
  /** Substrings (word stems, compared after `foldText`) the stored summary must contain. */
  summaryMentions: z.array(z.string().min(1)),
});

const messageSchema = z.strictObject({
  /** Provider ref the runner records the message under; unique within the file. */
  ref: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']),
  /** Provider labels or folders as the fetcher would report them (`INBOX`, `SENT`, `CATEGORY_PROMOTIONS`, ...). */
  folders: z.array(z.string().min(1)),
  /** The complete RFC 5322 message, CRLF line endings. */
  raw: z.string().min(1),
});

export const evalConversationSchema = z.strictObject({
  /** File stem: `pl-NN`, `en-NN`, `x-NN` (ported reference set) or `holdout-NN`. */
  id: z.string().regex(/^(pl|en|x|holdout)-\d{2}$/),
  set: z.enum(['reference', 'holdout']),
  language: z.enum(['pl', 'en', 'mixed']),
  categories: z.array(z.string().min(1)),
  /** Every owner mailbox the file uses; all of them are owner identities for the policy. */
  mailboxes: z.array(z.strictObject({ address, provider: z.enum(EVAL_PROVIDERS) })).min(1),
  threads: z
    .array(
      z.strictObject({
        ref: z.string().min(1),
        /** Address of the mailbox (an entry of `mailboxes`) that holds this thread. */
        mailbox: address,
        subject: z.string(),
        messages: z.array(messageSchema).min(1),
      }),
    )
    .min(1),
  seed: seedSchema.optional(),
  expected: expectedSchema,
});

export type EvalConversation = z.infer<typeof evalConversationSchema>;
export type EvalThread = EvalConversation['threads'][number];
export type EvalMessage = EvalThread['messages'][number];
export type EvalSeed = NonNullable<EvalConversation['seed']>;
export type EvalExpected = EvalConversation['expected'];
export type EvalSuggestion = EvalExpected['suggestions'][number];

/** Every conversation file of `dir`, parsed and validated, sorted by id. */
export async function loadConversations(
  dir: string = CONVERSATIONS_DIR,
): Promise<EvalConversation[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out: EvalConversation[] = [];
  for (const name of names) {
    const parsed = evalConversationSchema.safeParse(
      JSON.parse(await readFile(path.join(dir, name), 'utf8')),
    );
    if (!parsed.success) throw new Error(`${name}: ${z.prettifyError(parsed.error)}`);
    if (`${parsed.data.id}.json` !== name)
      throw new Error(`${name}: id "${parsed.data.id}" does not match the file name`);
    out.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Domain rule: synthetic data only. Allowed are `*.example`, `example.com` and the FREE_MAIL_DOMAINS entries.

export function isAllowedEvalDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d.endsWith('.example') || d === 'example.com' || isFreeMailDomain(d);
}

const DOMAIN_TOKEN = /(?:@|www\.|https?:\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** Every domain a conversation mentions: addresses and URLs in the raw messages, plus the label and seed domains. */
export function collectDomains(conversation: EvalConversation): Set<string> {
  const out = new Set<string>();
  const addDomain = (d: string | undefined) => d && out.add(d.toLowerCase());
  const addAddress = (a: string | undefined) => addDomain(a?.split('@')[1]);
  for (const t of conversation.threads) {
    for (const m of t.messages) for (const hit of m.raw.matchAll(DOMAIN_TOKEN)) addDomain(hit[1]);
  }
  for (const mb of conversation.mailboxes) addAddress(mb.address);
  for (const p of conversation.expected.people) {
    addAddress(p.email);
    addDomain(p.companyDomain);
  }
  for (const c of conversation.expected.companies) addDomain(c.domain);
  for (const s of conversation.expected.suggestions) {
    addAddress(s.person);
    addAddress(s.address);
  }
  for (const p of conversation.seed?.people ?? []) addAddress(p.email);
  for (const c of conversation.seed?.companies ?? []) addDomain(c.domain);
  for (const p of conversation.seed?.projects ?? [])
    for (const d of p.companyDomains ?? []) addDomain(d);
  return out;
}

/** Domains of the conversation that break the rule; empty when it passes. */
export function disallowedDomains(conversation: EvalConversation): string[] {
  return [...collectDomains(conversation)].filter((d) => !isAllowedEvalDomain(d)).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// MIME builder: RFC 5322 text from structured fields, 8bit UTF-8 like the fixtures in test/fixtures/hub.

export interface MimeAddress {
  address: string;
  name?: string | null;
}

export interface MimeInput {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** ISO 8601 instant. */
  date: string;
  from: MimeAddress;
  to: MimeAddress[];
  cc?: MimeAddress[];
  replyTo?: MimeAddress[];
  subject: string;
  /** Extra headers by lower-case name (`list-unsubscribe`, `auto-submitted`, `return-path`, ...). */
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  /** Attachment file names; each becomes a small `application/octet-stream` part. */
  attachments?: string[];
}

const CRLF = '\r\n';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function rfcDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function angle(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

function mailbox(a: MimeAddress): string {
  const name = a.name?.trim();
  if (!name) return a.address;
  const quoted = /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
  return `${quoted} <${a.address}>`;
}

/** Header names as mail clients write them (`List-Unsubscribe`, `X-Auto-Response-Suppress`). */
function headerCase(name: string): string {
  return name
    .split('-')
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join('-');
}

function addressList(name: string, list: MimeAddress[] | undefined): string[] {
  if (!list || list.length === 0) return [];
  return [`${name}: ${list.map(mailbox).join(`,${CRLF} `)}`];
}

export function buildMime(input: MimeInput): string {
  const lines: string[] = [
    `Message-ID: ${angle(input.messageId)}`,
    `Date: ${rfcDate(input.date)}`,
    `From: ${mailbox(input.from)}`,
    ...addressList('To', input.to),
    ...addressList('Cc', input.cc),
    ...addressList('Reply-To', input.replyTo),
    `Subject: ${input.subject}`,
  ];
  if (input.inReplyTo) lines.push(`In-Reply-To: ${angle(input.inReplyTo)}`);
  if (input.references && input.references.length > 0)
    lines.push(`References: ${input.references.map(angle).join(' ')}`);
  for (const [name, value] of Object.entries(input.headers ?? {}))
    lines.push(`${headerCase(name)}: ${value}`);
  lines.push('MIME-Version: 1.0');

  const textPart = (type: string, body: string) =>
    [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: 8bit', '', body].join(
      CRLF,
    );
  let body: string;
  const text = input.text ?? '';
  if (input.html && input.text) {
    const b = `alt-${hash(input.messageId)}`;
    body = [
      `Content-Type: multipart/alternative; boundary="${b}"`,
      '',
      `--${b}`,
      textPart('text/plain', text),
      `--${b}`,
      textPart('text/html', input.html),
      `--${b}--`,
    ].join(CRLF);
  } else if (input.html) {
    body = textPart('text/html', input.html);
  } else {
    body = textPart('text/plain', text);
  }
  if (input.attachments && input.attachments.length > 0) {
    const b = `mix-${hash(input.messageId)}`;
    const parts = input.attachments.map((name) =>
      [
        `--${b}`,
        `Content-Type: application/octet-stream; name="${name}"`,
        `Content-Disposition: attachment; filename="${name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(`placeholder for ${name}`).toString('base64'),
      ].join(CRLF),
    );
    body = [
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      body,
      ...parts,
      `--${b}--`,
    ].join(CRLF);
  }
  return `${lines.join(CRLF)}${CRLF}${body}${CRLF}`;
}

/** Short stable token for MIME boundaries. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
