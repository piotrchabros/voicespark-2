import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FilteredText } from '@voicespark/filters';
import { InMemoryMemoryStore } from '../supermemory/in-memory';
import type { MemoryDoc } from '../supermemory/port';
import { MEMORY_RPC_METHODS, type MemoryRpcMethod } from '../supermemory/remote';

// Test-only code (e2e runner and the integrations contract test; D-E1). ESLint bans importing this module from
// application source, so it can never be wired into a running app.

const MAX_BODY_BYTES = 50 * 1024 * 1024;

function isMethod(m: unknown): m is MemoryRpcMethod {
  return typeof m === 'string' && (MEMORY_RPC_METHODS as readonly string[]).includes(m);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Re-brands documents that arrive over JSON (the brand does not survive serialization). */
function rebrand(docs: unknown): MemoryDoc[] {
  if (!Array.isArray(docs)) throw new Error('addDocuments expects an array of documents');
  return docs.map((d: MemoryDoc) => ({
    ...d,
    // The only cast to FilteredText outside @voicespark/filters: the content was branded by the calling process,
    // whose RemoteMemoryStore.addDocuments only accepts FilteredText; JSON transport drops the type brand.
    content: d.content as FilteredText,
  }));
}

async function dispatch(store: InMemoryMemoryStore, method: MemoryRpcMethod, args: unknown[]): Promise<unknown> {
  // Arguments are trusted test traffic from RemoteMemoryStore; only the document brand is restored explicitly.
  const a = args as [never, never, never];
  switch (method) {
    case 'addDocuments':
      return store.addDocuments(a[0], rebrand(args[1]));
    case 'getDocument':
      return store.getDocument(a[0], a[1]);
    case 'listDocuments':
      return store.listDocuments(a[0], a[1]);
    case 'search':
      return store.search(a[0], a[1]);
    case 'deleteDocuments':
      return store.deleteDocuments(a[0], a[1]);
    case 'updateDocumentMetadata':
      return store.updateDocumentMetadata(a[0], a[1], a[2]);
    case 'deleteNamespace':
      return store.deleteNamespace(a[0]);
    case 'listMemories':
      return store.listMemories(a[0]);
  }
}

/**
 * Serves an InMemoryMemoryStore over `POST /rpc` ({method, args} -> {result} | {error}) for RemoteMemoryStore
 * clients in other processes. Binds to 127.0.0.1 by default; `port: 0` picks a free port.
 */
export async function startMemoryRpcServer(opts: {
  port: number;
  host?: string;
  store?: InMemoryMemoryStore;
}): Promise<{ url: string; store: InMemoryMemoryStore; close(): Promise<void> }> {
  const store = opts.store ?? new InMemoryMemoryStore();
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      // `undefined` results (void methods) become null so the response is always valid JSON.
      res.end(JSON.stringify(body, (_k, v: unknown) => (v === undefined ? null : v)));
    };
    if (req.method !== 'POST' || req.url !== '/rpc') {
      req.resume();
      reply(404, { error: 'not found' });
      return;
    }
    void (async () => {
      let parsed: { method?: unknown; args?: unknown };
      try {
        parsed = JSON.parse(await readBody(req)) as { method?: unknown; args?: unknown };
      } catch (err) {
        reply(400, { error: err instanceof Error ? err.message : 'bad request' });
        return;
      }
      if (!isMethod(parsed.method) || !Array.isArray(parsed.args)) {
        reply(400, { error: 'unknown method or missing args' });
        return;
      }
      try {
        reply(200, { result: (await dispatch(store, parsed.method, parsed.args)) ?? null });
      } catch (err) {
        reply(500, { error: err instanceof Error ? err.message : 'store error' });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const urlHost = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
