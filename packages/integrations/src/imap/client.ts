import { ImapFlow, type ImapFlowError, type MailboxObject } from 'imapflow';
import {
  ImapConnectError,
  MailAuthError,
  UidValidityChangedError,
  type DateRange,
  type FetchedMessage,
  type FolderState,
  type MailFetcher,
  type MailFolder,
  type MailPageResult,
  type MailRef,
} from '../mail';

export interface ImapConfig {
  host: string;
  port: number;
  tlsMode: 'tls' | 'starttls';
  username: string;
  password: string;
}

/** Test-only hook: `rejectUnauthorized` defaults to true and is never read from env. */
export interface ImapConnectOptions {
  rejectUnauthorized?: boolean;
}

/** UID batch size for FETCH (research R6). */
export const IMAP_FETCH_BATCH = 50;
/** Folders never read; `\All` is skipped too so messages are not counted twice. */
const SKIPPED_SPECIAL_USE = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\All']);
/**
 * Junk/trash/drafts folder names, compared after lowercasing and dropping spaces, hyphens and
 * underscores. Needed because without SPECIAL-USE imapflow guesses only ONE folder per role, so a
 * mailbox with both "Spam" and "Junk" (or "Trash" and "Deleted Items") would otherwise import one.
 */
const SKIPPED_FOLDER_NAMES = new Set(
  [
    'Spam',
    'Junk',
    'Junk E-mail',
    'Junk Email',
    'Junk Mail',
    'Bulk Mail',
    'Trash',
    'Deleted',
    'Deleted Items',
    'Deleted Messages',
    'Bin',
    'Kosz',
    'Wiadomości-śmieci',
    'Śmieci',
    'Drafts',
    'Szkice',
    'Wersje robocze',
  ].map(normaliseFolderName),
);

function normaliseFolderName(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * True when a listed folder must never be read: a junk/trash/drafts/all special-use flag, or any
 * path segment named like one (so "Trash/Old" is skipped too). Sent detection is separate.
 */
export function isSkippedImapFolder(f: {
  name: string;
  parent?: string[];
  specialUse?: string;
  flags?: Set<string>;
}): boolean {
  if (f.specialUse && SKIPPED_SPECIAL_USE.has(f.specialUse)) return true;
  for (const flag of f.flags ?? []) if (SKIPPED_SPECIAL_USE.has(flag)) return true;
  return [...(f.parent ?? []), f.name].some((s) =>
    SKIPPED_FOLDER_NAMES.has(normaliseFolderName(s)),
  );
}

const CONNECT_TIMEOUT_MS = 20_000;

function buildClient(cfg: ImapConfig, opts: ImapConnectOptions = {}): ImapFlow {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tlsMode === 'tls',
    doSTARTTLS: cfg.tlsMode === 'starttls' ? true : undefined,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: opts.rejectUnauthorized ?? true },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
  // Without a listener an async socket error would crash the process; failures surface via the awaited calls.
  client.on('error', () => {});
  return client;
}

function isAuthFailure(err: unknown): boolean {
  const e = err as ImapFlowError | undefined;
  return Boolean(e?.authenticationFailed) || e?.serverResponseCode === 'AUTHENTICATIONFAILED';
}

/** Connects, authenticates and logs out. Nothing is opened or stored. */
export async function verifyConnection(cfg: ImapConfig, opts?: ImapConnectOptions): Promise<void> {
  const client = buildClient(cfg, opts);
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw new ImapConnectError(isAuthFailure(err) ? 'imap_auth_failed' : 'imap_connection_failed');
  }
  await client.logout().catch(() => client.close());
}

function utcDay(day: string, addDays = 0): Date {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d;
}

/** SEARCH SINCE is inclusive; BEFORE is exclusive, so the inclusive `to` day becomes to + 1 day. */
function dateCriteria(range: DateRange): { since?: Date; before?: Date } {
  return {
    ...(range.from ? { since: utcDay(range.from) } : {}),
    ...(range.to ? { before: utcDay(range.to, 1) } : {}),
  };
}

export function parseImapRef(providerRef: string): {
  path: string;
  uidValidity: string;
  uid: number;
} {
  const last = providerRef.lastIndexOf('|');
  const mid = providerRef.lastIndexOf('|', last - 1);
  if (mid < 0) throw new Error('invalid_imap_ref');
  return {
    path: providerRef.slice(0, mid),
    uidValidity: providerRef.slice(mid + 1, last),
    uid: Number(providerRef.slice(last + 1)),
  };
}

/**
 * One lazily opened, read-only connection per fetcher. Every folder is opened with EXAMINE
 * (`readOnly: true`) and messages are fetched with BODY.PEEK (`source`), so `\Seen` is never set.
 * Calls are serialized because the connection has a single selected mailbox.
 */
