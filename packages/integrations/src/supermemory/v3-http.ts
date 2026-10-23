import { MemoryStoreAuthError, MemoryStoreHttpError } from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;

export interface V3HttpOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer`; the header is omitted only when empty. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Backoff before each extra attempt in sendRetrying. */
  retryDelaysMs?: readonly number[];
  /** Upper bound for a server-supplied Retry-After. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface V3Response {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isOk = (status: number) => status >= 200 && status < 300;

/**
 * Concise message from a v3 error body: error string (+ details), validation error array or HTTP status.
 * Never body.data (the server echoes the request there, which carries document content) nor raw text.
 */
export function messageOfV3(body: unknown, text: string, status: number): string {
  if (isObject(body)) {
    const { error } = body;
    if (typeof error === 'string') {
      const details = typeof body.details === 'string' && body.details ? ` (${body.details})` : '';
      return `${error}${details}`.slice(0, MAX_MESSAGE_LENGTH);
    }
    if (Array.isArray(error) && error.length > 0) {
      return error
        .map((e: unknown) => {
          if (!isObject(e)) return String(e);
          const path = Array.isArray(e.path) ? e.path.join('.') : '';
          const message = typeof e.message === 'string' ? e.message : 'invalid';
          return path ? `${path}: ${message}` : message;
        })
        .join('; ')
        .slice(0, MAX_MESSAGE_LENGTH);
    }
  }
  void text;
  return `HTTP ${status}`;
}

/** Retry-After as delta-seconds or HTTP date -> ms; undefined when absent or unparseable. */
export function parseRetryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const value = h.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Non-2xx response -> error; 429 and 5xx are retryable. Message never carries content or body.data. */
export function errorFromResponse(res: V3Response): MemoryStoreHttpError {
  const retryable = res.status === 429 || res.status >= 500;
  return new MemoryStoreHttpError(
    res.status,
    `supermemory_http_${res.status}`,
    retryable,
    `Supermemory HTTP ${res.status}: ${messageOfV3(res.body, res.text, res.status)}`,
  );
}

function transportError(err: unknown): MemoryStoreHttpError {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new MemoryStoreHttpError(
      undefined,
      'supermemory_timeout',
      true,
      'Supermemory request timed out',
    );
  }
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const causeCode = cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
  const message = err instanceof Error && err.message ? err.message : 'request failed';
  return new MemoryStoreHttpError(
    undefined,
    'supermemory_network',
    true,
    `Supermemory ${message.slice(0, 120)}${causeCode}`,
  );
}

/** Raw-fetch client for the /v3 REST API: Bearer auth, timeouts, error classification and bounded retries. */
export class V3Http {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxRetryAfterMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: V3HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  sleep(ms: number): Promise<void> {
    return this.sleepImpl(ms);
  }

  /**
   * One attempt. 401 -> MemoryStoreAuthError. Transport failure, timeout or unparseable JSON on a 2xx
   * -> retryable MemoryStoreHttpError. Every other status is returned for the caller to classify.
   */
  async send(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<V3Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey !== '') headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let status: number;
    let resHeaders: Headers;
    let text: string;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      resHeaders = res.headers;
      text = await res.text();
    } catch (err) {
      throw transportError(err);
    }

    if (status === 401) throw new MemoryStoreAuthError();

    let parsed: unknown = undefined;
    if (text && /json/i.test(resHeaders.get('content-type') ?? '')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Truncated bodies happen on 2xx; an unparseable error body just falls back to `HTTP <status>`.
        if (isOk(status)) {
          throw new MemoryStoreHttpError(
            status,
            'supermemory_bad_response',
            true,
            `Supermemory returned malformed JSON (HTTP ${status})`,
          );
        }
      }
    }
    return { status, headers: resHeaders, body: parsed, text };
  }

  /**
   * send() with backoff on 429 (always), and on 5xx / transport errors unless `idempotent === false`.
   * Honours Retry-After (capped). 401 and other 4xx are never retried; a retryable failure that
   * outlasts the delays is thrown as a retryable MemoryStoreHttpError.
   */
  async sendRetrying(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { idempotent?: boolean } = {},
  ): Promise<V3Response> {
    const idempotent = opts.idempotent !== false;
    for (let attempt = 0; ; attempt++) {
      const backoff = this.retryDelaysMs[attempt];
      let failure: MemoryStoreHttpError;
      let delayMs = backoff ?? 0;
      try {
        const res = await this.send(method, path, body);
        const retry = res.status === 429 || (idempotent && res.status >= 500);
        if (!retry) return res;
        failure = errorFromResponse(res);
        const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
        if (retryAfter !== undefined) delayMs = Math.min(retryAfter, this.maxRetryAfterMs);
      } catch (err) {
        if (!(err instanceof MemoryStoreHttpError) || !err.retryable || !idempotent) throw err;
        failure = err;
      }
      if (backoff === undefined) throw failure;
      await this.sleepImpl(delayMs);
    }
  }
}
