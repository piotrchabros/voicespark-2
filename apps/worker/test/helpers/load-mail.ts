import { ImapFlow } from 'imapflow';
import { GREENMAIL_HOST, GREENMAIL_IMAPS_PORT, type SeedMessage } from './greenmail';

// Deterministic mail generator for the import load test (T163, SC-003). Messages are plain prose (no digits, no
// addresses or secrets in bodies) so the measured path is parse -> dedup -> inspection -> store, not exclusions.

export interface LoadMailbox {
  user: string;
  messages: SeedMessage[];
}

export interface LoadSpec {
  /** Messages appended across all mailboxes. */
  total: number;
  /** Message-IDs present in both of the first two mailboxes (counted inside `total`). */
  shared: number;
  /** Mailbox login names; the first two receive the shared messages. */
  users: string[];
  /** Seeds the generator; the same seed yields the same mail. */
  seed?: number;
}

const WORDS = [
  'amber',
  'birch',
  'cedar',
  'dune',
  'ember',
  'fjord',
  'glade',
  'harbor',
  'island',
  'juniper',
  'kestrel',
  'lantern',
  'meadow',
  'north',
  'orchard',
  'pebble',
  'quiet',
  'river',
  'saddle',
  'timber',
  'upland',
  'valley',
  'willow',
  'yarrow',
  'morning',
  'evening',
  'garden',
  'letter',
  'season',
  'thought',
  'window',
  'journey',
  'kitchen',
  'harvest',
  'silence',
];
const OPENERS = ['Dear friend', 'Hello again', 'Good morning', 'Quick note', 'Hi there'];
const CLOSERS = ['Warm regards', 'Talk soon', 'All the best', 'Take care', 'Yours'];
const PEOPLE = ['Mara Quill', 'Theo Larkin', 'Ines Vale', 'Orrin Beck', 'Sana Reyes', 'Piet Holm'];

/** mulberry32: small, deterministic, good enough for prose. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prose(next: () => number, words: number): string {
  const out: string[] = [];
  let sentence: string[] = [];
  let count = 0;
  while (count < words) {
    sentence.push(WORDS[Math.floor(next() * WORDS.length)]!);
    count += 1;
    if (sentence.length >= 6 + Math.floor(next() * 10)) {
      sentence[0] = sentence[0]![0]!.toUpperCase() + sentence[0]!.slice(1);
      out.push(`${sentence.join(' ')}.`);
      sentence = [];
    }
  }
  if (sentence.length > 0) {
    sentence[0] = sentence[0]![0]!.toUpperCase() + sentence[0]!.slice(1);
    out.push(`${sentence.join(' ')}.`);
  }
  return out.join(' ');
}

function message(next: () => number, key: string, to: string, index: number): SeedMessage {
  const person = PEOPLE[Math.floor(next() * PEOPLE.length)]!;
  // Half the mail is written by the mailbox owner (From = own address -> authored), half received.
  const own = next() < 0.5;
  const from = own
    ? `Owner <${to}>`
    : `${person} <${person.toLowerCase().replace(' ', '.')}@load-mail.test>`;
  const body = [
    `${OPENERS[Math.floor(next() * OPENERS.length)]},`,
    '',
    prose(next, 40 + Math.floor(next() * 140)),
    '',
    `${CLOSERS[Math.floor(next() * CLOSERS.length)]},`,
    own ? 'Owner' : person.split(' ')[0]!,
  ].join('\n');
  return {
    messageId: `<${key}@load-mail.test>`,
    subject: prose(next, 3 + Math.floor(next() * 5)).replace(/\.$/, ''),
    from,
    to,
    date: new Date(Date.UTC(2023, 0, 1) + index * 7_200_000),
    body,
  };
}

/**
 * Splits `total` messages evenly over `users`; the first `shared` Message-IDs (identical bytes) appear in both of
 * the first two mailboxes and count once each in their totals.
 */
export function generateLoadMail(spec: LoadSpec): LoadMailbox[] {
  if (spec.users.length < 2) throw new Error('load mail needs at least two mailboxes');
  if (spec.shared * 2 > spec.total) throw new Error('shared messages exceed the total');
  const next = rng(spec.seed ?? 163);
  const per = spec.users.map(
    (_, i) =>
      Math.floor(spec.total / spec.users.length) + (i < spec.total % spec.users.length ? 1 : 0),
  );
  const boxes: LoadMailbox[] = spec.users.map((user) => ({ user, messages: [] }));
  for (const [b, box] of boxes.entries()) {
    for (let i = 0; i < per[b]!; i++) {
      const shared = b < 2 && i < spec.shared;
      // Shared mail is generated from its own seed so both mailboxes get the same bytes (recipient included).
      box.messages.push(
        shared
          ? message(rng(1000 + i), `shared-${i}`, boxes[0]!.user, i)
          : message(next, `${b}-${i}`, box.user, i),
      );
    }
  }
  return boxes;
}

function toRfc822(m: SeedMessage): string {
  return [
    `Message-ID: ${m.messageId}`,
    `Date: ${m.date.toUTCString()}`,
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${m.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    m.body,
    '',
  ].join('\r\n');
}

const APPEND_BATCH = 200;

/** Appends one mailbox over IMAPS (GreenMail, auth disabled) in batches; `onProgress` gets the running count. */
export async function appendLoadMailbox(
  box: LoadMailbox,
  onProgress?: (appended: number) => void,
): Promise<void> {
  const client = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth: { user: box.user, pass: 'password' },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  try {
    for (let i = 0; i < box.messages.length; i += APPEND_BATCH) {
      for (const m of box.messages.slice(i, i + APPEND_BATCH)) {
        await client.append('INBOX', Buffer.from(toRfc822(m), 'utf8'), [], m.date);
      }
      onProgress?.(Math.min(i + APPEND_BATCH, box.messages.length));
    }
  } finally {
    await client.logout();
  }
}

/** Seeds every mailbox, one connection each in parallel. */
export async function seedLoadMail(
  boxes: LoadMailbox[],
  onProgress?: (user: string, appended: number) => void,
): Promise<void> {
  await Promise.all(boxes.map((b) => appendLoadMailbox(b, (n) => onProgress?.(b.user, n))));
}
