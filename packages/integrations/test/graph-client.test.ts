import { describe, expect, it, vi } from 'vitest';
import {
  HistoryExpiredError,
  MailAuthError,
  RateLimitedError,
  type FolderState,
  type TokenProvider,
} from '../src/mail';
import {
  GRAPH_BASE_URL,
  createGraphClient,
  createGraphFetcher,
  type GraphClient,
} from '../src/microsoft';

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(route: Route) {
  const calls: { url: URL; auth: string | null; prefer: string | null }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization'), prefer: headers.get('prefer') });
    return route(url, init ?? {});
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

function tokens(): TokenProvider & { refresh: ReturnType<typeof vi.fn> } {
  let current = 'tok-1';
  return {
    get: async () => current,
    refresh: vi.fn(async () => (current = 'tok-2')),
  };
}

const p = (url: URL) => url.pathname.replace('/v1.0', '');

describe('graph client', () => {
  it('resolves the mailbox address from mail, else userPrincipalName', async () => {
    const a = fakeFetch(() =>
      json({ mail: 'me@contoso.test', userPrincipalName: 'upn@contoso.test' }),
    );
    await expect(
      createGraphClient({ tokens: tokens(), fetchFn: a.fetchFn }).getMe(),
    ).resolves.toEqual({
      address: 'me@contoso.test',
    });
    expect(a.calls[0]?.url.origin + a.calls[0]!.url.pathname).toBe(`${GRAPH_BASE_URL}/me`);
    expect(a.calls[0]?.auth).toBe('Bearer tok-1');

    const b = fakeFetch(() => json({ mail: null, userPrincipalName: 'upn@contoso.test' }));
    await expect(
      createGraphClient({ tokens: tokens(), fetchFn: b.fetchFn }).getMe(),
    ).resolves.toEqual({
      address: 'upn@contoso.test',
    });
  });

  it('lists folders recursively, skips deleted/junk/drafts and marks Sent Items authored', async () => {
    const { fetchFn } = fakeFetch((url) => {
      const path = p(url);
      const wellKnown: Record<string, string> = {
        '/me/mailFolders/deleteditems': 'del',
        '/me/mailFolders/junkemail': 'junk',
        '/me/mailFolders/drafts': 'drafts',
        '/me/mailFolders/sentitems': 'sent',
      };
      if (wellKnown[path]) return json({ id: wellKnown[path] });
      if (path === '/me/mailFolders' && !url.searchParams.has('$skiptoken')) {
        return json({
          value: [
            { id: 'inbox', displayName: 'Inbox', childFolderCount: 1 },
            { id: 'del', displayName: 'Deleted Items', childFolderCount: 1 },
          ],
          '@odata.nextLink': `${GRAPH_BASE_URL}/me/mailFolders?$skiptoken=x`,
        });
      }
      if (path === '/me/mailFolders') {
        return json({
          value: [
            { id: 'junk', displayName: 'Junk Email', childFolderCount: 0 },
            { id: 'drafts', displayName: 'Drafts', childFolderCount: 0 },
            { id: 'sent', displayName: 'Sent Items', childFolderCount: 0 },
          ],
        });
      }
      if (path === '/me/mailFolders/inbox/childFolders') {
        return json({ value: [{ id: 'proj', displayName: 'Projects', childFolderCount: 0 }] });
      }
      return json({ error: { code: 'unexpected' } }, 500);
    });
    const folders = await createGraphClient({ tokens: tokens(), fetchFn }).listFolders();
    expect(folders).toEqual([
      { folderKey: 'inbox', name: 'Inbox', authored: false },
      { folderKey: 'proj', name: 'Inbox/Projects', authored: false },
      { folderKey: 'sent', name: 'Sent Items', authored: true },
    ]);
  });

  it('treats a missing well-known folder as absent', async () => {
    const { fetchFn } = fakeFetch((url) => {
      const path = p(url);
      if (path === '/me/mailFolders/junkemail')
        return json({ error: { code: 'ErrorItemNotFound' } }, 404);
      if (path.startsWith('/me/mailFolders/')) return json({ id: path.split('/').pop() });
      return json({ value: [{ id: 'inbox', displayName: 'Inbox', childFolderCount: 0 }] });
    });
    await expect(createGraphClient({ tokens: tokens(), fetchFn }).listFolders()).resolves.toEqual([
      { folderKey: 'inbox', name: 'Inbox', authored: false },
    ]);
  });

  it('builds the initial delta query and ignores @removed entries', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({
        value: [{ id: 'm1' }, { id: 'm2', '@removed': { reason: 'deleted' } }, { id: 'm3' }],
        '@odata.nextLink': `${GRAPH_BASE_URL}/me/mailFolders/inbox/messages/delta?$skiptoken=abc`,
      }),
    );
    const client = createGraphClient({ tokens: tokens(), fetchFn });
    const page = await client.deltaMessages('inbox', { from: '2024-01-01', maxPageSize: 50 });
    expect(page).toEqual({
      ids: ['m1', 'm3'],
      nextLink: `${GRAPH_BASE_URL}/me/mailFolders/inbox/messages/delta?$skiptoken=abc`,
      deltaLink: undefined,
    });
    const url = calls[0]!.url;
    expect(p(url)).toBe('/me/mailFolders/inbox/messages/delta');
    expect(url.searchParams.get('$select')).toBe('id');
    expect(url.searchParams.get('$filter')).toBe('receivedDateTime ge 2024-01-01T00:00:00Z');
    expect(calls[0]!.prefer).toBe('odata.maxpagesize=50');

    await client.deltaMessages('inbox', { nextLink: page.nextLink });
    expect(calls[1]!.url.toString()).toBe(page.nextLink);
  });

  it('omits the date filter when no from date is set', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/d' }),
    );
    await createGraphClient({ tokens: tokens(), fetchFn }).deltaMessages('inbox', { from: null });
    expect(calls[0]!.url.searchParams.has('$filter')).toBe(false);
  });

  it('downloads raw MIME from $value', async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response('Subject: hi\r\n\r\nbody'));
    const raw = await createGraphClient({ tokens: tokens(), fetchFn }).getMime('AAk=/x');
    expect(raw.toString()).toBe('Subject: hi\r\n\r\nbody');
    expect(calls[0]!.url.pathname).toBe('/v1.0/me/messages/AAk%3D%2Fx/$value');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const t = tokens();
    const { fetchFn, calls } = fakeFetch((_u, init) =>
      new Headers(init.headers).get('authorization') === 'Bearer tok-2'
        ? json({ mail: 'a@b.test' })
        : json({}, 401),
    );
    await expect(createGraphClient({ tokens: t, fetchFn }).getMe()).resolves.toEqual({
      address: 'a@b.test',
    });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('maps 401 after refresh to MailAuthError', async () => {
    const t = tokens();
    const { fetchFn } = fakeFetch(() => json({}, 401));
    await expect(createGraphClient({ tokens: t, fetchFn }).getMe()).rejects.toBeInstanceOf(
      MailAuthError,
    );
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it('propagates MailAuthError from a failed refresh (invalid_grant)', async () => {
    const t = tokens();
    t.refresh.mockRejectedValueOnce(new MailAuthError());
    const { fetchFn } = fakeFetch(() => json({}, 401));
    await expect(createGraphClient({ tokens: t, fetchFn }).getMe()).rejects.toBeInstanceOf(
      MailAuthError,
    );
  });

  it('honours Retry-After on 429 and 503', async () => {
    const a = fakeFetch(() => json({}, 429, { 'retry-after': '7' }));
    const err = await createGraphClient({ tokens: tokens(), fetchFn: a.fetchFn })
      .getMime('m')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(7000);

    const b = fakeFetch(() => json({}, 503));
    const err2 = await createGraphClient({ tokens: tokens(), fetchFn: b.fetchFn })
      .getMime('m')
      .catch((e: unknown) => e);
    expect((err2 as RateLimitedError).retryAfterMs).toBe(30_000);
  });

  it('maps an expired delta (410) to HistoryExpiredError', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: { code: 'syncStateNotFound' } }, 410));
    await expect(
      createGraphClient({ tokens: tokens(), fetchFn }).deltaMessages('inbox', {
        deltaLink: 'https://graph.microsoft.com/d',
      }),
    ).rejects.toBeInstanceOf(HistoryExpiredError);
  });
});

