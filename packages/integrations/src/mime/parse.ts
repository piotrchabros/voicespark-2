import { simpleParser, type AddressObject } from 'mailparser';
import { convert } from 'html-to-text';
import EmailReplyParser from 'email-reply-parser';

export const MAX_PART_CHARS = 100_000;

export interface ParsedAttachment {
  filename: string;
  mime: string;
  size: number;
  buffer: Buffer;
}

export interface ParsedMessage {
  messageId: string | null;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: Date | null;
  bodyText: string;
  bodyParts: string[];
  folders: string[];
  attachments: ParsedAttachment[];
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  return (Array.isArray(value) ? value : [value]).map((a) => a.text).join(', ');
}

function htmlToPlain(html: string): string {
  return convert(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });
}

/** Splits on paragraph, else line, else whitespace boundaries; never mid-word (a single over-long word is hard-cut). */
export function splitParts(text: string, max: number = MAX_PART_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) {
      const m = /\s\S*$/.exec(window);
      cut = m ? m.index : -1;
    }
    if (cut <= 0) cut = max;
    const head = rest.slice(0, cut).trim();
    if (head) parts.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function parseMessage(raw: Buffer, opts: { authored: boolean; folders?: string[] }): Promise<ParsedMessage> {
  const mail = await simpleParser(raw);
  let body = mail.text?.trim() ? mail.text : typeof mail.html === 'string' ? htmlToPlain(mail.html) : '';
  if (opts.authored && body) body = new EmailReplyParser().read(body).getVisibleText();
  const bodyText = body.trim();

  const attachments: ParsedAttachment[] = [];
  for (const a of mail.attachments) {
    if (a.contentDisposition === 'inline' && !a.filename) continue;
    if (!a.filename && a.related) continue;
    attachments.push({ filename: a.filename ?? 'attachment', mime: a.contentType, size: a.size, buffer: a.content });
  }

  return {
    messageId: mail.messageId ?? null,
    subject: mail.subject ?? '',
    from: addressText(mail.from),
    to: addressText(mail.to),
    cc: addressText(mail.cc),
    date: mail.date ?? null,
    bodyText,
    bodyParts: splitParts(bodyText),
    folders: opts.folders ?? [],
    attachments,
  };
}
