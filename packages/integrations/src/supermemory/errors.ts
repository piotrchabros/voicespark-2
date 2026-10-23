/** 401 from Supermemory: fatal, raises an admin alert, no retry. */
export class MemoryStoreAuthError extends Error {
  readonly status = 401;
  constructor(message = 'Supermemory rejected the API key (401)') {
    super(message);
    this.name = 'MemoryStoreAuthError';
  }
}

/** The store is temporarily unavailable (e.g. 429/5xx after retries): callers may retry later. */
export class MemoryStoreBusyError extends Error {
  readonly retryable = true;
  readonly code = 'memory_store_busy';
  constructor(
    readonly op: string,
    readonly retryAfterMs = 10_000,
  ) {
    super('memory_store_busy');
    this.name = 'MemoryStoreBusyError';
  }
}

/**
 * Non-401 HTTP/transport failure. `code` is 'supermemory_http_<status>' | 'supermemory_network' |
 * 'supermemory_timeout' | 'supermemory_bad_response' | 'supermemory_not_found'.
 * The message never carries document content or response body data.
 */
export class MemoryStoreHttpError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryStoreHttpError';
  }
}
