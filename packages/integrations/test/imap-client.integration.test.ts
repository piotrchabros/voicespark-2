import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImapFetcher, verifyConnection, type ImapConfig } from '../src/imap';
import {
  ImapConnectError,
  UidValidityChangedError,
  type FetchedMessage,
  type FolderState,
} from '../src/mail';

// GreenMail runs with auth disabled: any login works and auto-creates the mailbox. Its IMAPS
// certificate is self-signed, so tests (only) pass rejectUnauthorized: false.
const HOST = process.env.GREENMAIL_HOST ?? 'localhost';
const insecure = { rejectUnauthorized: false };

function config(user: string): ImapConfig {
  return { host: HOST, port: 3993, tlsMode: 'tls', username: user, password: 'secret' };
}

function message(n: number, date: Date): string {
  return [
    `Message-ID: <imap-${n}-${randomUUID()}@greenmail.test>`,
    `From: Author <author@greenmail.test>`,
    `To: Reader <reader@greenmail.test>`,
    `Subject: Weekly notes ${n}`,
    `Date: ${date.toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Some plain prose for message ${n}.`,
    '',
  ].join('\r\n');
}

async function withAdmin<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({
    host: HOST,
    port: 3993,
    secure: true,
    auth: { user, pass: 'secret' },
    tls: insecure,
    logger: false,
  });
  c.on('error', () => {});
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

const user = `imap-${randomUUID()}@greenmail.test`;
const fresh = (folderKey: string): FolderState => ({
  folderKey,
  initialCheckpoint: null,
  cursor: null,
  initialComplete: false,
});

beforeAll(async () => {
  await withAdmin(user, async (c) => {
    await c.mailboxCreate('Sent').catch(() => undefined);
    await c.mailboxCreate('Trash').catch(() => undefined);
    // INBOX: two in range (Mar 2024) and one outside it (Jan 2023).
    await c.append(
      'INBOX',
      message(1, new Date('2024-03-01T10:00:00Z')),
      [],
      new Date('2024-03-01T10:00:00Z'),
    );
    await c.append(
      'INBOX',
      message(2, new Date('2024-03-15T10:00:00Z')),
      [],
      new Date('2024-03-15T10:00:00Z'),
    );
    await c.append(
      'INBOX',
      message(3, new Date('2023-01-10T10:00:00Z')),
      [],
      new Date('2023-01-10T10:00:00Z'),
    );
    await c.append(
      'Sent',
      message(4, new Date('2024-03-20T10:00:00Z')),
      [],
      new Date('2024-03-20T10:00:00Z'),
    );
    await c.append(
      'Trash',
      message(5, new Date('2024-03-21T10:00:00Z')),
      [],
      new Date('2024-03-21T10:00:00Z'),
    );
  });
});

describe('imap verifyConnection', () => {
  it('succeeds against GreenMail with the test-only TLS hook', async () => {
    await expect(verifyConnection(config(user), insecure)).resolves.toBeUndefined();
  });

  it('rejects the self-signed certificate by default', async () => {
    const err = await verifyConnection(config(user)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapConnectError);
    expect((err as ImapConnectError).code).toBe('imap_connection_failed');
  });

  it('reports imap_connection_failed for a closed port', async () => {
    const err = await verifyConnection({ ...config(user), port: 1 }, insecure).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ImapConnectError);
    expect((err as ImapConnectError).code).toBe('imap_connection_failed');
  });
});

