import { hmacHex } from '../crypto';

/** Trims whitespace and `<>`, lower-cases. Returns null for an empty id. */
export function normalizeMessageId(id: string | null | undefined): string | null {
  const v = (id ?? '').trim().replace(/^<+|>+$/g, '').trim().toLowerCase();
  return v === '' ? null : v;
}

/** Id for a message that carries no Message-ID header. */
export function syntheticRoot(sourceId: string, providerRef: string): string {
  return `source:${sourceId}:${providerRef}`;
}

/**
 * Normalised thread root: first of `References`, else `In-Reply-To`, else the own Message-ID,
 * else `fallback` (pass `syntheticRoot(sourceId, providerRef)`).
 */
export function threadRoot(
  parsed: { messageId?: string | null; inReplyTo?: string | null; references?: readonly string[] | null },
  fallback: string,
): string {
  for (const ref of parsed.references ?? []) {
    const id = normalizeMessageId(ref);
    if (id) return id;
  }
  return normalizeMessageId(parsed.inReplyTo) ?? normalizeMessageId(parsed.messageId) ?? fallback;
}

/** Per-user thread key (HMAC); two users never share a key for the same root. */
export function threadKey(userId: string, root: string): string {
  return hmacHex(`hubthread:${userId}:${root}`);
}
