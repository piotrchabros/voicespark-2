import { describe, expect, it, vi } from 'vitest';
import {
  buildGmailQuery,
  createGmailClient,
  createGmailFetcher,
  parseRetryAfter,
  type GmailApiLike,
  type GmailCallOptions,
  type GmailClient,
} from '../src/gmail';
import { HistoryExpiredError, MailAuthError, RateLimitedError, type FolderState, type TokenProvider } from '../src/mail';

function httpError(status: number, opts: { data?: unknown; headers?: Record<string, string> } = {}) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    status,
    response: { status, data: opts.data ?? {}, headers: new Headers(opts.headers ?? {}) },
  });
}

function tokens(): TokenProvider & { get: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => 'old-token'), refresh: vi.fn(async () => 'new-token') };
}

function fakeApi(overrides: Partial<{
  getProfile: (p: unknown, o: GmailCallOptions) => Promise<{ data: unknown }>;
  list: (p: unknown, o: GmailCallOptions) => Promise<{ data: unknown }>;
  get: (p: unknown, o: GmailCallOptions) => Promise<{ data: unknown }>;
  history: (p: unknown, o: GmailCallOptions) => Promise<{ data: unknown }>;
}>) {
  const getProfile = vi.fn(overrides.getProfile ?? (async () => ({ data: { emailAddress: 'me@example.test', historyId: '100' } })));
  const list = vi.fn(overrides.list ?? (async () => ({ data: {} })));
  const get = vi.fn(overrides.get ?? (async () => ({ data: {} })));
  const history = vi.fn(overrides.history ?? (async () => ({ data: {} })));
  const api = { users: { getProfile, messages: { list, get }, history: { list: history } } } as unknown as GmailApiLike;
  return { api, getProfile, list, get, history };
}

describe('gmail query', () => {
  it('builds after/before with the day after `to` and excludes spam, trash and drafts', () => {
    expect(buildGmailQuery({ from: '2024-01-01', to: '2024-12-31' })).toBe(
      'after:2024/01/01 before:2025/01/01 -in:spam -in:trash -in:drafts',
    );
    expect(buildGmailQuery({ from: null, to: null })).toBe('-in:spam -in:trash -in:drafts');
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7', 60_000)).toBe(7000);
    expect(parseRetryAfter(null, 60_000)).toBe(60_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 1, 5_000)).toBe(5000);
  });
});

