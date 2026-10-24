import { isEspHeaderName, type ParsedMessage } from './parse';

export type AutomatedReason =
  | 'list_header'
  | 'precedence'
  | 'auto_submitted'
  | 'auto_response_suppress'
  | 'null_return_path'
  | 'esp_header'
  | 'sender_pattern'
  | 'gmail_category';

export interface AutomatedResult {
  automated: boolean;
  reason: AutomatedReason | null;
}

// Linear: one anchored alternation of literals, then an optional tail that is never re-scanned.
const SENDER_PATTERN =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|newsletter|news|marketing|automated|system|robot|powiadomienia|nie-?odpowiadaj)([+._-].*)?$/i;
const GMAIL_CATEGORIES = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/** Local part of the first address in a From header text (`Name <a@b>` or `a@b`). */
function senderLocalPart(from: string): string {
  let address = from.trim();
  const open = address.indexOf('<');
  if (open >= 0) {
    const close = address.indexOf('>', open);
    address = address.slice(open + 1, close < 0 ? undefined : close);
  }
  const at = address.lastIndexOf('@');
  return (at < 0 ? address : address.slice(0, at)).trim();
}

/** The rules of contracts/hub-extraction.md section 3, in order; the first match gives the reason. */
export function classifyAutomated(parsed: Pick<ParsedMessage, 'headers' | 'from'>, labels: readonly string[]): AutomatedResult {
  const h = parsed.headers;
  const hit = (reason: AutomatedReason): AutomatedResult => ({ automated: true, reason });
  if (h['list-unsubscribe'] !== undefined || h['list-id'] !== undefined) return hit('list_header');
  if (h.precedence !== undefined && BULK_PRECEDENCE.has(h.precedence.trim().toLowerCase())) return hit('precedence');
  if (h['auto-submitted'] !== undefined && h['auto-submitted'].trim().toLowerCase() !== 'no') return hit('auto_submitted');
  if (h['x-auto-response-suppress'] !== undefined) return hit('auto_response_suppress');
  if (h['return-path'] !== undefined && h['return-path'].replace(/\s+/g, '') === '<>') return hit('null_return_path');
  if (Object.keys(h).some(isEspHeaderName)) return hit('esp_header');
  if (SENDER_PATTERN.test(senderLocalPart(parsed.from))) return hit('sender_pattern');
  if (labels.some((l) => GMAIL_CATEGORIES.has(l))) return hit('gmail_category');
  return { automated: false, reason: null };
}

/** Skip as `automated` only with no outbound message, at least one inbound, and every inbound automated. */
export function threadIsAutomated(messages: readonly { direction: 'inbound' | 'outbound'; automated: boolean }[]): boolean {
  let inbound = 0;
  for (const m of messages) {
    if (m.direction === 'outbound' || !m.automated) return false;
    inbound++;
  }
  return inbound > 0;
}
