import { convert } from 'html-to-text';
import type { ParsedMessage } from './parse';
import { exceedsHtmlNesting, HTML_MAX_NESTING } from './html-guard';

export const MESSAGE_CAP = 6000;
export const SIGNATURE_CAP = 1500;
export const THREAD_CAP = 40_000;

const SIGNATURE_FALLBACK_LINES = 12;
// Marker lines are short; longer lines are never tested, which bounds the work on untrusted mail.
const MARKER_LINE_MAX = 1000;
const HEADER_FIELD_MAX = 300;
const HEADER_BLOCK_LOOKAHEAD = 3;
const HTML_MAX_DEPTH = 100;
const HTML_MAX_INPUT = 2_000_000;

const DISCLAIMER =
  /confidential|poufn|klauzula|RODO|GDPR|intended (solely )?for the (named )?addressee|this e-?mail and any attachments/i;
const FORWARD_MARKERS = ['forwarded message', 'przekazana wiadomość', 'wiadomość przekazana', 'przesłana wiadomość'];
const OUTLOOK_REPLY_DIV = /id\s*=\s*["']?divRplyFwdMsg/i;

export interface CleanedBody {
  /** Authored text without quoted history and disclaimers, capped so body + signature <= MESSAGE_CAP. */
  body: string;
  /** Text after a `-- ` line, else the last 12 lines of a longer message; '' when none. At most SIGNATURE_CAP. */
  signature: string;
}

export interface HubThreadMessage {
  date: Date | null;
  direction: 'inbound' | 'outbound';
  from: string;
  subject: string;
  body: string;
  signature: string;
}

function htmlToHubText(html: string): string {
  const m = OUTLOOK_REPLY_DIV.exec(html);
  if (m) html = html.slice(0, Math.max(0, html.lastIndexOf('<', m.index)));
  return convert(html, {
    wordwrap: false,
    limits: { maxDepth: HTML_MAX_DEPTH, maxInputLength: HTML_MAX_INPUT },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'hr', format: 'skip' },
      { selector: 'div.gmail_quote', format: 'skip' },
      { selector: 'blockquote[type=cite]', format: 'skip' },
      { selector: '#divRplyFwdMsg', format: 'skip' },
      { selector: '#appendonsend', format: 'skip' },
    ],
  });
}

function isForwardMarker(lower: string): boolean {
  return FORWARD_MARKERS.some((f) => lower.includes(f));
}

function isHeaderBlock(lines: string[], i: number, first: string, second: string): boolean {
  if (!lines[i]!.trimStart().startsWith(first)) return false;
  for (let j = i + 1; j <= i + HEADER_BLOCK_LOOKAHEAD && j < lines.length; j++) {
    if (lines[j]!.trimStart().startsWith(second)) return true;
  }
  return false;
}

/** Index of the first quoted-history line, or of the forward marker (kind tells which); null when neither. */
function findQuoteOrForward(lines: string[]): { index: number; kind: 'quote' | 'forward' } | null {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('>')) return { index: i, kind: 'quote' };
    if (t.length > MARKER_LINE_MAX) continue;
    const lower = t.toLowerCase();
    if (isForwardMarker(lower)) return { index: i, kind: 'forward' };
    const quote =
      lower.includes('-----original message-----') ||
      lower.includes('wiadomość oryginalna') ||
      (t.startsWith('On ') && (t.endsWith('wrote:') || lines[i + 1]?.trim() === 'wrote:')) ||
      ((t.startsWith('W dniu ') || t.startsWith('Dnia ')) && t.includes('napisał')) ||
      isHeaderBlock(lines, i, 'From:', 'Sent:') ||
      isHeaderBlock(lines, i, 'Od:', 'Wysłano:');
    if (quote) return { index: i, kind: 'quote' };
  }
  return null;
}

function dropDisclaimers(lines: string[]): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length && !DISCLAIMER.test(para.join('\n'))) {
      if (out.length) out.push('');
      for (const l of para) out.push(l);
    }
    para = [];
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else para.push(line);
  }
  flush();
  return out;
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  if (space > max - 200) cut = cut.slice(0, space);
  return cut.trimEnd();
}

