import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { foldName } from '@voicespark/core/hub/normalize';
import {
  buildMime,
  CONVERSATIONS_DIR,
  disallowedDomains,
  evalConversationSchema,
  type EvalConversation,
  type EvalSuggestion,
  type MimeAddress,
} from './format';

// Ports the reference app's synthetic eval set (research R14, T148) into this directory's conversation format:
// `{pl,en,x}-NN.json` files of `FetchedMessage` fields become raw MIME messages plus the `expected` block, the
// `seed` blocks and the per-thread mailbox override of the `x-*` files are carried over, and the expected
// suggestions are derived from the labels (see `deriveSuggestions`). Run once, commit the output:
//
//   pnpm --filter @voicespark/worker exec tsx eval/hub/port-reference-set.ts --from <dir> [--to eval/hub/conversations]
//
// The port fails on any domain that is not `*.example`, `example.com` or a FREE_MAIL_DOMAINS entry.

interface SourceAddress {
  address: string;
  name: string | null;
}
interface SourceMessage {
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  from: SourceAddress;
  to: SourceAddress[];
  cc: SourceAddress[];
  replyTo: SourceAddress[];
  headers: Record<string, string>;
  labels: string[];
  isDraft: boolean;
  attachmentNames: string[];
  sentAt: string;
  text: string;
}
interface SourceThread {
  providerThreadId: string;
  subject: string;
  mailbox?: string;
  provider?: 'google' | 'microsoft';
  messages: SourceMessage[];
}
interface SourceFile {
  mailbox: string;
  provider: 'google' | 'microsoft';
  categories: string[];
  threads: SourceThread[];
  seed?: EvalConversation['seed'];
  expected: Omit<EvalConversation['expected'], 'suggestions'>;
}

const PROVIDERS = { google: 'gmail', microsoft: 'microsoft' } as const;
const FILE_NAME = /^(pl|en|x)-\d{2}\.json$/;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const toMime = (a: SourceAddress): MimeAddress => ({ address: a.address, name: a.name });
const lower = (a: string) => a.trim().toLowerCase();

/**
 * Suggestions the policy (contracts/hub-extraction.md section 9) must queue for the labelled outcome:
 * - a labelled person whose name matches a seeded person with another address: `person_email` with
 *   `name_only_match` (the `multi-address` files);
 * - a labelled person who never wrote and was not a direct To of an owner-sent message with at most five
 *   recipients: `person` with `low_confidence`;
 * - a seeded owner-set `roleTitle` whose person writes in the thread: a `conflict` on `roleTitle` (the
 *   `owner-conflict` files, where the signature states another title).
 */
function deriveSuggestions(file: SourceFile, owners: Set<string>): EvalSuggestion[] {
  const out: EvalSuggestion[] = [];
  const seedPeople = file.seed?.people ?? [];
  const senders = new Set<string>();
  const directTo = new Set<string>();
  for (const t of file.threads) {
    for (const m of t.messages) {
      senders.add(lower(m.from.address));
      if (owners.has(lower(m.from.address)) && m.to.length <= 5)
        for (const r of m.to) directTo.add(lower(r.address));
    }
  }
  for (const p of file.expected.people) {
    const email = lower(p.email);
    if (seedPeople.some((s) => lower(s.email) === email)) continue;
    const sameName = seedPeople.find((s) => foldName(s.name) === foldName(p.name));
    if (sameName)
      out.push({
        type: 'person_email',
        reason: 'name_only_match',
        person: lower(sameName.email),
        address: email,
      });
    else if (!senders.has(email) && !directTo.has(email))
      out.push({ type: 'person', reason: 'low_confidence', address: email });
  }
  for (const s of seedPeople) {
    if (s.roleSource !== 'owner' || !senders.has(lower(s.email))) continue;
    out.push({ type: 'field', field: 'roleTitle', reason: 'conflict', person: lower(s.email) });
  }
  return out;
}