describe('imap fetcher', () => {
  const fetcher = createImapFetcher(config(user), insecure);
  afterAll(() => fetcher.close());

  it('lists folders, skipping Trash and marking Sent as authored', async () => {
    const folders = await fetcher.listFolders();
    const byKey = new Map(folders.map((f) => [f.folderKey, f]));
    expect(byKey.get('INBOX')?.authored).toBe(false);
    expect(byKey.get('Sent')?.authored).toBe(true);
    expect(byKey.has('Trash')).toBe(false);
    await expect(fetcher.getAddress()).resolves.toBe(user);
  });

  it('skips every junk/trash/drafts folder by name, not just one per role', async () => {
    const junkUser = `imap-junk-${randomUUID()}@greenmail.test`;
    let delimiter = '/';
    await withAdmin(junkUser, async (c) => {
      delimiter = (await c.list()).find((b) => b.path === 'INBOX')?.delimiter ?? '/';
      const boxes = ['Spam', 'Junk', 'Trash', 'Deleted Items', 'Kosz', 'Projects'];
      // A subfolder of Trash (real hierarchy, using the server's delimiter).
      boxes.push(`Trash${delimiter}Old`);
      for (const [i, box] of boxes.entries()) {
        await c.mailboxCreate(box).catch(() => undefined);
        const d = new Date('2024-03-05T10:00:00Z');
        await c.append(box, message(100 + i, d), [], d);
      }
      const d = new Date('2024-03-06T10:00:00Z');
      await c.append('INBOX', message(200, d), [], d);
    });
    const f = createImapFetcher(config(junkUser), insecure);
    try {
      const keys = (await f.listFolders()).map((x) => x.folderKey).sort();
      expect(keys).toEqual(['INBOX', 'Projects']);
    } finally {
      await f.close();
    }
  });

  it('pages the date range, fetches sources and never sets \\Seen', async () => {
    const dateRange = { from: '2024-03-01', to: '2024-03-31' };
    const p1 = await fetcher.listPage(fresh('INBOX'), { mode: 'initial', dateRange, limit: 1 });
    expect(p1.refs).toHaveLength(1);
    expect(p1.folderDone).toBe(false);
    expect(p1.state.initialCheckpoint).toMatchObject({ uidNext: expect.any(Number) });
    expect(p1.totalEstimate).toBe(2);

    const p2 = await fetcher.listPage(p1.state, { mode: 'initial', dateRange, limit: 1 });
    expect(p2.refs).toHaveLength(1);
    expect(p2.folderDone).toBe(true);
    expect(p2.state.initialComplete).toBe(true);
    expect(p2.state.initialCheckpoint).toBeNull();
    expect(p2.state.cursor).toMatchObject({ uidValidity: expect.any(String), lastUid: 3 });

    const refs = [...p1.refs, ...p2.refs];
    expect(new Set(refs.map((r) => r.providerRef)).size).toBe(2);
    for (const r of refs) expect(r.providerRef).toMatch(/^INBOX\|\d+\|\d+$/);

    const sent = await fetcher.listPage(fresh('Sent'), { mode: 'initial', dateRange, limit: 50 });
    expect(sent.refs).toHaveLength(1);

    const out = await fetcher.fetchMessages([...refs, ...sent.refs]);
    expect(out.size).toBe(3);
    const subjects = [...out.values()].map((m) => {
      expect(m).not.toBeInstanceOf(Error);
      return (m as FetchedMessage).raw.toString('utf8').match(/^Subject: (.*)$/m)?.[1];
    });
    expect(subjects.sort()).toEqual(['Weekly notes 1', 'Weekly notes 2', 'Weekly notes 4']);
    const sentMsg = out.get(sent.refs[0]!.providerRef) as FetchedMessage;
    expect(sentMsg).toMatchObject({ folders: ['Sent'], isSent: true });
    expect((out.get(refs[0]!.providerRef) as FetchedMessage).isSent).toBe(false);

    const flags = await withAdmin(user, async (c) => {
      await c.mailboxOpen('INBOX', { readOnly: true });
      const msgs = await c.fetchAll('1:*', { flags: true, uid: true });
      return msgs.map((m) => [...(m.flags ?? [])]);
    });
    expect(flags).toHaveLength(3);
    for (const f of flags) expect(f).not.toContain('\\Seen');
  });

  it('reads new mail incrementally after the cursor', async () => {
    const done = await fetcher.listPage(fresh('INBOX'), {
      mode: 'initial',
      dateRange: {},
      limit: 50,
    });
    expect(done.refs).toHaveLength(3);
    expect(done.folderDone).toBe(true);

    const idle = await fetcher.listPage(done.state, {
      mode: 'incremental',
      dateRange: {},
      limit: 50,
    });
    expect(idle.refs).toHaveLength(0);
    expect(idle.folderDone).toBe(true);
    expect(idle.state.cursor).toEqual(done.state.cursor);

    await withAdmin(user, (c) => c.append('INBOX', message(6, new Date()), []));
    const next = await fetcher.listPage(idle.state, {
      mode: 'incremental',
      dateRange: {},
      limit: 50,
    });
    expect(next.refs).toHaveLength(1);
    expect(next.state.cursor).toMatchObject({ lastUid: 4 });
  });

  it('detects a UIDVALIDITY change', async () => {
    const stale: FolderState = {
      folderKey: 'INBOX',
      initialCheckpoint: null,
      cursor: { uidValidity: '1', lastUid: 1 },
      initialComplete: true,
    };
    const err = await fetcher
      .listPage(stale, { mode: 'incremental', dateRange: {}, limit: 50 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UidValidityChangedError);
    expect((err as UidValidityChangedError).folderKey).toBe('INBOX');

    const out = await fetcher.fetchMessages([{ providerRef: 'INBOX|1|1', folderKey: 'INBOX' }]);
    expect(out.get('INBOX|1|1')).toBeInstanceOf(UidValidityChangedError);
  });
});
