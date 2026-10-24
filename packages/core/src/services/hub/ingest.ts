import { sql } from 'drizzle-orm';
import { withTransaction } from '@voicespark/db';
import * as mail from '@voicespark/db/repos/user/hub-mail';
import { classifyAutomated, type ParsedMessage } from '@voicespark/integrations/mime';
import { hmacHex } from '../../crypto';
import { normalizeMessageId, syntheticRoot, threadKey, threadRoot } from '../../hub/thread-key';
import { logger } from '../../logger';
import { enqueue, jobIds } from '../../queues';
import { encryptContent } from './common';
import * as outbox from './sync';

// Import hook of the hub (contracts/jobs.md (1), contracts/hub-extraction.md section 1; FR-013, FR-020, SC-008).
// Records only metadata: per-user hashes of the message ids, dates, direction, the automated flag and where the
// message can be re-fetched. No subject, address or body is stored here; `hub.thread` re-fetches the messages.

/** Debounce before a recorded thread is processed (SC-009 budget: poll + 60 s + queue latency). */
export const HUB_DEBOUNCE_MS = 60_000;
/** CHECK `hub_message_references_max`. */
const MAX_REFERENCES = 50;

export interface RecordMessageInput {
  userId: string;
  sourceId: string;
  providerRef: string;
  folders: string[];
  parsed: Pick<ParsedMessage, 'messageId' | 'inReplyTo' | 'references' | 'date' | 'from' | 'headers'>;
  direction: 'inbound' | 'outbound';
  /** Provider "open original" URL (Gmail `#all/{msgid}`, Graph `webLink`); null for IMAP. */
  webLink: string | null;
}

export type RecordOutcome = 'new_thread' | 'new_message' | 'known_message';

export interface RecordResult {
  threadId: string;
  version: number;
  outcome: RecordOutcome;
  /** Threads merged into `threadId` because this message linked them. */
  merged: number;
}

/** Per-user HMAC of a normalised Message-ID (or synthetic id); in-reply-to and references hashes use the same. */
export function messageIdHash(userId: string, id: string): string {
  return hmacHex(`hubmsg:${userId}:${id}`);
}

/** Normalised, de-duplicated references; over the cap the root and the newest ones are kept. */
function normalizedReferences(refs: readonly string[] | null | undefined): string[] {
  const ids = [...new Set((refs ?? []).map(normalizeMessageId).filter((v): v is string => v !== null))];
  return ids.length <= MAX_REFERENCES ? ids : [ids[0]!, ...ids.slice(ids.length - (MAX_REFERENCES - 1))];
}

/**
 * Records one imported message for the hub. Thread resolution: an existing `hub_message` this message references
 * (or that references it), then the thread key, then a new thread; a message that links several threads merges them
 * into the oldest. A known `message_id_hash` (the same message in a second mailbox) only adds its source rows and
 * does not bump `version` (FR-020). Otherwise `version + 1`, `pending`, due in 60 s, and `hub.thread` is enqueued.
 * Runs under a per-user lock, so concurrent messages of one page never create two threads for one conversation.
 */
export async function recordMessage(input: RecordMessageInput): Promise<RecordResult> {
  const { userId, sourceId, providerRef, folders, parsed, direction } = input;
  const ctx = { userId };
  const synthetic = syntheticRoot(sourceId, providerRef);
  const hash = messageIdHash(userId, normalizeMessageId(parsed.messageId) ?? synthetic);
  const inReplyTo = normalizeMessageId(parsed.inReplyTo);
  const references = normalizedReferences(parsed.references);
  const inReplyToHash = inReplyTo ? messageIdHash(userId, inReplyTo) : null;
  const referencesHashes = references.map((r) => messageIdHash(userId, r));
  const refHashes = [...new Set([...(inReplyToHash ? [inReplyToHash] : []), ...referencesHashes])].filter(
    (h) => h !== hash,
  );
  const key = threadKey(userId, threadRoot(parsed, synthetic));
  const webLinkEnc = input.webLink ? encryptContent(input.webLink) : null;
  const sentAt = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;

  const result = await withTransaction(async (tx): Promise<RecordResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hub-ingest:${userId}`}))`);

    const known = await mail.getMessageByHash(ctx, hash, tx);
    if (known) {
      await mail.insertMessageSource(ctx, { messageId: known.id, sourceId, providerRef, folders }, tx);
      await mail.upsertThreadSource(ctx, { threadId: known.threadId, sourceId, webLinkEnc }, tx);
      const thread = await mail.getThread(ctx, known.threadId, tx);
      return { threadId: known.threadId, version: thread!.version, outcome: 'known_message', merged: 0 };
    }

    const linked = await mail.findLinkedThreads(ctx, hash, refHashes, tx);
    const byKey = await mail.getThreadByKey(ctx, key, tx);
    const candidates = [...linked];
    if (byKey && !candidates.some((c) => c.id === byKey.id)) candidates.push(byKey);
    candidates.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

    let threadId: string;
    let outcome: RecordOutcome = 'new_message';
    if (candidates.length === 0) {
      threadId = (await mail.insertThread(ctx, key, tx)).id;
      outcome = 'new_thread';
    } else {
      threadId = candidates[0]!.id;
      if (candidates.length > 1) {
        // Facts and records move: same lock as `hub.thread` apply, so a merge never interleaves with one.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hub-apply:${userId}`}))`);
        for (const younger of candidates.slice(1)) {
          const { hadSummary } = await mail.mergeThread(ctx, threadId, younger.id, tx);
          if (hadSummary) await outbox.tombstone(tx, userId, 'summary', younger.id);
        }
      }
    }

    const automated = classifyAutomated(parsed, folders);
    const message = await mail.insertMessage(
      ctx,
      {
        threadId,
        messageIdHash: hash,
        inReplyToHash,
        referencesHashes,
        sentAt,
        direction,
        isAutomated: automated.automated,
        automatedReason: automated.reason,
      },
      tx,
    );
    await mail.insertMessageSource(ctx, { messageId: message!.id, sourceId, providerRef, folders }, tx);
    await mail.upsertThreadSource(ctx, { threadId, sourceId, webLinkEnc }, tx);
    const version = await mail.bumpThread(ctx, threadId, HUB_DEBOUNCE_MS / 1000, tx);
    return { threadId, version, outcome, merged: candidates.length > 1 ? candidates.length - 1 : 0 };
  });

  if (result.outcome !== 'known_message') {
    try {
      await enqueue(
        'hub.thread',
        { userId, threadId: result.threadId, version: result.version },
        { jobId: jobIds.hubThread(result.threadId, result.version), delay: HUB_DEBOUNCE_MS },
      );
    } catch {
      // The row is `pending` and due: `maintenance.hub-thread-sweep` enqueues it.
      logger.warn(
        { userId, entityId: result.threadId, errorCode: 'hub_thread_enqueue_failed' },
        'hub.thread not enqueued; sweep will retry',
      );
    }
  }
  return result;
}