export function createImapFetcher(cfg: ImapConfig, opts?: ImapConnectOptions): MailFetcher {
  let client: ImapFlow | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function getClient(): Promise<ImapFlow> {
    if (client?.usable) return client;
    client?.close();
    const next = buildClient(cfg, opts);
    try {
      await next.connect();
    } catch (err) {
      next.close();
      client = undefined;
      if (isAuthFailure(err)) throw new MailAuthError('IMAP authentication failed');
      throw new ImapConnectError('imap_connection_failed');
    }
    client = next;
    return next;
  }

  async function open(path: string): Promise<{ c: ImapFlow; box: MailboxObject }> {
    const c = await getClient();
    const box = await c.mailboxOpen(path, { readOnly: true });
    return { c, box };
  }

  async function searchUids(
    c: ImapFlow,
    query: Parameters<ImapFlow['search']>[0],
  ): Promise<number[]> {
    const found = await c.search(query, { uid: true });
    return (Array.isArray(found) ? found : []).sort((a, b) => a - b);
  }

  return {
    provider: 'imap',

    async getAddress() {
      return cfg.username;
    },

    listFolders: () =>
      serial(async (): Promise<MailFolder[]> => {
        const c = await getClient();
        const list = await c.list();
        return list
          .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
          .filter((f) => !isSkippedImapFolder(f))
          .map((f) => ({ folderKey: f.path, name: f.path, authored: f.specialUse === '\\Sent' }));
      }),

    listPage: (folder, { mode, dateRange, limit }) =>
      serial(async (): Promise<MailPageResult> => {
        const path = folder.folderKey;
        const { c, box } = await open(path);
        const uidValidity = box.uidValidity.toString();
        const toRefs = (uids: number[]): MailRef[] =>
          uids.map((uid) => ({ providerRef: `${path}|${uidValidity}|${uid}`, folderKey: path }));

        if (mode === 'incremental') {
          const cursor = folder.cursor;
          if (!cursor || !('uidValidity' in cursor)) throw new Error('imap_missing_cursor');
          if (cursor.uidValidity !== uidValidity) throw new UidValidityChangedError(path);
          // `n:*` always matches the newest message, so UIDs at or below the cursor are dropped.
          const uids = (await searchUids(c, { uid: `${cursor.lastUid + 1}:*` })).filter(
            (u) => u > cursor.lastUid,
          );
          const page = uids.slice(0, limit);
          const lastUid = page.at(-1) ?? cursor.lastUid;
          const state: FolderState = { ...folder, cursor: { uidValidity, lastUid } };
          return { refs: toRefs(page), state, folderDone: uids.length <= limit };
        }

        const checkpoint = folder.initialCheckpoint;
        const from = checkpoint && 'uidNext' in checkpoint ? checkpoint.uidNext : 1;
        const uids = (await searchUids(c, { uid: `${from}:*`, ...dateCriteria(dateRange) })).filter(
          (u) => u >= from,
        );
        const page = uids.slice(0, limit);
        if (uids.length > limit) {
          const state: FolderState = {
            ...folder,
            initialCheckpoint: { uidNext: (page.at(-1) ?? from - 1) + 1 },
            initialComplete: false,
          };
          return { refs: toRefs(page), state, folderDone: false, totalEstimate: uids.length };
        }
        // Incremental sync continues after everything that existed when the initial scan finished.
        const lastUid = Math.max(page.at(-1) ?? 0, (box.uidNext || 1) - 1, from - 1);
        const state: FolderState = {
          folderKey: path,
          initialCheckpoint: null,
          cursor: { uidValidity, lastUid },
          initialComplete: true,
        };
        return { refs: toRefs(page), state, folderDone: true, totalEstimate: uids.length };
      }),

    fetchMessages: (refs) =>
      serial(async () => {
        const out = new Map<string, FetchedMessage | Error>();
        const byFolder = new Map<string, { uidValidity: string; uid: number; ref: string }[]>();
        for (const r of refs) {
          const parsed = parseImapRef(r.providerRef);
          const list = byFolder.get(parsed.path) ?? [];
          list.push({ uidValidity: parsed.uidValidity, uid: parsed.uid, ref: r.providerRef });
          byFolder.set(parsed.path, list);
        }

        for (const [path, items] of byFolder) {
          const { c, box } = await open(path);
          const uidValidity = box.uidValidity.toString();
          const isSent = box.specialUse === '\\Sent';
          const wanted = new Map<number, string>();
          for (const it of items) {
            if (it.uidValidity === uidValidity) wanted.set(it.uid, it.ref);
            else out.set(it.ref, new UidValidityChangedError(path));
          }
          const uids = [...wanted.keys()];
          for (let i = 0; i < uids.length; i += IMAP_FETCH_BATCH) {
            const batch = uids.slice(i, i + IMAP_FETCH_BATCH);
            // `source` is fetched as BODY.PEEK[], which never sets \Seen.
            const msgs = await c.fetchAll(
              batch.join(','),
              { source: true, uid: true },
              { uid: true },
            );
            for (const m of msgs) {
              const ref = wanted.get(m.uid);
              if (ref && m.source) out.set(ref, { raw: m.source, folders: [path], isSent });
            }
          }
          for (const [, ref] of wanted)
            if (!out.has(ref)) out.set(ref, new Error('imap_message_not_found'));
        }
        return out;
      }),

    close: () =>
      serial(async () => {
        const c = client;
        client = undefined;
        if (!c) return;
        await c.logout().catch(() => c.close());
      }),
  };
}
