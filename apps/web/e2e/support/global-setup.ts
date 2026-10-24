import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type FullConfig } from '@playwright/test';
import { Redis } from 'ioredis';
import { closeDb, getPool } from '@voicespark/db/client';
import { startMemoryRpcServer } from '@voicespark/integrations/testing';
import { E2E_ADMIN_DATABASE_URL, E2E_BASE_URL, E2E_DB_NAME, E2E_ENV, E2E_MEMORY_PORT } from './env';
import { FailableMemoryStore, restoreMemoryStore } from './memory';

// Runs in the Playwright runner main process, which lives for the whole run (after the webServer is up). It owns
// exactly three things and tears down only those: the e2e database contents, the memory RPC server and the worker
// process group it spawned (tracked by pid; nothing is ever killed by name).

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WORKER_DIR = join(REPO_ROOT, 'apps/worker');
const WEB_DIR = join(REPO_ROOT, 'apps/web');
const STATE_DIR = join(tmpdir(), 'vs-e2e');
const WORKER_PID_FILE = join(STATE_DIR, 'worker.pid');
/** Marker in the worker's environment: a stale pid is only killed when it still carries it. */
const WORKER_MARKER = 'VS_E2E_WORKER=1';
const WORKER_READY_TIMEOUT_MS = 60_000;
const HUB_WARMUP_ID = '00000000-0000-4000-8000-000000000000';
const WARMUP_PATHS = [
  '/sign-in',
  '/dashboard',
  '/drafts',
  // Hub screens and API (the record detail route is compiled even when the id is unknown).
  ...(['people', 'companies', 'projects'] as const).flatMap((kind) => [
    `/hub/${kind}`,
    `/hub/${kind}/new`,
    `/hub/${kind}/${HUB_WARMUP_ID}`,
    `/api/hub/${kind}`,
    `/api/hub/${kind}/${HUB_WARMUP_ID}`,
  ]),
  // Links, notes and files (US2); one kind each compiles the dynamic routes.
  `/api/hub/people/${HUB_WARMUP_ID}/notes`,
  `/api/hub/people/${HUB_WARMUP_ID}/files`,
  '/api/hub/links',
  `/api/hub/links/${HUB_WARMUP_ID}`,
  `/api/hub/notes/${HUB_WARMUP_ID}`,
  `/api/hub/files/${HUB_WARMUP_ID}`,
  `/api/hub/files/${HUB_WARMUP_ID}/download`,
  // Admin screens and routes with the hub counts, and the account deletion dialog (US8). The warm-up user is not an
  // admin, so these compile the route and render the 403 panel.
  '/admin',
  `/admin/users/${HUB_WARMUP_ID}`,
  `/api/admin/users/${HUB_WARMUP_ID}`,
  '/api/admin/system/health',
  '/settings/account',
  // Memory store sync (US7).
  '/hub/settings',
  '/api/hub/sync',
  '/api/hub/sync/retry',
  '/api/hub/sync/resync',
  // Search (US5).
  '/hub/search',
  '/api/hub/search',
  // Mailboxes, ignore rules and conversation sources (US3).
  '/api/hub/mailboxes',
  `/api/hub/mailboxes/${HUB_WARMUP_ID}/enable`,
  `/api/hub/mailboxes/${HUB_WARMUP_ID}/disable`,
  `/api/hub/mailboxes/${HUB_WARMUP_ID}/threads/${HUB_WARMUP_ID}/retry`,
  '/api/hub/ignore-rules',
  `/api/hub/ignore-rules/${HUB_WARMUP_ID}`,
  `/api/hub/people/${HUB_WARMUP_ID}/sources`,
  `/sources/${HUB_WARMUP_ID}`,
  // Suggestions and merge (US4).
  '/hub/suggestions',
  '/api/hub/suggestions',
  '/api/hub/suggestions/count',
  '/api/hub/suggestions/decide',
  `/api/hub/people/${HUB_WARMUP_ID}/merge-preview`,
  `/api/hub/people/${HUB_WARMUP_ID}/merge`,
];

const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...E2E_ENV });