function convert(id: string, file: SourceFile): EvalConversation {
  const mailboxes = new Map<string, EvalConversation['mailboxes'][number]>();
  const addMailbox = (address: string, provider: 'google' | 'microsoft') =>
    mailboxes.set(lower(address), { address: lower(address), provider: PROVIDERS[provider] });
  addMailbox(file.mailbox, file.provider);
  for (const t of file.threads) if (t.mailbox) addMailbox(t.mailbox, t.provider ?? file.provider);
  const owners = new Set(mailboxes.keys());

  const threads: EvalConversation['threads'] = file.threads.map((t) => ({
    ref: t.providerThreadId,
    mailbox: lower(t.mailbox ?? file.mailbox),
    subject: t.subject,
    messages: t.messages.map((m, i) => {
      if (m.isDraft) throw new Error(`${id}: drafts are not part of the eval (${m.rfcMessageId})`);
      return {
        ref: `${t.providerThreadId}/${i + 1}`,
        direction:
          m.labels.includes('SENT') || owners.has(lower(m.from.address)) ? 'outbound' : 'inbound',
        folders: m.labels,
        raw: buildMime({
          messageId: m.rfcMessageId,
          inReplyTo: m.inReplyTo,
          references: m.references,
          date: m.sentAt,
          from: toMime(m.from),
          to: m.to.map(toMime),
          cc: m.cc.map(toMime),
          replyTo: m.replyTo.map(toMime),
          subject: t.subject,
          headers: m.headers,
          text: m.text,
          attachments: m.attachmentNames,
        }),
      };
    }),
  }));

  const conversation = {
    id,
    set: 'reference',
    language: id.startsWith('pl-') ? 'pl' : 'en',
    categories: file.categories,
    mailboxes: [...mailboxes.values()],
    threads,
    ...(file.seed ? { seed: file.seed } : {}),
    expected: { ...file.expected, suggestions: deriveSuggestions(file, owners) },
  };
  const parsed = evalConversationSchema.safeParse(conversation);
  if (!parsed.success) throw new Error(`${id}: ${parsed.error.message}`);
  return parsed.data;
}

async function main(): Promise<void> {
  const from = argValue('--from');
  if (!from) {
    console.error('usage: tsx eval/hub/port-reference-set.ts --from <dir> [--to <dir>]');
    process.exit(2);
  }
  const to = path.resolve(argValue('--to') ?? CONVERSATIONS_DIR);
  const names = (await readdir(from)).filter((f) => FILE_NAME.test(f)).sort();
  if (names.length === 0) throw new Error(`no {pl,en,x}-NN.json files in ${from}`);
  await mkdir(to, { recursive: true });

  const counts = { files: 0, threads: 0, messages: 0, suggestions: 0 };
  const bad: string[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    const source = JSON.parse(await readFile(path.join(from, name), 'utf8')) as SourceFile;
    const conversation = convert(id, source);
    const offending = disallowedDomains(conversation);
    if (offending.length > 0) {
      bad.push(`${id}: ${offending.join(', ')}`);
      continue;
    }
    // Through prettier, so the committed files are what `pnpm format` would leave.
    const target = path.join(to, name);
    const options = (await resolveConfig(target)) ?? {};
    await writeFile(
      target,
      await format(JSON.stringify(conversation), { ...options, filepath: target }),
    );
    counts.files += 1;
    counts.threads += conversation.threads.length;
    counts.messages += conversation.threads.reduce((n, t) => n + t.messages.length, 0);
    counts.suggestions += conversation.expected.suggestions.length;
  }
  if (bad.length > 0) {
    console.error(
      `domains outside *.example, example.com and FREE_MAIL_DOMAINS:\n  ${bad.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log(
    `ported ${counts.files} files (${counts.threads} threads, ${counts.messages} messages, ${counts.suggestions} expected suggestions) to ${to}`,
  );
}

await main();
