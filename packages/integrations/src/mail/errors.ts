// Mailbox errors shared by the Gmail, Graph and IMAP clients. Messages never carry mail content or tokens.

/** The mailbox credential is no longer usable (revoked, invalid_grant, 401 after a refresh). */
export class MailAuthError extends Error {
  readonly code = 'mail_auth';
  constructor(message = 'Mailbox authorization is no longer valid') {
    super(message);
    this.name = 'MailAuthError';
  }
}

/** The provider throttled us; retry after `retryAfterMs`. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Mailbox provider rate limit, retry after ${retryAfterMs} ms`);
    this.name = 'RateLimitedError';
  }
}

/** The incremental sync cursor expired (Gmail history 404); a resync is needed. */
export class HistoryExpiredError extends Error {
  constructor(message = 'Mailbox sync cursor expired') {
    super(message);
    this.name = 'HistoryExpiredError';
  }
}

/** The IMAP folder's UIDVALIDITY changed, so stored UIDs no longer identify the same messages. */
export class UidValidityChangedError extends Error {
  constructor(readonly folderKey: string) {
    super('IMAP UIDVALIDITY changed');
    this.name = 'UidValidityChangedError';
  }
}

export class ImapConnectError extends Error {
  constructor(readonly code: 'imap_auth_failed' | 'imap_connection_failed') {
    super(code === 'imap_auth_failed' ? 'IMAP login failed' : 'IMAP connection failed');
    this.name = 'ImapConnectError';
  }
}