async function prepareDatabase(): Promise<void> {
  // The db client pool reads DATABASE_URL lazily: point it at the admin database just for these statements, then
  // close it so later users (scripts.sql) get a pool on the e2e database.
  const e2eUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = E2E_ADMIN_DATABASE_URL;
  try {
    const admin = getPool();
    if (process.env.E2E_FRESH_DB !== '0') {
      await admin.query(`DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)`);
    }
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB_NAME]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
  } finally {
    await closeDb();
    process.env.DATABASE_URL = e2eUrl;
  }
  for (const script of ['db:migrate', 'db:seed']) {
    const res = spawnSync('pnpm', [script], { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`e2e setup: pnpm ${script} failed (exit ${res.status})\n${res.stdout}\n${res.stderr}`);
    }
  }
}

async function flushRedis(): Promise<void> {
  const redis = new Redis(E2E_ENV.REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills a worker group left behind by a crashed run, but only if that pid is still our marked worker. */
function stopStaleWorker(): void {
  if (!existsSync(WORKER_PID_FILE)) return;
  const pid = Number(readFileSync(WORKER_PID_FILE, 'utf8').trim());
  rmSync(WORKER_PID_FILE, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return;
  let environ = '';
  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return;
  }
  if (!environ.split('\0').includes(WORKER_MARKER)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function stopWorker(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    // Negative pid: the worker's own process group (it was spawned detached), never anything else.
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000).unref());
  if ((await Promise.race([exited, timer])) === 'timeout') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    await exited;
  }
}

/** Spawns the worker (same entry as `pnpm --filter @voicespark/worker exec tsx src/index.ts`) and waits for ready. */
async function startWorker(logPath: string): Promise<ChildProcess> {
  const child = spawn(join(WORKER_DIR, 'node_modules/.bin/tsx'), ['src/index.ts'], {
    cwd: WORKER_DIR,
    env: { ...childEnv(), VS_E2E_WORKER: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) throw new Error('e2e setup: could not spawn the worker');
  writeFileSync(WORKER_PID_FILE, String(child.pid));

  const log = createWriteStream(logPath, { flags: 'a' });
  child.stderr!.pipe(log);
  await new Promise<void>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      reject(new Error(`e2e setup: worker not ready within ${WORKER_READY_TIMEOUT_MS} ms (log: ${logPath})`));
    }, WORKER_READY_TIMEOUT_MS);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`e2e setup: worker exited with ${code} before ready (log: ${logPath})`));
    };
    child.once('exit', onExit);
    child.stdout!.on('data', (chunk: Buffer) => {
      log.write(chunk);
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      if (lines.some((l) => l.includes('"status":"ready"'))) {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve();
      }
    });
  });
  return child;
}

/** next dev compiles routes on first hit; warming them keeps SC timings honest. Signs in a warm-up user. */
async function warmUp(): Promise<void> {
  const ctx = await request.newContext({ baseURL: E2E_BASE_URL, timeout: 180_000 });
  try {
    const res = await ctx.post('/api/auth/sign-in/social', {
      data: { provider: 'google', callbackURL: '/dashboard', disableRedirect: true },
    });
    if (res.ok()) {
      const { url } = (await res.json()) as { url: string };
      await ctx.get(`${url}${url.includes('?') ? '&' : '?'}login_hint=e2e-warmup%40example.test&name=Warmup`);
    }
    for (const path of WARMUP_PATHS) await ctx.get(path);
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  mkdirSync(STATE_DIR, { recursive: true });
  const resultsDir = join(WEB_DIR, 'test-results');
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(E2E_ENV.UPLOAD_TMP_DIR!, { recursive: true });

  stopStaleWorker();
  await prepareDatabase();
  await flushRedis();

  restoreMemoryStore();
  const memory = await startMemoryRpcServer({ port: E2E_MEMORY_PORT, store: new FailableMemoryStore() });
  let worker: ChildProcess | undefined;
  const teardown = async (): Promise<void> => {
    if (worker) await stopWorker(worker);
    rmSync(WORKER_PID_FILE, { force: true });
    await memory.close();
    restoreMemoryStore();
    // next dev may drop an AGENTS.md into the app directory; it is not part of the repo.
    rmSync(join(WEB_DIR, 'AGENTS.md'), { force: true });
  };

  try {
    worker = await startWorker(join(resultsDir, 'e2e-worker.log'));
    await warmUp();
  } catch (err) {
    await teardown();
    throw err;
  }
  return teardown;
}
