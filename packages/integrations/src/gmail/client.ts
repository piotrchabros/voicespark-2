import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { HistoryExpiredError, MailAuthError, RateLimitedError } from '../mail/errors';
import { mapLimit } from '../mail/limit';
import type {
  DateRange,
  FetchedMessage,
  FolderState,
  MailFetcher,
  MailFolder,
  MailPageResult,
  MailRef,
  TokenProvider,
} from '../mail/types';

export const GMAIL_FETCH_CONCURRENCY = 10;
export const GMAIL_DEFAULT_RETRY_AFTER_MS = 60_000;
const GMAIL_ALL_FOLDER: MailFolder = { folderKey: '_all', name: 'All mail', authored: false };
const EXCLUDED_LABELS = ['SPAM', 'TRASH', 'DRAFT'];

/** Per-call options: the bearer token per request; retries are left to the job queue. */
export interface GmailCallOptions {
  headers: Record<string, string>;
  retry: boolean;
}

interface Res<T> {
  data: T;
}

/** The minimal structural slice of gmail_v1.Gmail used here, so tests can inject a fake. */
export interface GmailApiLike {
  users: {
    getProfile(
      params: gmail_v1.Params$Resource$Users$Getprofile,
      options: GmailCallOptions,
    ): Promise<Res<gmail_v1.Schema$Profile>>;
    messages: {
      list(
        params: gmail_v1.Params$Resource$Users$Messages$List,
        options: GmailCallOptions,
      ): Promise<Res<gmail_v1.Schema$ListMessagesResponse>>;
      get(
        params: gmail_v1.Params$Resource$Users$Messages$Get,
        options: GmailCallOptions,
      ): Promise<Res<gmail_v1.Schema$Message>>;
    };
    history: {
      list(
        params: gmail_v1.Params$Resource$Users$History$List,
        options: GmailCallOptions,
      ): Promise<Res<gmail_v1.Schema$ListHistoryResponse>>;
    };
  };
}

export interface GmailClient {
  getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal?: number }>;
  listMessageRefs(q: {
    dateRange: DateRange;
    pageToken?: string;
    maxResults?: number;
  }): Promise<{ ids: string[]; nextPageToken?: string; resultSizeEstimate?: number }>;
  getRaw(id: string): Promise<{ raw: Buffer; labelIds: string[] }>;
  /**
   * messageAdded records only (drafts/spam/trash dropped). `historyId` is where the next call resumes: the last record's
   * id while more pages remain, else the mailbox's current historyId.
   */
  listHistory(
    startHistoryId: string,
    pageToken?: string,
  ): Promise<{ messageIds: string[]; historyId: string; nextPageToken?: string }>;
}

function gmailDate(isoDate: string): string {
  return isoDate.replaceAll('-', '/');
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `after:` is inclusive of `from`; `before:` is exclusive, so it gets the day after `to`. */
export function buildGmailQuery(dateRange: DateRange): string {
  const parts: string[] = [];
  if (dateRange.from) parts.push(`after:${gmailDate(dateRange.from)}`);
  if (dateRange.to) parts.push(`before:${gmailDate(addDays(dateRange.to, 1))}`);
  parts.push('-in:spam', '-in:trash', '-in:drafts');
  return parts.join(' ');
}

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  response?: { status?: unknown; data?: unknown; headers?: unknown };
}

function errorStatus(err: ErrorLike): number | undefined {
  for (const v of [err.response?.status, err.status, err.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100) return n;
  }
  return undefined;
}

function errorReasons(err: ErrorLike): string[] {
  const data = err.response?.data as
    | { error?: string | { status?: string; errors?: { reason?: string }[] }; error_description?: string }
    | undefined;
  const reasons: string[] = [];
  if (typeof data?.error === 'string') reasons.push(data.error);
  else if (data?.error) {
    if (data.error.status) reasons.push(data.error.status);
    for (const e of data.error.errors ?? []) if (e.reason) reasons.push(e.reason);
  }
  if (typeof err.message === 'string' && err.message.includes('invalid_grant')) reasons.push('invalid_grant');
  return reasons;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, unknown>;
  const v = record[name] ?? record[name.toLowerCase()];
  return typeof v === 'string' ? v : null;
}

export function parseRetryAfter(value: string | null, fallbackMs: number, now = Date.now()): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? fallbackMs : Math.max(0, at - now);
}

const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED'];

/** Maps an API failure to a mail error. Unknown failures become a status-only error (no tokens, URLs or bodies). */
function mapError(err: unknown, opts: { historyCall: boolean }): Error {
  if (err instanceof MailAuthError || err instanceof RateLimitedError || err instanceof HistoryExpiredError) return err;
  const e = (err ?? {}) as ErrorLike;
  const status = errorStatus(e);
  const reasons = errorReasons(e);
  if (reasons.includes('invalid_grant') || status === 401) return new MailAuthError();
  if (status === 429 || (status === 403 && reasons.some((r) => RATE_LIMIT_REASONS.includes(r)))) {
    return new RateLimitedError(
      parseRetryAfter(headerValue(e.response?.headers, 'retry-after'), GMAIL_DEFAULT_RETRY_AFTER_MS),
    );
  }
  if (opts.historyCall && status === 404) return new HistoryExpiredError();
  return new Error(`gmail_request_failed:${status ?? 'network'}`);
}

