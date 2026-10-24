// SC-010 (001), SC-007 (002) / constitution III: admin responses carry metadata, counts and aggregates only; admin code
// never reads *_enc columns or the memory store; an admin reaching another user's content gets
// not_found plus an `admin.content_access_denied` audit entry. Real test DB + Redis-test.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  connectedSource,
  contentItem,
  draft,
  getDb,
  hubCompany,
  hubCompanyDomain,
  hubFile,
  hubIgnoreRule,
  hubLink,
  hubMailboxSetting,
  hubNote,
  hubPersonEmail,
  hubProject,
} from '@voicespark/db';
import { QUEUES, closeQueues, getQueue } from '@voicespark/core/queues';
import { AppError } from '@voicespark/core/errors';
// Not package exports; reached by path as the seed does.
import { nameKey } from '@voicespark/core/hub/normalize';
import { indexTokens } from '@voicespark/core/hub/search-tokens';
import {
  ADMIN_FORBIDDEN_FIELDS,
  ADMIN_FORBIDDEN_FIELD_PATTERN,
  ADMIN_RESPONSE_SCHEMAS,
  adminJson,
} from '../../lib/admin-schemas';
import { cleanupIsolation, SECRET_MARKER, seedIsolation, type IsolationSeed } from './seed';

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@127.0.0.1:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://127.0.0.1:56379';
(process.env as Record<string, string | undefined>).NODE_ENV ??= 'test';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Only the session lookup is replaced: auditForeignAccess and requireFiltersConfirmed stay real.
const actor = vi.hoisted(() => ({
  current: null as { userId: string; role: 'user' | 'admin' } | null,
}));

vi.mock('../../lib/guards', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/guards')>();
  const { AppError: Err } = await import('@voicespark/core/errors');
  const requireUser = vi.fn(async () => {
    if (!actor.current) throw new Err('unauthenticated');
    return actor.current;
  });
  return {
    ...original,
    requireUser,
    requireAdmin: vi.fn(async () => {
      const ctx = await requireUser();
      if (ctx.role !== 'admin') throw new Err('admin_required');
      return ctx;
    }),
  };
});

// Preview runs go to the real Redis (56379) so the status route can read the job back; nothing
// else is enqueued. No worker consumes the test Redis, so the job stays queued until afterAll.
vi.mock('@voicespark/core/queues', async (importOriginal) => {
  const original = await importOriginal<typeof import('@voicespark/core/queues')>();
  return {
    ...original,
    enqueue: vi.fn(async (...args: Parameters<typeof original.enqueue>) =>
      args[0] === original.JOBS.analysisPreview ? original.enqueue(...args) : {},
    ),
  };
});

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = join(WEB_ROOT, '..', '..');
const API_ROOT = join(WEB_ROOT, 'app', 'api');
const ADMIN_API_ROOT = join(API_ROOT, 'admin');
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Verb = (typeof VERBS)[number];

/** Every admin route file (contracts/http-api.md "Admin"), relative to app/api/admin. */
const EXPECTED_ADMIN_ROUTES = [
  'users',
  'users/[id]',
  'users/[id]/suspend',
  'users/[id]/reinstate',
  'users/[id]/role',
  'definitions',
  'definitions/[id]',
  'definitions/[id]/versions',
  'definitions/[id]/versions/[versionId]',
  'definitions/[id]/versions/[versionId]/publish',
  'definitions/[id]/versions/[versionId]/diff',
  'definitions/[id]/versions/[versionId]/preview',
  'definitions/[id]/versions/[versionId]/preview-run',
  'definitions/[id]/versions/[versionId]/preview-run/[jobId]',
  'definitions/[id]/rollback',
  'definitions/[id]/availability',
  'definitions/[id]/history',
  'prompts',
  'prompts/[id]',
  'prompts/[id]/versions',
  'prompts/[id]/versions/[versionId]',
  'prompts/[id]/versions/[versionId]/publish',
  'prompts/[id]/versions/[versionId]/diff',
  'prompts/[id]/versions/[versionId]/validate',
  'prompts/[id]/versions/[versionId]/preview',
  'prompts/[id]/rollback',
  'prompts/[id]/history',
  'settings',
  'audit',
  'system/health',
  'metrics/ratings',
];

function walk(dir: string, match: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full, match);
    return match(full) ? [full] : [];
  });
}

const routeFile = (apiRoot: string, route: string) =>
  join(apiRoot, ...route.split('/'), 'route.ts');
const toPosix = (p: string) => p.split(sep).join('/');

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function loadRoute(file: string): Promise<Partial<Record<Verb, Handler>>> {
  return (await import(/* @vite-ignore */ file)) as Partial<Record<Verb, Handler>>;
}

interface CallResult {
  status: number;
  text: string;
  json: unknown;
}