function fakeClient(overrides: Partial<GraphClient> = {}): GraphClient {
  return {
    getMe: async () => ({ address: 'me@contoso.test' }),
    listFolders: async () => [
      { folderKey: 'inbox', name: 'Inbox', authored: false },
      { folderKey: 'sent', name: 'Sent Items', authored: true },
    ],
    deltaMessages: async () => ({ ids: [] }),
    getMime: async (id) => Buffer.from(`raw-${id}`),
    ...overrides,
  };
}

const fresh = (folderKey: string): FolderState => ({
  folderKey,
  initialCheckpoint: null,
  cursor: null,
  initialComplete: false,
});

describe('graph fetcher', () => {
  it('pages the initial delta via nextLink and finishes with a deltaLink cursor', async () => {
    const deltaMessages = vi
      .fn<GraphClient['deltaMessages']>()
      .mockResolvedValueOnce({ ids: ['a', 'b'], nextLink: 'https://graph.microsoft.com/next1' })
      .mockResolvedValueOnce({ ids: ['c'], deltaLink: 'https://graph.microsoft.com/delta1' });
    const fetcher = createGraphFetcher(fakeClient({ deltaMessages }));
    const opts = {
      mode: 'initial' as const,
      dateRange: { from: '2024-01-01', to: null },
      limit: 2,
    };

    const p1 = await fetcher.listPage(fresh('inbox'), opts);
    expect(deltaMessages).toHaveBeenLastCalledWith('inbox', {
      from: '2024-01-01',
      nextLink: undefined,
      maxPageSize: 2,
    });
    expect(p1.refs).toEqual([
      { providerRef: 'a', folderKey: 'inbox' },
      { providerRef: 'b', folderKey: 'inbox' },
    ]);
    expect(p1.folderDone).toBe(false);
    expect(p1.state.initialCheckpoint).toEqual({ nextLink: 'https://graph.microsoft.com/next1' });

    const p2 = await fetcher.listPage(p1.state, opts);
    expect(deltaMessages).toHaveBeenLastCalledWith('inbox', {
      from: undefined,
      nextLink: 'https://graph.microsoft.com/next1',
      maxPageSize: 2,
    });
    expect(p2.folderDone).toBe(true);
    expect(p2.state).toEqual({
      folderKey: 'inbox',
      initialCheckpoint: null,
      cursor: { deltaLink: 'https://graph.microsoft.com/delta1' },
      initialComplete: true,
    });
  });

  it('reads incrementally from the cursor and advances it', async () => {
    const deltaMessages = vi
      .fn<GraphClient['deltaMessages']>()
      .mockResolvedValueOnce({ ids: ['n1'], nextLink: 'https://graph.microsoft.com/next2' })
      .mockResolvedValueOnce({ ids: ['n2'], deltaLink: 'https://graph.microsoft.com/delta2' });
    const fetcher = createGraphFetcher(fakeClient({ deltaMessages }));
    const opts = { mode: 'incremental' as const, dateRange: {}, limit: 100 };
    const start: FolderState = {
      folderKey: 'inbox',
      initialCheckpoint: null,
      cursor: { deltaLink: 'https://graph.microsoft.com/delta1' },
      initialComplete: true,
    };

    const a = await fetcher.listPage(start, opts);
    expect(deltaMessages).toHaveBeenLastCalledWith('inbox', {
      deltaLink: 'https://graph.microsoft.com/delta1',
      maxPageSize: 100,
    });
    expect(a.folderDone).toBe(false);
    expect(a.state.cursor).toEqual({ deltaLink: 'https://graph.microsoft.com/next2' });

    const b = await fetcher.listPage(a.state, opts);
    expect(b.folderDone).toBe(true);
    expect(b.refs).toEqual([{ providerRef: 'n2', folderKey: 'inbox' }]);
    expect(b.state.cursor).toEqual({ deltaLink: 'https://graph.microsoft.com/delta2' });
    await expect(fetcher.listPage(fresh('inbox'), opts)).rejects.toThrow('graph_missing_cursor');
  });

  it('fetches MIME with at most 4 requests in flight and marks Sent Items as authored', async () => {
    let inFlight = 0;
    let peak = 0;
    const getMime = vi.fn(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (id === 'bad') throw new Error('graph_http_404');
      return Buffer.from(`raw-${id}`);
    });
    const fetcher = createGraphFetcher(fakeClient({ getMime }));
    const refs = [
      ...Array.from({ length: 10 }, (_, i) => ({ providerRef: `i${i}`, folderKey: 'inbox' })),
      { providerRef: 's1', folderKey: 'sent' },
      { providerRef: 'bad', folderKey: 'inbox' },
    ];
    const out = await fetcher.fetchMessages(refs);
    expect(peak).toBe(4);
    expect(out.size).toBe(12);
    expect(out.get('i0')).toEqual({
      raw: Buffer.from('raw-i0'),
      folders: ['inbox'],
      isSent: false,
    });
    expect(out.get('s1')).toEqual({ raw: Buffer.from('raw-s1'), folders: ['sent'], isSent: true });
    expect(out.get('bad')).toBeInstanceOf(Error);
  });

  it('aborts the whole page on auth or rate-limit failures', async () => {
    const fetcher = createGraphFetcher(
      fakeClient({
        getMime: async () => {
          throw new RateLimitedError(1000);
        },
      }),
    );
    await expect(
      fetcher.fetchMessages([{ providerRef: 'x', folderKey: 'inbox' }]),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('exposes the provider and mailbox address', async () => {
    const fetcher = createGraphFetcher(fakeClient());
    expect(fetcher.provider).toBe('microsoft');
    await expect(fetcher.getAddress()).resolves.toBe('me@contoso.test');
  });
});