describe('gmail client', () => {
  it('lists refs with the query, excluding spam/trash and sending a bearer token without retries', async () => {
    const { api, list } = fakeApi({
      list: async () => ({ data: { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2', resultSizeEstimate: 42 } }),
    });
    const client = createGmailClient({ tokens: tokens(), api });
    const res = await client.listMessageRefs({ dateRange: { from: '2024-03-01', to: null }, pageToken: 'p1' });
    expect(res).toEqual({ ids: ['a', 'b'], nextPageToken: 'p2', resultSizeEstimate: 42 });
    expect(list).toHaveBeenCalledWith(
      {
        userId: 'me',
        q: 'after:2024/03/01 -in:spam -in:trash -in:drafts',
        includeSpamTrash: false,
        maxResults: 100,
        pageToken: 'p1',
      },
      { headers: { Authorization: 'Bearer old-token' }, retry: false },
    );
  });

  it('decodes base64url raw messages', async () => {
    const mime = 'Subject: hi\r\n\r\nbody with ~~~ and ??? chars';
    const { api, get } = fakeApi({
      get: async () => ({ data: { raw: Buffer.from(mime).toString('base64url'), labelIds: ['SENT'] } }),
    });
    const res = await createGmailClient({ tokens: tokens(), api }).getRaw('m1');
    expect(res.raw.toString()).toBe(mime);
    expect(res.labelIds).toEqual(['SENT']);
    expect(get.mock.calls[0]![0]).toEqual({ userId: 'me', id: 'm1', format: 'raw' });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    let n = 0;
    const { api, getProfile } = fakeApi({
      getProfile: async () => {
        if (n++ === 0) throw httpError(401);
        return { data: { emailAddress: 'me@example.test', historyId: '9' } };
      },
    });
    const t = tokens();
    const profile = await createGmailClient({ tokens: t, api }).getProfile();
    expect(profile).toEqual({ emailAddress: 'me@example.test', historyId: '9' });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(getProfile.mock.calls[1]![1]).toEqual({ headers: { Authorization: 'Bearer new-token' }, retry: false });
  });

  it('maps a second 401 to MailAuthError', async () => {
    const { api } = fakeApi({ getProfile: async () => Promise.reject(httpError(401)) });
    const t = tokens();
    await expect(createGmailClient({ tokens: t, api }).getProfile()).rejects.toBeInstanceOf(MailAuthError);
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it('propagates MailAuthError from a failed refresh and maps invalid_grant bodies', async () => {
    const { api } = fakeApi({ getProfile: async () => Promise.reject(httpError(401)) });
    const t = tokens();
    t.refresh.mockRejectedValue(new MailAuthError());
    await expect(createGmailClient({ tokens: t, api }).getProfile()).rejects.toBeInstanceOf(MailAuthError);

    const { api: api2 } = fakeApi({
      getProfile: async () => Promise.reject(httpError(400, { data: { error: 'invalid_grant' } })),
    });
    await expect(createGmailClient({ tokens: tokens(), api: api2 }).getProfile()).rejects.toBeInstanceOf(MailAuthError);
  });

  it('maps 429 and 403 rateLimitExceeded to RateLimitedError with Retry-After', async () => {
    const { api } = fakeApi({ get: async () => Promise.reject(httpError(429, { headers: { 'retry-after': '12' } })) });
    const err = await createGmailClient({ tokens: tokens(), api }).getRaw('x').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(12_000);

    const { api: api2 } = fakeApi({
      list: async () =>
        Promise.reject(httpError(403, { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } })),
    });
    const err2 = await createGmailClient({ tokens: tokens(), api: api2 })
      .listMessageRefs({ dateRange: {} })
      .catch((e) => e);
    expect(err2).toBeInstanceOf(RateLimitedError);
    expect(err2.retryAfterMs).toBe(60_000);
  });

  it('maps history 404 to HistoryExpiredError and other failures to status-only errors', async () => {
    const { api } = fakeApi({
      history: async () => Promise.reject(httpError(404)),
      get: async () => Promise.reject(httpError(404)),
    });
    const client = createGmailClient({ tokens: tokens(), api });
    await expect(client.listHistory('5')).rejects.toBeInstanceOf(HistoryExpiredError);
    const err = await client.getRaw('gone').catch((e) => e);
    expect(err).not.toBeInstanceOf(HistoryExpiredError);
    expect(err.message).toBe('gmail_request_failed:404');
  });

  it('lists added messages from history, skipping drafts/spam/trash, and resumes from the last record', async () => {
    const { api, history } = fakeApi({
      history: async (p) => {
        const params = p as { pageToken?: string };
        return params.pageToken
          ? { data: { history: [{ id: '30', messagesAdded: [{ message: { id: 'c', labelIds: ['INBOX'] } }] }], historyId: '35' } }
          : {
              data: {
                history: [
                  { id: '11', messagesAdded: [{ message: { id: 'a', labelIds: ['INBOX'] } }] },
                  { id: '12', messagesAdded: [{ message: { id: 'd', labelIds: ['DRAFT'] } }, { message: { id: 'a' } }] },
                  { id: '13', messagesAdded: [{ message: { id: 's', labelIds: ['SPAM'] } }] },
                ],
                historyId: '35',
                nextPageToken: 'h2',
              },
            };
      },
    });
    const client = createGmailClient({ tokens: tokens(), api });
    await expect(client.listHistory('10')).resolves.toEqual({ messageIds: ['a'], historyId: '13', nextPageToken: 'h2' });
    expect(history.mock.calls[0]![0]).toEqual({ userId: 'me', startHistoryId: '10', historyTypes: ['messageAdded'] });
    await expect(client.listHistory('10', 'h2')).resolves.toEqual({ messageIds: ['c'], historyId: '35' });
  });
});

describe('gmail fetcher', () => {
  const start: FolderState = { folderKey: '_all', initialCheckpoint: null, cursor: null, initialComplete: false };

  function stubClient(over: Partial<GmailClient> = {}) {
    const base = {
      getProfile: vi.fn<GmailClient['getProfile']>(async () => ({ emailAddress: 'me@example.test', historyId: '500' })),
      listMessageRefs: vi.fn<GmailClient['listMessageRefs']>(async () => ({ ids: [] })),
      getRaw: vi.fn<GmailClient['getRaw']>(async () => ({ raw: Buffer.from('x'), labelIds: ['INBOX'] })),
      listHistory: vi.fn<GmailClient['listHistory']>(async () => ({ messageIds: [], historyId: '0' })),
    };
    return { ...base, ...over } as typeof base;
  }

  it('exposes one folder and the address', async () => {
    const fetcher = createGmailFetcher(stubClient());
    expect(fetcher.provider).toBe('gmail');
    await expect(fetcher.listFolders()).resolves.toEqual([{ folderKey: '_all', name: 'All mail', authored: false }]);
    await expect(fetcher.getAddress()).resolves.toBe('me@example.test');
  });

  it('paginates the initial import, capturing historyId on the first page and completing on the last', async () => {
    const client = stubClient();
    client.listMessageRefs
      .mockResolvedValueOnce({ ids: ['a', 'b'], nextPageToken: 'p2', resultSizeEstimate: 3 })
      .mockResolvedValueOnce({ ids: ['c'] });
    client.getProfile.mockResolvedValueOnce({ emailAddress: 'me@example.test', historyId: '500' });
    const fetcher = createGmailFetcher(client);
    const dateRange = { from: '2024-01-01', to: null };

    const first = await fetcher.listPage(start, { mode: 'initial', dateRange, limit: 2 });
    expect(first.refs).toEqual([
      { providerRef: 'a', folderKey: '_all' },
      { providerRef: 'b', folderKey: '_all' },
    ]);
    expect(first.folderDone).toBe(false);
    expect(first.totalEstimate).toBe(3);
    expect(first.state).toEqual({
      folderKey: '_all',
      initialCheckpoint: { pageToken: 'p2' },
      cursor: { historyId: '500' },
      initialComplete: false,
    });
    expect(client.listMessageRefs).toHaveBeenLastCalledWith({ dateRange, maxResults: 2 });

    client.getProfile.mockClear();
    const second = await fetcher.listPage(first.state, { mode: 'initial', dateRange, limit: 2 });
    expect(client.getProfile).not.toHaveBeenCalled();
    expect(client.listMessageRefs).toHaveBeenLastCalledWith({ dateRange, maxResults: 2, pageToken: 'p2' });
    expect(second.folderDone).toBe(true);
    expect(second.state).toEqual({
      folderKey: '_all',
      initialCheckpoint: null,
      cursor: { historyId: '500' },
      initialComplete: true,
    });
  });

  it('resync starting from null captures a fresh historyId', async () => {
    const client = stubClient();
    const fetcher = createGmailFetcher(client);
    const res = await fetcher.listPage(
      { ...start, cursor: { historyId: '1' }, initialComplete: true },
      { mode: 'resync', dateRange: {}, limit: 100 },
    );
    expect(client.getProfile).toHaveBeenCalledTimes(1);
    expect(res.state.cursor).toEqual({ historyId: '500' });
    expect(res.folderDone).toBe(true);
  });

  it('incremental reads history from the cursor and advances it', async () => {
    const client = stubClient({
      listHistory: vi.fn(async () => ({ messageIds: ['n1'], historyId: '600', nextPageToken: 'more' })),
    });
    const fetcher = createGmailFetcher(client);
    const state: FolderState = { ...start, cursor: { historyId: '500' }, initialComplete: true };
    const res = await fetcher.listPage(state, { mode: 'incremental', dateRange: {}, limit: 100 });
    expect(client.listHistory).toHaveBeenCalledWith('500');
    expect(res.refs).toEqual([{ providerRef: 'n1', folderKey: '_all' }]);
    expect(res.state).toEqual({ ...state, cursor: { historyId: '600' } });
    expect(res.folderDone).toBe(false);

    await expect(fetcher.listPage(start, { mode: 'incremental', dateRange: {}, limit: 100 })).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });

  it('fetches messages with at most 10 in flight, marking SENT and keeping per-message errors', async () => {
    let inFlight = 0;
    let max = 0;
    const client = stubClient({
      getRaw: vi.fn(async (id: string) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        if (id === 'bad') throw new Error('gmail_request_failed:404');
        return { raw: Buffer.from(id), labelIds: id === 's0' ? ['SENT', 'INBOX'] : ['INBOX'] };
      }),
    });
    const ids = [...Array.from({ length: 24 }, (_, i) => `s${i}`), 'bad'];
    const out = await createGmailFetcher(client).fetchMessages(ids.map((providerRef) => ({ providerRef, folderKey: '_all' })));
    expect(max).toBeLessThanOrEqual(10);
    expect(out.size).toBe(25);
    expect(out.get('s0')).toMatchObject({ isSent: true, folders: ['SENT', 'INBOX'] });
    expect(out.get('s1')).toMatchObject({ isSent: false });
    expect(out.get('bad')).toBeInstanceOf(Error);
  });

  it('rejects the whole fetch on auth or rate-limit errors', async () => {
    const client = stubClient({ getRaw: vi.fn(async () => Promise.reject(new RateLimitedError(1000))) });
    await expect(
      createGmailFetcher(client).fetchMessages([{ providerRef: 'a', folderKey: '_all' }]),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
