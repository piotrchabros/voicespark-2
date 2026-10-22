import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';

export interface SeedMessage {
  messageId: string;
  subject: string;
  from: string;
  to: string;
  date: Date;
  body: string;
}

const BATCH = 50;

export const GREENMAIL_HOST = process.env.GREENMAIL_HOST ?? 'localhost';
export const GREENMAIL_IMAPS_PORT = 3993;

export function uniqueMailbox(prefix: string): string {
  return `${prefix}-${randomUUID()}@greenmail.test`;
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

/** GreenMail runs with auth disabled: any credentials log in and the mailbox is created on first use. */
export async function seedMailbox(opts: {
  user: string;
  messages: SeedMessage[];
  folder?: string;
}): Promise<void> {
  const client = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth: { user: opts.user, pass: 'password' },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  await client.connect();
  try {
    const folder = opts.folder ?? 'INBOX';
    for (let i = 0; i < opts.messages.length; i += BATCH) {
      for (const m of opts.messages.slice(i, i + BATCH)) {
        await client.append(folder, Buffer.from(toRfc822(m), 'utf8'), [], m.date);
      }
    }
  } finally {
    await client.logout();
  }
}