export function createGmailClient(opts: { tokens: TokenProvider; api?: GmailApiLike }): GmailClient {
  // Constructed lazily; without an auth client googleapis sends our Authorization header as-is.
  let api = opts.api;
  const getApi = (): GmailApiLike => (api ??= gmail({ version: 'v1' }) as unknown as GmailApiLike);

  async function call<T>(fn: (o: GmailCallOptions) => Promise<Res<T>>, historyCall = false): Promise<T> {
    const optionsFor = (token: string): GmailCallOptions => ({
      headers: { Authorization: `Bearer ${token}` },
      retry: false,
    });
    try {
      return (await fn(optionsFor(await opts.tokens.get()))).data;
    } catch (err) {
      const mapped = mapError(err, { historyCall });
      if (!(mapped instanceof MailAuthError) || errorStatus((err ?? {}) as ErrorLike) !== 401) throw mapped;
    }
    // 401: refresh once (refresh itself throws MailAuthError on invalid_grant) and retry.
    const fresh = await opts.tokens.refresh();
    try {
      return (await fn(optionsFor(fresh))).data;
    } catch (err) {
      throw mapError(err, { historyCall });
    }
  }

  return {
    async getProfile() {
      const data = await call((o) => getApi().users.getProfile({ userId: 'me' }, o));
      if (!data.emailAddress || !data.historyId) throw new Error('gmail_profile_incomplete');
      return {
        emailAddress: data.emailAddress,
        historyId: data.historyId,
        ...(data.messagesTotal != null ? { messagesTotal: data.messagesTotal } : {}),
      };
    },

    async listMessageRefs(q) {
      const data = await call((o) =>
        getApi().users.messages.list(
          {
            userId: 'me',
            q: buildGmailQuery(q.dateRange),
            includeSpamTrash: false,
            maxResults: Math.min(q.maxResults ?? 100, 500),
            ...(q.pageToken ? { pageToken: q.pageToken } : {}),
          },
          o,
        ),
      );
      return {
        ids: (data.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])),
        ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        ...(data.resultSizeEstimate != null ? { resultSizeEstimate: data.resultSizeEstimate } : {}),
      };
    },

    async getRaw(id) {
      const data = await call((o) => getApi().users.messages.get({ userId: 'me', id, format: 'raw' }, o));
      if (!data.raw) throw new Error('gmail_raw_missing');
      return { raw: Buffer.from(data.raw, 'base64url'), labelIds: data.labelIds ?? [] };
    },

    async listHistory(startHistoryId, pageToken) {
      const data = await call(
        (o) =>
          getApi().users.history.list(
            {
              userId: 'me',
              startHistoryId,
              historyTypes: ['messageAdded'],
              ...(pageToken ? { pageToken } : {}),
            },
            o,
          ),
        true,
      );
      const ids = new Set<string>();
      for (const h of data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const m = added.message;
          if (!m?.id) continue;
          if ((m.labelIds ?? []).some((l) => EXCLUDED_LABELS.includes(l))) continue;
          ids.add(m.id);
        }
      }
      const lastRecordId = data.history?.at(-1)?.id;
      const historyId = data.nextPageToken && lastRecordId ? lastRecordId : (data.historyId ?? startHistoryId);
      return {
        messageIds: [...ids],
        historyId,
        ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
      };
    },
  };
}

export function createGmailFetcher(client: GmailClient): MailFetcher {
  const refsOf = (ids: string[]): MailRef[] => ids.map((providerRef) => ({ providerRef, folderKey: '_all' }));

  return {
    provider: 'gmail',

    async getAddress() {
      return (await client.getProfile()).emailAddress;
    },

    async listFolders() {
      return [GMAIL_ALL_FOLDER];
    },

    async listPage(folder, { mode, dateRange, limit }): Promise<MailPageResult> {
      if (mode === 'incremental') {
        const cursor = folder.cursor;
        if (!cursor || !('historyId' in cursor)) throw new HistoryExpiredError('Gmail sync cursor missing');
        const page = await client.listHistory(cursor.historyId);
        return {
          refs: refsOf(page.messageIds),
          state: { ...folder, cursor: { historyId: page.historyId } },
          folderDone: !page.nextPageToken,
        };
      }

      // initial / resync: the historyId to sync from afterwards is captured before the first page.
      const checkpoint = folder.initialCheckpoint;
      const pageToken = checkpoint && 'pageToken' in checkpoint ? checkpoint.pageToken : undefined;
      let cursor = folder.cursor;
      if (!pageToken || !cursor || !('historyId' in cursor)) {
        cursor = { historyId: (await client.getProfile()).historyId };
      }
      const page = await client.listMessageRefs({
        dateRange,
        maxResults: limit,
        ...(pageToken ? { pageToken } : {}),
      });
      const done = !page.nextPageToken;
      const state: FolderState = {
        folderKey: folder.folderKey,
        initialCheckpoint: page.nextPageToken ? { pageToken: page.nextPageToken } : null,
        cursor,
        initialComplete: done,
      };
      return {
        refs: refsOf(page.ids),
        state,
        folderDone: done,
        ...(page.resultSizeEstimate != null ? { totalEstimate: page.resultSizeEstimate } : {}),
      };
    },

    async fetchMessages(refs) {
      const out = new Map<string, FetchedMessage | Error>();
      await mapLimit(refs, GMAIL_FETCH_CONCURRENCY, async (ref) => {
        try {
          const { raw, labelIds } = await client.getRaw(ref.providerRef);
          out.set(ref.providerRef, { raw, folders: labelIds, isSent: labelIds.includes('SENT') });
        } catch (err) {
          // Auth and throttling stop the whole page; anything else is a per-message failure.
          if (err instanceof MailAuthError || err instanceof RateLimitedError) throw err;
          out.set(ref.providerRef, err instanceof Error ? err : new Error('gmail_fetch_failed'));
        }
      });
      return out;
    },

    async close() {},
  };
}
