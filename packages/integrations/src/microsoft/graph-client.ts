import {
  HistoryExpiredError,
  MailAuthError,
  RateLimitedError,
  mapLimit,
  type FetchedMessage,
  type FolderState,
  type MailFetcher,
  type MailFolder,
  type MailPageResult,
  type MailRef,
  type TokenProvider,
} from '../mail';

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
/** Graph allows at most 4 concurrent requests per mailbox (research R5). */
export const GRAPH_FETCH_CONCURRENCY = 4;
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Well-known folders that are never read (research R5). */
const SKIPPED_WELL_KNOWN = ['deleteditems', 'junkemail', 'drafts'] as const;

export interface GraphClient {
  getMe(): Promise<{ address: string }>;
  listFolders(): Promise<MailFolder[]>;
  deltaMessages(
    folderId: string,
    opts: { from?: string | null; deltaLink?: string; nextLink?: string; maxPageSize?: number },
  ): Promise<{ ids: string[]; nextLink?: string; deltaLink?: string }>;
  getMime(id: string): Promise<Buffer>;
}

interface GraphFolderJson {
  id: string;
  displayName?: string;
  childFolderCount?: number;
}

interface GraphPage<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - Date.now());
}

export function createGraphClient(opts: {
  tokens: TokenProvider;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}): GraphClient {
  const base = (opts.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));

  /** Absolute URLs (nextLink/deltaLink) are used as-is; paths are joined to the base. */
  async function request(
    pathOrUrl: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${base}${pathOrUrl}`;
    const send = (token: string) =>
      fetchFn(url, { method: 'GET', headers: { ...headers, authorization: `Bearer ${token}` } });

    let res = await send(await opts.tokens.get());
    if (res.status === 401) {
      // One refresh, then give up: the source needs reconnection (research R5). An invalid_grant
      // on refresh already surfaces as MailAuthError from the token provider.
      res = await send(await opts.tokens.refresh());
      if (res.status === 401) throw new MailAuthError('Microsoft mailbox access was rejected');
    }
    if (res.status === 429 || res.status === 503) throw new RateLimitedError(retryAfterMs(res));
    if (res.status === 410) throw new HistoryExpiredError('Microsoft delta state expired');
    if (!res.ok) throw new Error(`graph_http_${res.status}`);
    return res;
  }

  async function getJson<T>(pathOrUrl: string, headers?: Record<string, string>): Promise<T> {
    return (await (await request(pathOrUrl, headers)).json()) as T;
  }

  async function wellKnownId(name: string): Promise<string | null> {
    try {
      return (await getJson<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id;
    } catch (err) {
      // A mailbox may lack a well-known folder; only a plain HTTP failure means "absent".
      if (err instanceof Error && /^graph_http_(404|400)$/.test(err.message)) return null;
      throw err;
    }
  }

  async function listAll(path: string): Promise<GraphFolderJson[]> {
    const out: GraphFolderJson[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: GraphPage<GraphFolderJson> = await getJson<GraphPage<GraphFolderJson>>(next);
      out.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return out;
  }

  return {
    async getMe() {
      const me = await getJson<{ mail?: string | null; userPrincipalName?: string | null }>(
        '/me?$select=mail,userPrincipalName',
      );
      const address = me.mail ?? me.userPrincipalName;
      if (!address) throw new Error('graph_no_address');
      return { address };
    },

    async listFolders() {
      const skipped = new Set(
        (await Promise.all(SKIPPED_WELL_KNOWN.map(wellKnownId))).filter(
          (id): id is string => id !== null,
        ),
      );
      const sentId = await wellKnownId('sentitems');
      const select = '$top=100&$select=id,displayName,childFolderCount';
      const folders: MailFolder[] = [];

      const walk = async (items: GraphFolderJson[], parent: string | null): Promise<void> => {
        for (const f of items) {
          // Subfolders of a skipped folder (e.g. inside Deleted Items) are skipped too.
          if (skipped.has(f.id)) continue;
          const name = parent ? `${parent}/${f.displayName ?? ''}` : (f.displayName ?? '');
          folders.push({ folderKey: f.id, name, authored: f.id === sentId });
          if ((f.childFolderCount ?? 0) > 0) {
            await walk(
              await listAll(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${select}`),
              name,
            );
          }
        }
      };
      await walk(await listAll(`/me/mailFolders?${select}`), null);
      return folders;
    },

    async deltaMessages(folderId, o) {
      let url = o.nextLink ?? o.deltaLink;
      if (!url) {
        const params = new URLSearchParams({ $select: 'id' });
        if (o.from) params.set('$filter', `receivedDateTime ge ${o.from}T00:00:00Z`);
        url = `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?${params.toString()}`;
      }
      const headers: Record<string, string> = o.maxPageSize
        ? { prefer: `odata.maxpagesize=${o.maxPageSize}` }
        : {};
      const page = await getJson<GraphPage<{ id: string; '@removed'?: unknown }>>(url, headers);
      return {
        // Removals are irrelevant: imported items are only removed by the user (FR-016).
        ids: (page.value ?? []).filter((m) => !m['@removed']).map((m) => m.id),
        nextLink: page['@odata.nextLink'],
        deltaLink: page['@odata.deltaLink'],
      };
    },

    async getMime(id) {
      const res = await request(`/me/messages/${encodeURIComponent(id)}/$value`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/**
 * Graph delta has no upper date bound: the import processor drops messages whose parsed date is
 * after the source's date_range_to. During an incremental round that spans several pages the
 * pending `@odata.nextLink` is kept in `cursor.deltaLink` (both are plain GET URLs).
 */
export function createGraphFetcher(client: GraphClient): MailFetcher {
  let authored: Promise<Set<string>> | undefined;
  const authoredFolders = (): Promise<Set<string>> =>
    (authored ??= client
      .listFolders()
      .then((fs) => new Set(fs.filter((f) => f.authored).map((f) => f.folderKey))));

  return {
    provider: 'microsoft',

    async getAddress() {
      return (await client.getMe()).address;
    },

    async listFolders() {
      const folders = await client.listFolders();
      authored = Promise.resolve(
        new Set(folders.filter((f) => f.authored).map((f) => f.folderKey)),
      );
      return folders;
    },

    async listPage(folder, { mode, dateRange, limit }): Promise<MailPageResult> {
      const toRefs = (ids: string[]): MailRef[] =>
        ids.map((id) => ({ providerRef: id, folderKey: folder.folderKey }));

      if (mode === 'incremental') {
        const cursor = folder.cursor;
        if (!cursor || !('deltaLink' in cursor)) throw new Error('graph_missing_cursor');
        const page = await client.deltaMessages(folder.folderKey, {
          deltaLink: cursor.deltaLink,
          maxPageSize: limit,
        });
        const link = page.deltaLink ?? page.nextLink;
        if (!link) throw new Error('graph_delta_without_link');
        const state: FolderState = { ...folder, cursor: { deltaLink: link } };
        return { refs: toRefs(page.ids), state, folderDone: !page.nextLink };
      }

      const checkpoint = folder.initialCheckpoint;
      const nextLink = checkpoint && 'nextLink' in checkpoint ? checkpoint.nextLink : undefined;
      const page = await client.deltaMessages(folder.folderKey, {
        from: nextLink ? undefined : dateRange.from,
        nextLink,
        maxPageSize: limit,
      });
      if (page.nextLink) {
        const state: FolderState = {
          ...folder,
          initialCheckpoint: { nextLink: page.nextLink },
          initialComplete: false,
        };
        return { refs: toRefs(page.ids), state, folderDone: false };
      }
      if (!page.deltaLink) throw new Error('graph_delta_without_link');
      const state: FolderState = {
        folderKey: folder.folderKey,
        initialCheckpoint: null,
        cursor: { deltaLink: page.deltaLink },
        initialComplete: true,
      };
      return { refs: toRefs(page.ids), state, folderDone: true };
    },

    async fetchMessages(refs) {
      const sent = await authoredFolders();
      const out = new Map<string, FetchedMessage | Error>();
      await mapLimit(refs, GRAPH_FETCH_CONCURRENCY, async (ref) => {
        try {
          const raw = await client.getMime(ref.providerRef);
          out.set(ref.providerRef, {
            raw,
            folders: [ref.folderKey],
            isSent: sent.has(ref.folderKey),
          });
        } catch (err) {
          // Mailbox-wide conditions abort the page; anything else is a per-message failure.
          if (err instanceof MailAuthError || err instanceof RateLimitedError) throw err;
          out.set(ref.providerRef, err instanceof Error ? err : new Error(String(err)));
        }
      });
      return out;
    },

    async close() {},
  };
}