/** Cleans one message for the hub prompt (contracts/hub-extraction.md section 2, steps 1 to 4 and MESSAGE_CAP). */
export function cleanHubBody(parsed: Pick<ParsedMessage, 'rawText' | 'html' | 'bodyText'>): CleanedBody {
  const source = parsed.rawText.trim()
    ? parsed.rawText
    : parsed.html && !exceedsHtmlNesting(parsed.html, HTML_MAX_NESTING)
      ? htmlToHubText(parsed.html)
      : parsed.bodyText;
  let lines = source.replace(/\r\n?/g, '\n').split('\n');

  const marker = findQuoteOrForward(lines);
  let forwarded: string[] = [];
  if (marker?.kind === 'quote') lines = lines.slice(0, marker.index);
  else if (marker?.kind === 'forward') {
    forwarded = dropDisclaimers(lines.slice(marker.index));
    lines = lines.slice(0, marker.index);
  }
  lines = dropDisclaimers(lines);

  let head = lines;
  let sig: string[] = [];
  const delimiter = lines.findIndex((l) => l === '--' || l === '-- ');
  if (delimiter >= 0) {
    head = lines.slice(0, delimiter);
    sig = lines.slice(delimiter + 1);
  } else if (!forwarded.length && lines.length > SIGNATURE_FALLBACK_LINES) {
    head = lines.slice(0, -SIGNATURE_FALLBACK_LINES);
    sig = lines.slice(-SIGNATURE_FALLBACK_LINES);
  }

  const signature = capText(sig.join('\n').trim(), SIGNATURE_CAP);
  const bodyText = [head.join('\n').trim(), forwarded.join('\n').trim()].filter(Boolean).join('\n\n');
  return { body: capText(bodyText, MESSAGE_CAP - signature.length), signature };
}

function addressOf(from: string): string {
  const open = from.indexOf('<');
  if (open < 0) return from.trim().toLowerCase();
  const close = from.indexOf('>', open);
  return from.slice(open + 1, close < 0 ? undefined : close).trim().toLowerCase();
}

function headerLine(m: HubThreadMessage, k: number): string {
  const date = m.date ? m.date.toISOString().slice(0, 16).replace('T', ' ') : 'unknown date';
  const field = (s: string) => capText(s.replace(/\s+/g, ' ').trim(), HEADER_FIELD_MAX);
  return `[M${k}] ${date} | ${m.direction} | ${field(m.from)} | ${field(m.subject)}`;
}

function block(m: HubThreadMessage, k: number, signature: string | 'repeat'): string {
  let out = `${headerLine(m, k)}\n${m.body}`;
  if (signature === 'repeat') out += '\n[signature as above]';
  else if (signature) out += `\n-- \n${signature}`;
  return out;
}

/**
 * Renders the `<messages>` body (oldest first, keys M1..Mn). Over THREAD_CAP it keeps the first message,
 * then the newest messages that fit, with one `[n earlier messages omitted: ...]` line in place of the gap.
 * Each sender's signature is shown once among the kept messages; identical repeats become `[signature as above]`.
 */
export function assembleThreadText(messages: readonly HubThreadMessage[]): { text: string; omitted: number } {
  if (!messages.length) return { text: '', omitted: 0 };
  // Selection uses full signatures (an upper bound); de-duplication only shortens the rendered text.
  const sizes = messages.map((m, i) => block(m, i + 1, m.signature).length + 2);
  let firstKept = 1;
  if (sizes.reduce((a, b) => a + b, 0) > THREAD_CAP) {
    const reserve = 80;
    let total = sizes[0]! + reserve;
    firstKept = messages.length;
    while (firstKept > 1 && total + sizes[firstKept - 1]! <= THREAD_CAP) total += sizes[--firstKept]!;
  }
  const omitted = firstKept - 1;

  const seen = new Map<string, Set<string>>();
  const render = (i: number) => {
    const m = messages[i]!;
    const norm = m.signature.replace(/\s+/g, ' ').trim();
    if (!norm) return block(m, i + 1, '');
    const sender = addressOf(m.from);
    const known = seen.get(sender) ?? new Set<string>();
    seen.set(sender, known);
    if (known.has(norm)) return block(m, i + 1, 'repeat');
    known.add(norm);
    return block(m, i + 1, m.signature);
  };

  const parts = [render(0)];
  if (omitted) parts.push(`[${omitted} earlier messages omitted: ${omitted === 1 ? 'M2' : `M2-M${omitted + 1}`}]`);
  for (let i = firstKept; i < messages.length; i++) parts.push(render(i));
  return { text: parts.join('\n\n'), omitted };
}
