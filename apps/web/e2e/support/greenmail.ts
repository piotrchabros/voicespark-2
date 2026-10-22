import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';

// GreenMail (docker-compose.test.yml) runs with auth disabled: any password logs in and a mailbox is created on first
// use. IMAPS 3993 (self-signed, hence TEST_IMAP_INSECURE_TLS for the app), IMAP 3143, SMTP 3025 (every app email).

export const GREENMAIL_HOST = process.env.GREENMAIL_HOST ?? 'localhost';
export const GREENMAIL_IMAPS_PORT = 3993;
export const GREENMAIL_PASSWORD = 'password';

export interface SeedMessage {
  subject: string;
  from: string;
  to: string;
  body: string;
  date?: Date;
  messageId?: string;
}

export interface CapturedMail {
  subject: string;
  /** Raw RFC 822 source (headers + encoded body). */
  source: string;
}

export function uniqueMailbox(prefix: string): string {
  return `${prefix}-${randomUUID()}@greenmail.test`;
}

function toRfc822(m: SeedMessage): string {
  return [
    `Message-ID: ${m.messageId ?? `<${randomUUID()}@greenmail.test>`}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
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

async function withClient<T>(user: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth: { user, pass: GREENMAIL_PASSWORD },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Appends messages (structured or raw RFC 822 strings) to the user's folder (INBOX by default). */
export async function appendMessages(
  user: string,
  msgs: readonly (SeedMessage | string)[],
  folder = 'INBOX',
): Promise<void> {
  await withClient(user, async (client) => {
    for (const m of msgs) {
      const raw = typeof m === 'string' ? m : toRfc822(m);
      const date = typeof m === 'string' ? undefined : m.date;
      await client.append(folder, Buffer.from(raw, 'utf8'), [], date);
    }
  });
}

/** Polls the recipient's GreenMail INBOX (where SMTP mail to that address lands) for a matching subject. */
export async function waitForMail(to: string, subjectIncludes: string, timeoutMs = 60_000): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await withClient(to, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
          const subject = msg.envelope?.subject ?? '';
          if (subject.includes(subjectIncludes)) {
            return { subject, source: msg.source?.toString('utf8') ?? '' };
          }
        }
        return null;
      } finally {
        lock.release();
      }
    }).catch(() => null);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`no mail for ${to} with subject containing "${subjectIncludes}" within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