async function call(
  apiRoot: string,
  route: string,
  verb: Verb,
  params: Record<string, string> = {},
  opts: { body?: unknown; query?: Record<string, string> } = {},
): Promise<CallResult> {
  const mod = await loadRoute(routeFile(apiRoot, route));
  const handler = mod[verb];
  if (!handler) throw new Error(`${verb} not exported by ${route}`);
  const path = route.replace(/\[(\w+)\]/g, (_m, k: string) => params[k] ?? 'missing');
  const prefix = apiRoot === ADMIN_API_ROOT ? '/api/admin/' : '/api/';
  const url = new URL(`http://localhost${prefix}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const init: RequestInit = { method: verb };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await handler(new Request(url, init), { params: Promise.resolve(params) });
  const text = await res.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, text, json };
}

/** JSON keys at any depth that are content-bearing or encrypted-column names. */
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const own =
      (ADMIN_FORBIDDEN_FIELDS as readonly string[]).includes(k) ||
      ADMIN_FORBIDDEN_FIELD_PATTERN.test(k)
        ? [`${path}.${k}`]
        : [];
    return [...own, ...forbiddenKeys(v, `${path}.${k}`)];
  });
}

/** Content keys added for the Context Hub (FR-029): never present at any depth of an admin response. */
const HUB_FORBIDDEN_FIELDS = [
  'summary',
  'evidence',
  'participants',
  'emails',
  'phone',
  'domains',
  'roleTitle',
  'industry',
  'website',
  'extractedText',
  'fileName',
] as const;

/** Any JSON key ending in `_enc` or `Enc`, however nested, as it appears in the raw response text. */
const ENC_KEY_IN_TEXT = /"[^"]*(?:_enc|Enc)"\s*:/;

/** Blind search token hashes of user U's seeded note (`-H5`): the index must never reach an admin. */
const hubTokenHashes = (sd: IsolationSeed) => indexTokens(sd.userU, [`${SECRET_MARKER}-H5`]);

const deniedCount = async (actorUserId: string, targetId: string) =>
  (
    await getDb()
      .select({ id: auditLogEntry.id })
      .from(auditLogEntry)
      .where(
        and(
          eq(auditLogEntry.action, 'admin.content_access_denied'),
          eq(auditLogEntry.actorUserId, actorUserId),
          eq(auditLogEntry.targetId, targetId),
        ),
      )
  ).length;

let seed: IsolationSeed;
/** Preview-run jobs the scenario enqueued on the real Redis; removed in afterAll. */
const previewJobIds: string[] = [];

beforeAll(async () => {
  seed = await seedIsolation();
}, 60_000);

afterAll(async () => {
  if (seed) await cleanupIsolation(seed);
  for (const jobId of previewJobIds) await (await getQueue(QUEUES.profile).getJob(jobId))?.remove();
  await closeQueues();
  await closeDb();
});

describe('adminJson', () => {
  it('fails closed on an undeclared field or an unknown route key', () => {
    const settings = { settings: [] };
    expect(adminJson('GET /api/admin/settings', settings).status).toBe(200);
    expect(() =>
      adminJson('GET /api/admin/settings', { ...settings, body: `${SECRET_MARKER} leak` }),
    ).toThrow(AppError);
    expect(() => adminJson('GET /api/admin/not-a-route', settings)).toThrow(AppError);
  });
});

// (a) Every admin route and verb, driven through a realistic scenario.

type State = Record<string, string>;
interface Step {
  route: string;
  verb: Verb;
  params?: (s: State) => Record<string, string>;
  query?: (s: State) => Record<string, string>;
  body?: (s: State) => unknown;
  save?: (json: unknown, s: State) => void;
  /** Skipped (not failed) when the route does not export the verb. */
  optional?: boolean;
}

const get = (json: unknown, ...path: string[]): string => {
  let v: unknown = json;
  for (const p of path)
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
  return typeof v === 'string' ? v : '';
};

function scenario(sd: IsolationSeed): Step[] {
  const u = () => ({ id: sd.userU });
  const def = (s: State) => ({ id: s.definitionId! });
  const defV = (key: string) => (s: State) => ({ id: s.definitionId!, versionId: s[key]! });
  const pr = (s: State) => ({ id: s.promptId! });
  const prV = (key: string) => (s: State) => ({ id: s.promptId!, versionId: s[key]! });
  // The seeded definition: user U has an own prompt and a document made with it.
  const seededV = () => ({ id: sd.definitionId, versionId: sd.definitionVersionId });
  return [
    // Users
    { route: 'users', verb: 'GET', query: () => ({ query: `iso-user-u-${sd.runId}` }) },
    { route: 'users/[id]', verb: 'GET', params: u },
    {
      route: 'users/[id]/suspend',
      verb: 'POST',
      params: u,
      body: () => ({ reason: 'isolation test' }),
    },
    { route: 'users/[id]/reinstate', verb: 'POST', params: u },
    { route: 'users/[id]/role', verb: 'PUT', params: u, body: () => ({ role: 'admin' }) },
    { route: 'users/[id]/role', verb: 'PUT', params: u, body: () => ({ role: 'user' }) },
    // Definitions: create -> draft -> patch -> publish -> new draft -> diff -> publish -> availability -> rollback -> history
    { route: 'definitions', verb: 'GET' },
    {
      route: 'definitions',
      verb: 'POST',
      body: () => ({
        key: `iso_scn_${sd.runId}`,
        name: 'Isolation scenario',
        description: 'Created by the admin isolation suite',
        analysisPrompt: 'Describe how this person writes: tone, rhythm and word choice.',
      }),
      save: (j, s) => {
        s.definitionId = get(j, 'definition', 'id');
        s.defDraft1 = get(j, 'draft', 'id');
      },
    },
    { route: 'definitions/[id]', verb: 'GET', params: def },
    {
      route: 'definitions/[id]/versions/[versionId]',
      verb: 'PATCH',
      params: defV('defDraft1'),
      body: () => ({ description: 'Patched by the admin isolation suite' }),
    },
    {
      route: 'definitions/[id]/versions/[versionId]/publish',
      verb: 'POST',
      params: defV('defDraft1'),
    },
    {
      route: 'definitions/[id]/versions',
      verb: 'POST',
      params: def,
      body: (s) => ({ fromVersionId: s.defDraft1 }),
      save: (j, s) => {
        s.defDraft2 = get(j, 'version', 'id');
      },
    },
    {
      route: 'definitions/[id]/versions/[versionId]',
      verb: 'PATCH',
      params: defV('defDraft2'),
      body: () => ({ name: 'Isolation scenario v2' }),
    },
    {
      route: 'definitions/[id]/versions/[versionId]/diff',
      verb: 'GET',
      params: defV('defDraft2'),
      query: (s) => ({ against: s.defDraft1! }),
    },
    {
      route: 'definitions/[id]/versions/[versionId]/preview',
      verb: 'POST',
      params: defV('defDraft2'),
      body: () => ({ kind: 'feedback' }),
    },
    {
      route: 'definitions/[id]/versions/[versionId]/preview-run',
      verb: 'POST',
      params: defV('defDraft2'),
      save: (j, s) => {
        s.previewJobId = get(j, 'jobId');
        previewJobIds.push(s.previewJobId);
      },
    },
    {
      route: 'definitions/[id]/versions/[versionId]/preview-run/[jobId]',
      verb: 'GET',
      params: (s) => ({ ...defV('defDraft2')(s), jobId: s.previewJobId! }),
      // A `save` makes a non-2xx a failure: the job must be readable back from Redis.
      save: (j, s) => {
        s.previewStatus = get(j, 'status');
      },
    },
    {
      route: 'definitions/[id]/versions/[versionId]/publish',
      verb: 'POST',
      params: defV('defDraft2'),
    },
    {
      route: 'definitions/[id]/availability',
      verb: 'PUT',
      params: def,
      body: () => ({ availability: 'available' }),
    },
    {
      route: 'definitions/[id]/rollback',
      verb: 'POST',
      params: def,
      body: (s) => ({ versionId: s.defDraft1 }),
    },
    { route: 'definitions/[id]/history', verb: 'GET', params: def },
    {
      route: 'definitions/[id]/versions',
      verb: 'POST',
      params: def,
      body: () => ({}),
      save: (j, s) => {
        s.defDraft3 = get(j, 'version', 'id');
      },
    },
    { route: 'definitions/[id]/versions/[versionId]', verb: 'DELETE', params: defV('defDraft3') },
    {
      route: 'definitions/[id]/availability',
      verb: 'PUT',
      params: def,
      body: () => ({ availability: 'retired' }),
    },
    // The seeded definition carries user U's own prompt and document: counts only.
    { route: 'definitions/[id]', verb: 'GET', params: () => ({ id: sd.definitionId }) },
    { route: 'definitions/[id]/history', verb: 'GET', params: () => ({ id: sd.definitionId }) },
    { route: 'definitions/[id]/versions/[versionId]/preview', verb: 'POST', params: seededV },
    // Prompts: custom create -> patch -> validate -> preview -> publish -> draft -> diff -> publish -> rollback -> history
    { route: 'prompts', verb: 'GET' },
    {
      route: 'prompts',
      verb: 'POST',
      body: () => ({
        key: `custom.iso_scn_${sd.runId}`,
        description: 'Created by the admin isolation suite',
        systemTemplate: 'You describe a writing voice.',
        userTemplate: 'Describe the voice of {{user.firstName}}.',
        model: 'claude-sonnet-5-5',
        effort: 'low',
        maxTokens: 1024,
      }),
      save: (j, s) => {
        s.promptId = get(j, 'prompt', 'id');
        s.prDraft1 = get(j, 'draft', 'id');
      },
    },
    { route: 'prompts/[id]', verb: 'GET', params: pr },
    {
      route: 'prompts/[id]/versions/[versionId]',
      verb: 'PATCH',
      params: prV('prDraft1'),
      body: () => ({ maxTokens: 2048 }),
    },
    { route: 'prompts/[id]/versions/[versionId]/validate', verb: 'POST', params: prV('prDraft1') },
    {
      route: 'prompts/[id]/versions/[versionId]/preview',
      verb: 'POST',
      params: prV('prDraft1'),
      body: () => ({}),
    },
    { route: 'prompts/[id]/versions/[versionId]/publish', verb: 'POST', params: prV('prDraft1') },
    {
      route: 'prompts/[id]/versions',
      verb: 'POST',
      params: pr,
      body: (s) => ({ fromVersionId: s.prDraft1 }),
      save: (j, s) => {
        s.prDraft2 = get(j, 'version', 'id');
      },
    },
    {
      route: 'prompts/[id]/versions/[versionId]/diff',
      verb: 'GET',
      params: prV('prDraft2'),
      query: (s) => ({ against: s.prDraft1! }),
    },
    { route: 'prompts/[id]/versions/[versionId]/publish', verb: 'POST', params: prV('prDraft2') },
    {
      route: 'prompts/[id]/rollback',
      verb: 'POST',
      params: pr,
      body: (s) => ({ versionId: s.prDraft1 }),
    },
    { route: 'prompts/[id]/history', verb: 'GET', params: pr },
    {
      route: 'prompts/[id]/versions',
      verb: 'POST',
      params: pr,
      body: () => ({}),
      save: (j, s) => {
        s.prDraft3 = get(j, 'version', 'id');
      },
    },
    {
      route: 'prompts/[id]/versions/[versionId]',
      verb: 'DELETE',
      params: prV('prDraft3'),
      optional: true,
    },
    // Settings, audit, system
    {
      route: 'settings',
      verb: 'GET',
      save: (j, s) => {
        const first = (j as { settings?: { key: string; value: number }[] })?.settings?.[0];
        if (first) {
          s.settingKey = first.key;
          s.settingValue = String(first.value);
        }
      },
    },
    // Writes the current value back, so the shared test DB is left unchanged.
    {
      route: 'settings',
      verb: 'PUT',
      body: (s) => ({ key: s.settingKey, value: Number(s.settingValue) }),
    },
    {
      route: 'audit',
      verb: 'GET',
      query: () => ({ action: 'admin.content_access_denied', limit: '5' }),
    },
    { route: 'audit', verb: 'GET', query: () => ({ actorUserId: sd.adminA }) },
    { route: 'system/health', verb: 'GET' },
    { route: 'metrics/ratings', verb: 'GET' },
  ];
}

describe('(a) admin responses are metadata only', () => {
  const discovered = () =>
    walk(ADMIN_API_ROOT, (f) => f.endsWith(`${sep}route.ts`)).map((f) =>
      toPosix(relative(ADMIN_API_ROOT, f)).replace(/\/?route\.ts$/, ''),
    );

  it('every expected admin route file exists', () => {
    const missing = EXPECTED_ADMIN_ROUTES.filter((r) => !existsSync(routeFile(ADMIN_API_ROOT, r)));
    expect(missing, 'missing admin route files').toEqual([]);
  });

  it('the scenario covers every exported (route, verb) pair', async () => {
    const steps = scenario(seed);
    const covered = new Set(steps.map((s) => `${s.verb} ${s.route}`));
    const unknown = steps.map((s) => s.route).filter((r) => !EXPECTED_ADMIN_ROUTES.includes(r));
    expect(unknown, 'scenario references routes outside the contract').toEqual([]);
    const uncovered: string[] = [];
    for (const route of discovered()) {
      const mod = await loadRoute(routeFile(ADMIN_API_ROOT, route));
      for (const verb of VERBS) {
        if (mod[verb] && !covered.has(`${verb} ${route}`)) uncovered.push(`${verb} ${route}`);
      }
    }
    expect(uncovered, 'admin (route, verb) pairs with no scenario step').toEqual([]);
    expect(discovered().length).toBeGreaterThan(0);
  });

  it('every scenario response is < 500, schema-valid and free of content', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const state: State = {};
    const failures: string[] = [];
    const tokenHashes = hubTokenHashes(seed);
    for (const step of scenario(seed)) {
      const label = `${step.verb} ${step.route}`;
      const file = routeFile(ADMIN_API_ROOT, step.route);
      if (!existsSync(file)) {
        failures.push(`${label}: route file missing`);
        continue;
      }
      const mod = await loadRoute(file);
      if (!mod[step.verb]) {
        if (!step.optional) failures.push(`${label}: verb not exported`);
        continue;
      }
      const opts: { body?: unknown; query?: Record<string, string> } = {};
      if (step.body) opts.body = step.body(state);
      if (step.query) opts.query = step.query(state);
      const res = await call(
        ADMIN_API_ROOT,
        step.route,
        step.verb,
        step.params?.(state) ?? {},
        opts,
      );
      if (res.status >= 500) failures.push(`${label}: status ${res.status}`);
      if (res.text.includes(SECRET_MARKER))
        failures.push(`${label}: response contains user content`);
      if (res.text.includes(`${SECRET_MARKER}-H`))
        failures.push(`${label}: response contains hub content`);
      if (ENC_KEY_IN_TEXT.test(res.text)) failures.push(`${label}: response names an _enc key`);
      if (tokenHashes.some((h) => res.text.includes(h)))
        failures.push(`${label}: response contains a hub search token hash`);
      const bad = forbiddenKeys(res.json);
      if (bad.length > 0) failures.push(`${label}: forbidden keys ${bad.join(', ')}`);
      if (res.status >= 200 && res.status < 300 && res.status !== 204) {
        const key = `${step.verb} /api/admin/${step.route}`;
        const schema = ADMIN_RESPONSE_SCHEMAS[key];
        if (!schema) failures.push(`${label}: no response schema for ${key}`);
        else {
          const parsed = schema.safeParse(res.json);
          if (!parsed.success) failures.push(`${label}: schema mismatch ${parsed.error.message}`);
        }
        step.save?.(res.json, state);
      } else if (step.save) {
        failures.push(`${label}: status ${res.status}, later steps lack its ids`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// (a') The Context Hub reaches admins as counts and aggregates only (FR-029, SC-011).

describe("(a') admin hub views are numbers only", () => {
  const HUB_COUNT_KEYS = [
    'recordCount',
    'noteCount',
    'fileCount',
    'pendingSuggestionCount',
    'syncFailedCount',
    'hubMailboxCount',
  ];
  const HUB_AGGREGATE_KEYS = [
    'llmCallsToday',
    'inputTokensToday',
    'outputTokensToday',
    'threadsPending',
    'threadsFailed',
    'syncFailed',
  ];

  const hubOf = (json: unknown) => (json as { hub?: Record<string, unknown> })?.hub;

  /** The `hub` object accepts exactly its number keys: an extra key, a string or a missing `hub` fails. */
  const expectStrictNumbers = (key: string, json: unknown, keys: string[]) => {
    const schema = ADMIN_RESPONSE_SCHEMAS[key]!;
    const hub = hubOf(json)!;
    expect(Object.keys(hub).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(hub[k], k).toEqual(expect.any(Number));
    expect(schema.safeParse(json).success).toBe(true);
    expect(schema.safeParse({ ...(json as object), hub: { ...hub, extra: 1 } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...(json as object), hub: { ...hub, [keys[0]!]: '1' } }).success,
    ).toBe(false);
    const { hub: _dropped, ...withoutHub } = json as Record<string, unknown>;
    expect(schema.safeParse(withoutHub).success).toBe(false);
  };

  it('ADMIN_FORBIDDEN_FIELDS names every hub content key', () => {
    const missing = HUB_FORBIDDEN_FIELDS.filter(
      (k) => !(ADMIN_FORBIDDEN_FIELDS as readonly string[]).includes(k),
    );
    expect(missing).toEqual([]);
  });

  it("GET /api/admin/users/[id] carries user U's hub counts only", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(ADMIN_API_ROOT, 'users/[id]', 'GET', { id: seed.userU });
    expect(res.status).toBe(200);
    // The seed: one person, company and project, one note, one file, one suggested fact, one
    // failed sync item and one hub-enabled mailbox.
    expect(hubOf(res.json)).toEqual({
      recordCount: 3,
      noteCount: 1,
      fileCount: 1,
      pendingSuggestionCount: 1,
      syncFailedCount: 1,
      hubMailboxCount: 1,
    });
    expectStrictNumbers('GET /api/admin/users/[id]', res.json, HUB_COUNT_KEYS);
    expect(res.text).not.toContain(`${SECRET_MARKER}-H`);
    expect(forbiddenKeys(res.json)).toEqual([]);
    expect(res.text).not.toMatch(ENC_KEY_IN_TEXT);
    for (const h of hubTokenHashes(seed)) expect(res.text).not.toContain(h);
  });

  it('GET /api/admin/system/health carries hub aggregates only', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(ADMIN_API_ROOT, 'system/health', 'GET');
    expect(res.status).toBe(200);
    expectStrictNumbers('GET /api/admin/system/health', res.json, HUB_AGGREGATE_KEYS);
    // Both seeded users carry a failed sync item.
    expect(hubOf(res.json)!.syncFailed).toBeGreaterThanOrEqual(2);
    expect(res.text).not.toContain(`${SECRET_MARKER}-H`);
    expect(forbiddenKeys(res.json)).toEqual([]);
    expect(res.text).not.toMatch(ENC_KEY_IN_TEXT);
  });
});

// (b) Another user's content is not_found for an admin, and the attempt is audited.

describe("(b) an admin reaching another user's content", () => {
  const probes: {
    name: string;
    route: string;
    verb: Verb;
    params: (sd: IsolationSeed) => Record<string, string>;
    target: (sd: IsolationSeed) => string;
    /** A JSON body, or one built from the seed's ids. */
    body?: unknown | ((sd: IsolationSeed) => unknown);
    query?: Record<string, string>;
    /** Extra assertion that the target row is untouched after the denied call. */
    unchanged?: (sd: IsolationSeed) => Promise<void>;
  }[] = [
    {
      name: 'source',
      route: 'sources/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.gmailSourceId }),
      target: (sd) => sd.u.gmailSourceId,
    },
    {
      name: 'content item report',
      route: 'content-items/[id]/report',
      verb: 'POST',
      params: (sd) => ({ id: sd.u.contentItemId }),
      target: (sd) => sd.u.contentItemId,
      body: {},
    },
    {
      name: 'source delete',
      route: 'sources/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.gmailSourceId }),
      target: (sd) => sd.u.gmailSourceId,
      unchanged: async (sd) => {
        const [row] = await getDb()
          .select({ status: connectedSource.status })
          .from(connectedSource)
          .where(eq(connectedSource.id, sd.u.gmailSourceId));
        expect(row?.status).toBe('connected');
      },
    },
    {
      name: 'content item delete',
      route: 'content-items/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.contentItemId }),
      target: (sd) => sd.u.contentItemId,
      unchanged: async (sd) => {
        const [row] = await getDb()
          .select({ status: contentItem.status })
          .from(contentItem)
          .where(eq(contentItem.id, sd.u.contentItemId));
        expect(row?.status).toBe('active');
      },
    },
    {
      name: 'draft delete',
      route: 'drafts/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.draftId }),
      target: (sd) => sd.u.draftId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: draft.id })
          .from(draft)
          .where(eq(draft.id, sd.u.draftId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'draft edit',
      route: 'drafts/[id]',
      verb: 'PATCH',
      params: (sd) => ({ id: sd.u.draftId }),
      target: (sd) => sd.u.draftId,
      body: { editedText: 'overwritten by an admin' },
      unchanged: async (sd) => {
        const [row] = await getDb()
          .select({ editedTextEnc: draft.editedTextEnc })
          .from(draft)
          .where(eq(draft.id, sd.u.draftId));
        expect(row?.editedTextEnc).toBeNull();
      },
    },
    {
      name: 'draft export',
      route: 'drafts/[id]/export',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.draftId }),
      target: (sd) => sd.u.draftId,
      query: { format: 'md' },
    },
    {
      name: 'profile',
      route: 'profiles/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.profileId }),
      target: (sd) => sd.u.profileId,
    },
    {
      name: 'profile version',
      route: 'profiles/[id]/versions/[versionId]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.profileId, versionId: sd.u.profileVersionId }),
      target: (sd) => sd.u.profileId,
    },
    {
      name: 'document profile version',
      route: 'profiles/[id]/versions/[versionId]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.profileId, versionId: sd.u.documentVersionId }),
      target: (sd) => sd.u.profileId,
    },
    {
      name: 'own prompt version',
      route: 'analysis-prompts/[definitionId]/versions/[versionId]',
      verb: 'GET',
      params: (sd) => ({ definitionId: sd.definitionId, versionId: sd.u.ownPromptVersionId }),
      target: (sd) => sd.u.ownPromptVersionId,
    },
    {
      name: 'upload',
      route: 'uploads/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.uploadId }),
      target: (sd) => sd.u.uploadId,
    },
    {
      name: 'hub person',
      route: 'hub/[kind]/[id]',
      verb: 'GET',
      params: (sd) => ({ kind: 'people', id: sd.u.hub.personId }),
      target: (sd) => sd.u.hub.personId,
    },
    {
      name: 'hub project delete preview',
      route: 'hub/[kind]/[id]',
      verb: 'GET',
      params: (sd) => ({ kind: 'projects', id: sd.u.hub.projectId }),
      target: (sd) => sd.u.hub.projectId,
      query: { deletePreview: '1' },
    },
    {
      name: 'hub company rename',
      route: 'hub/[kind]/[id]',
      verb: 'PATCH',
      params: (sd) => ({ kind: 'companies', id: sd.u.hub.companyId }),
      target: (sd) => sd.u.hub.companyId,
      body: { name: 'renamed by an admin' },
      unchanged: async (sd) => {
        const [row] = await getDb()
          .select({ nameKey: hubCompany.nameKey })
          .from(hubCompany)
          .where(eq(hubCompany.id, sd.u.hub.companyId));
        expect(row?.nameKey).toBe(nameKey(sd.userU, 'company', `${SECRET_MARKER}-H2`));
      },
    },
    {
      name: 'hub project delete',
      route: 'hub/[kind]/[id]',
      verb: 'DELETE',
      params: (sd) => ({ kind: 'projects', id: sd.u.hub.projectId }),
      target: (sd) => sd.u.hub.projectId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubProject.id })
          .from(hubProject)
          .where(eq(hubProject.id, sd.u.hub.projectId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub person email add',
      route: 'hub/[kind]/[id]/emails',
      verb: 'POST',
      params: (sd) => ({ kind: 'people', id: sd.u.hub.personId }),
      target: (sd) => sd.u.hub.personId,
      body: { address: 'added-by-an-admin@example.test' },
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubPersonEmail.id })
          .from(hubPersonEmail)
          .where(eq(hubPersonEmail.personId, sd.u.hub.personId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub person email remove',
      route: 'hub/[kind]/[id]/emails/[emailId]',
      verb: 'DELETE',
      params: (sd) => ({ kind: 'people', id: sd.u.hub.personId, emailId: randomUUID() }),
      target: (sd) => sd.u.hub.personId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubPersonEmail.id })
          .from(hubPersonEmail)
          .where(eq(hubPersonEmail.personId, sd.u.hub.personId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub company domain add',
      route: 'hub/[kind]/[id]/domains',
      verb: 'POST',
      params: (sd) => ({ kind: 'companies', id: sd.u.hub.companyId }),
      target: (sd) => sd.u.hub.companyId,
      body: { domain: 'added-by-an-admin.example.test' },
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubCompanyDomain.id })
          .from(hubCompanyDomain)
          .where(eq(hubCompanyDomain.companyId, sd.u.hub.companyId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub company domain remove',
      route: 'hub/[kind]/[id]/domains/[domainId]',
      verb: 'DELETE',
      params: (sd) => ({ kind: 'companies', id: sd.u.hub.companyId, domainId: randomUUID() }),
      target: (sd) => sd.u.hub.companyId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubCompanyDomain.id })
          .from(hubCompanyDomain)
          .where(eq(hubCompanyDomain.companyId, sd.u.hub.companyId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub link create',
      route: 'hub/links',
      verb: 'POST',
      params: () => ({}),
      target: (sd) => sd.u.hub.personId,
      body: (sd: IsolationSeed) => ({
        kind: 'person_project',
        personId: sd.u.hub.personId,
        projectId: sd.u.hub.projectId,
      }),
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubLink.id })
          .from(hubLink)
          .where(eq(hubLink.userId, sd.userU));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub link role',
      route: 'hub/links/[id]',
      verb: 'PATCH',
      params: (sd) => ({ id: sd.u.hub.linkId }),
      target: (sd) => sd.u.hub.linkId,
      body: { role: 'set by an admin' },
    },
    {
      name: 'hub link delete',
      route: 'hub/links/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.hub.linkId }),
      target: (sd) => sd.u.hub.linkId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubLink.id })
          .from(hubLink)
          .where(eq(hubLink.id, sd.u.hub.linkId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub record notes',
      route: 'hub/[kind]/[id]/notes',
      verb: 'GET',
      params: (sd) => ({ kind: 'people', id: sd.u.hub.personId }),
      target: (sd) => sd.u.hub.personId,
    },
    {
      name: 'hub note create',
      route: 'hub/[kind]/[id]/notes',
      verb: 'POST',
      params: (sd) => ({ kind: 'projects', id: sd.u.hub.projectId }),
      target: (sd) => sd.u.hub.projectId,
      body: {
        title: 'Added by an admin',
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'added by an admin' }] }],
        },
      },
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubNote.id })
          .from(hubNote)
          .where(eq(hubNote.userId, sd.userU));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub note',
      route: 'hub/notes/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.hub.noteId }),
      target: (sd) => sd.u.hub.noteId,
    },
    {
      name: 'hub note edit',
      route: 'hub/notes/[id]',
      verb: 'PATCH',
      params: (sd) => ({ id: sd.u.hub.noteId }),
      target: (sd) => sd.u.hub.noteId,
      body: { title: 'overwritten by an admin' },
    },
    {
      name: 'hub note delete',
      route: 'hub/notes/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.hub.noteId }),
      target: (sd) => sd.u.hub.noteId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubNote.id })
          .from(hubNote)
          .where(eq(hubNote.id, sd.u.hub.noteId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub record files',
      route: 'hub/[kind]/[id]/files',
      verb: 'GET',
      params: (sd) => ({ kind: 'companies', id: sd.u.hub.companyId }),
      target: (sd) => sd.u.hub.companyId,
    },
    {
      name: 'hub file',
      route: 'hub/files/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.hub.fileId }),
      target: (sd) => sd.u.hub.fileId,
    },
    {
      name: 'hub file rename',
      route: 'hub/files/[id]',
      verb: 'PATCH',
      params: (sd) => ({ id: sd.u.hub.fileId }),
      target: (sd) => sd.u.hub.fileId,
      body: { name: 'renamed-by-admin.pdf' },
    },
    {
      name: 'hub file delete',
      route: 'hub/files/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.hub.fileId }),
      target: (sd) => sd.u.hub.fileId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubFile.id })
          .from(hubFile)
          .where(eq(hubFile.id, sd.u.hub.fileId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub file download',
      route: 'hub/files/[id]/download',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.hub.fileId }),
      target: (sd) => sd.u.hub.fileId,
    },
    {
      name: 'hub mailbox enable',
      route: 'hub/mailboxes/[sourceId]/enable',
      verb: 'POST',
      params: (sd) => ({ sourceId: sd.u.hub.mailboxSourceId }),
      target: (sd) => sd.u.hub.mailboxSourceId,
      body: { acknowledgeAi: true },
    },
    {
      name: 'hub mailbox disable',
      route: 'hub/mailboxes/[sourceId]/disable',
      verb: 'POST',
      params: (sd) => ({ sourceId: sd.u.hub.mailboxSourceId }),
      target: (sd) => sd.u.hub.mailboxSourceId,
      body: { hubData: 'delete' },
      unchanged: async (sd) => {
        const [row] = await getDb()
          .select({ enabled: hubMailboxSetting.enabled })
          .from(hubMailboxSetting)
          .where(eq(hubMailboxSetting.sourceId, sd.u.hub.mailboxSourceId));
        expect(row?.enabled).toBe(true);
      },
    },
    {
      name: 'hub mailbox thread retry',
      route: 'hub/mailboxes/[sourceId]/threads/[threadId]/retry',
      verb: 'POST',
      params: (sd) => ({ sourceId: sd.u.hub.mailboxSourceId, threadId: sd.u.hub.threadId }),
      target: (sd) => sd.u.hub.threadId,
    },
    {
      name: 'hub ignore rule delete',
      route: 'hub/ignore-rules/[id]',
      verb: 'DELETE',
      params: (sd) => ({ id: sd.u.hub.ignoreRuleId }),
      target: (sd) => sd.u.hub.ignoreRuleId,
      unchanged: async (sd) => {
        const rows = await getDb()
          .select({ id: hubIgnoreRule.id })
          .from(hubIgnoreRule)
          .where(eq(hubIgnoreRule.id, sd.u.hub.ignoreRuleId));
        expect(rows).toHaveLength(1);
      },
    },
    {
      name: 'hub record sources',
      route: 'hub/[kind]/[id]/sources',
      verb: 'GET',
      params: (sd) => ({ kind: 'people', id: sd.u.hub.personId }),
      target: (sd) => sd.u.hub.personId,
    },
  ];

  for (const probe of probes) {
    it(`${probe.verb} /api/${probe.route} (${probe.name}) -> 404 + audit`, async () => {
      expect(existsSync(routeFile(API_ROOT, probe.route)), `${probe.route} route file`).toBe(true);
      actor.current = { userId: seed.adminA, role: 'admin' };
      const target = probe.target(seed);
      const before = await deniedCount(seed.adminA, target);
      const body = typeof probe.body === 'function' ? probe.body(seed) : probe.body;
      const res = await call(API_ROOT, probe.route, probe.verb, probe.params(seed), {
        ...(body !== undefined ? { body } : {}),
        ...(probe.query ? { query: probe.query } : {}),
      });
      expect(res.status).toBe(404);
      expect(get(res.json, 'error', 'code')).toBe('not_found');
      expect(res.text).not.toContain(SECRET_MARKER);
      expect(await deniedCount(seed.adminA, target)).toBe(before + 1);
      await probe.unchanged?.(seed);
    });
  }

  it('GET /api/deletions/[id] -> 404 + audit', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const target = seed.u.deletionRequestId;
    const before = await deniedCount(seed.adminA, target);
    const res = await call(API_ROOT, 'deletions/[id]', 'GET', { id: target });
    expect(res.status).toBe(404);
    expect(get(res.json, 'error', 'code')).toBe('not_found');
    expect(res.text).not.toContain(SECRET_MARKER);
    expect(await deniedCount(seed.adminA, target)).toBe(before + 1);
  });

  it('GET /api/drafts/[id] -> 404 + audit', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const target = seed.u.draftId;
    const before = await deniedCount(seed.adminA, target);
    const res = await call(API_ROOT, 'drafts/[id]', 'GET', { id: target });
    expect(res.status).toBe(404);
    expect(get(res.json, 'error', 'code')).toBe('not_found');
    expect(res.text).not.toContain(SECRET_MARKER);
    expect(await deniedCount(seed.adminA, target)).toBe(before + 1);
  });

  const listIds = (json: unknown): string[] => {
    const rows = Array.isArray(json) ? json : ((json as { items?: unknown[] })?.items ?? []);
    return rows.map((r) => get(r, 'id'));
  };

  it("GET /api/sources lists only the admin's own sources", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(API_ROOT, 'sources', 'GET');
    expect(res.status).toBe(200);
    const ids = listIds(res.json);
    expect(ids).toContain(seed.a.sourceId);
    expect(ids).not.toContain(seed.u.gmailSourceId);
    expect(ids).not.toContain(seed.u.uploadsSourceId);
    expect(res.text).not.toContain(SECRET_MARKER);
  });

  it("GET /api/drafts lists only the admin's own drafts", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(API_ROOT, 'drafts', 'GET');
    expect(res.status).toBe(200);
    expect(listIds(res.json)).not.toContain(seed.u.draftId);
    expect(res.text).not.toContain(SECRET_MARKER);
  });

  it("GET /api/analysis-prompts shows no other user's own prompt", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(API_ROOT, 'analysis-prompts', 'GET');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(seed.u.ownPromptId);
    expect(res.text).not.toContain(seed.u.ownPromptVersionId);
    expect(res.text).not.toContain(SECRET_MARKER);
  });

  it('GET /api/admin/metrics/ratings counts the seeded draft rating without content', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(ADMIN_API_ROOT, 'metrics/ratings', 'GET');
    expect(res.status).toBe(200);
    const drafts = (res.json as { drafts?: { rated?: number; soundsLikeMe?: number } })?.drafts;
    expect(drafts?.rated).toBeGreaterThanOrEqual(1);
    expect(drafts?.soundsLikeMe).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain(SECRET_MARKER);
  });

  it("GET /api/hub/people lists only the admin's own records", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(
      API_ROOT,
      'hub/[kind]',
      'GET',
      { kind: 'people' },
      { query: { limit: '100' } },
    );
    expect(res.status).toBe(200);
    const ids = listIds(res.json);
    expect(ids).toContain(seed.a.hub.personId);
    expect(ids).not.toContain(seed.u.hub.personId);
    expect(res.text).not.toContain(seed.u.hub.personId);
  });

  it("GET /api/hub/sync shows only the admin's own sync items", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(API_ROOT, 'hub/sync', 'GET', {}, { query: { limit: '100' } });
    expect(res.status).toBe(200);
    const ids = listIds(res.json);
    expect(ids).toContain(seed.a.hub.syncItemId);
    expect(ids).not.toContain(seed.u.hub.syncItemId);
    // The admin's own seeded hub data carries the same marker text, so the check is by user U's ids.
    for (const id of Object.values(seed.u.hub)) expect(res.text).not.toContain(id);
  });

  it("GET /api/hub/search finds only the admin's own items, with no audit", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const before = await deniedCount(seed.adminA, seed.u.hub.noteId);
    // Both hubs carry a note whose title and body are `${SECRET_MARKER}-H5`; only the admin's own one may come back.
    const res = await call(
      API_ROOT,
      'hub/search',
      'GET',
      {},
      { query: { q: `${SECRET_MARKER}-H5`, limit: '100' } },
    );
    expect(res.status).toBe(200);
    const ids = listIds(res.json);
    expect(ids).toContain(seed.a.hub.noteId);
    expect(ids).not.toContain(seed.u.hub.noteId);
    for (const id of Object.values(seed.u.hub)) expect(res.text).not.toContain(id);
    for (const h of hubTokenHashes(seed)) expect(res.text).not.toContain(h);
    expect(await deniedCount(seed.adminA, seed.u.hub.noteId)).toBe(before);
  });

  it("GET /api/content-items lists only the admin's own items", async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(API_ROOT, 'content-items', 'GET', {}, { query: { limit: '100' } });
    expect(res.status).toBe(200);
    const ids = listIds(res.json);
    expect(ids).toContain(seed.a.contentItemId);
    expect(ids).not.toContain(seed.u.contentItemId);
    expect(res.text).not.toContain(SECRET_MARKER);
  });
});

// (c) The lint import ban covers every admin surface and finds nothing.

describe('(c) admin import bans', () => {
  const tsFiles = (dir: string, ext: RegExp) => walk(join(REPO_ROOT, dir), (f) => ext.test(f));

  it('admin code has zero no-restricted-imports findings', async () => {
    const files = [
      ...tsFiles('apps/web/app/api/admin', /\.ts$/),
      ...tsFiles('apps/web/app/(admin)', /\.tsx?$/),
      ...tsFiles('apps/web/components/admin', /\.tsx?$/),
      ...['packages/core/src/services/admin-users.ts', 'packages/core/src/services/admin-system.ts']
        .map((f) => join(REPO_ROOT, f))
        .filter((f) => existsSync(f)),
      ...tsFiles('packages/db/src/repos/admin', /\.ts$/),
    ];
    expect(
      files.some((f) => f.includes(`${sep}api${sep}admin${sep}`)),
      'api/admin files',
    ).toBe(true);
    expect(
      files.some((f) => f.includes(`${sep}repos${sep}admin${sep}`)),
      'repos/admin files',
    ).toBe(true);
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: REPO_ROOT, errorOnUnmatchedPattern: false });
    const results = await eslint.lintFiles(files);
    const banned = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-imports')
        .map((m) => `${toPosix(relative(REPO_ROOT, r.filePath))}:${m.line} ${m.message}`),
    );
    expect(banned).toEqual([]);
  });

  it('pnpm lint fails when an admin file imports a hub service (fixture)', async () => {
    const fixture = join(
      WEB_ROOT,
      'test',
      'admin-isolation',
      'lint-fixtures',
      'admin-imports-hub-service.ts',
    );
    const code = readFileSync(fixture, 'utf8');
    const importLines = code
      .split('\n')
      .map((line, i) => (line.startsWith('import ') ? i + 1 : 0))
      .filter((n) => n > 0);
    expect(importLines.length).toBeGreaterThan(0);
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const adminPaths = [
      'apps/web/app/api/admin/hub/route.ts',
      'apps/web/app/(admin)/admin/hub/page.tsx',
      'apps/web/components/admin/hub.tsx',
      'packages/core/src/services/admin-users.ts',
      'packages/core/src/services/admin-system.ts',
      'packages/db/src/repos/admin/hub.ts',
    ];
    for (const filePath of adminPaths) {
      const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) });
      const bannedLines = result!.messages
        .filter((m) => m.ruleId === 'no-restricted-imports')
        .map((m) => m.line);
      expect(bannedLines, `${filePath} bans every hub import`).toEqual(importLines);
    }
  });

  it('the ban is wired for admin files', async () => {
    const { ESLint } = await import('eslint');
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const cases: [string, string][] = [
      ["import '@voicespark/core/crypto';\n", 'apps/web/app/api/admin/x/route.ts'],
      ["import '@voicespark/integrations/supermemory';\n", 'apps/web/components/admin/x.tsx'],
      [
        "import '@voicespark/core/services/profiles';\n",
        'packages/core/src/services/admin-system.ts',
      ],
      ["import '../user/profiles';\n", 'packages/db/src/repos/admin/x.ts'],
    ];
    for (const [code, filePath] of cases) {
      const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) });
      expect(
        result!.messages.some((m) => m.ruleId === 'no-restricted-imports'),
        `${filePath} bans ${code.trim()}`,
      ).toBe(true);
    }
  });
});

// (d) Admin repositories and routes never name encrypted columns or the memory store.

describe('(d) admin sources never touch encrypted columns', () => {
  it('repos/admin and api/admin contain no *_enc, *Enc, supermemory or repos/user reference', () => {
    const files = [
      ...walk(join(REPO_ROOT, 'packages/db/src/repos/admin'), (f) => f.endsWith('.ts')),
      ...walk(ADMIN_API_ROOT, (f) => f.endsWith('.ts')),
    ];
    expect(
      files.some((f) => f.includes(`${sep}repos${sep}admin${sep}`)),
      'repos/admin files',
    ).toBe(true);
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const re of [/_enc\b|[a-z]Enc\b/, /supermemory/i, /repos\/user/]) {
        if (re.test(src)) hits.push(`${toPosix(relative(REPO_ROOT, file))}: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
