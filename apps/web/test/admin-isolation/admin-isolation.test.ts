// SC-010 / constitution III: admin responses carry metadata, counts and aggregates only; admin code
// never reads *_enc columns or the memory store; an admin reaching another user's content gets
// not_found plus an `admin.content_access_denied` audit entry. Real test DB + Redis-test.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditLogEntry, closeDb, connectedSource, contentItem, draft, getDb } from '@voicespark/db';
import { closeQueues } from '@voicespark/core/queues';
import { AppError } from '@voicespark/core/errors';
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

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

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

beforeAll(async () => {
  seed = await seedIsolation();
}, 60_000);

afterAll(async () => {
  if (seed) await cleanupIsolation(seed);
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
  const dimensions = [
    {
      key: 'warmth',
      name: 'Warmth',
      description: 'How warm the writing feels',
      valueType: 'scale',
      scale: { min: 1, max: 5, minLabel: 'cool', maxLabel: 'warm' },
    },
  ];
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
        dimensions,
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

// (b) Another user's content is not_found for an admin, and the attempt is audited.

describe("(b) an admin reaching another user's content", () => {
  const probes: {
    name: string;
    route: string;
    verb: Verb;
    params: (sd: IsolationSeed) => Record<string, string>;
    target: (sd: IsolationSeed) => string;
    body?: unknown;
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
      name: 'upload',
      route: 'uploads/[id]',
      verb: 'GET',
      params: (sd) => ({ id: sd.u.uploadId }),
      target: (sd) => sd.u.uploadId,
    },
  ];

  for (const probe of probes) {
    it(`${probe.verb} /api/${probe.route} (${probe.name}) -> 404 + audit`, async () => {
      expect(existsSync(routeFile(API_ROOT, probe.route)), `${probe.route} route file`).toBe(true);
      actor.current = { userId: seed.adminA, role: 'admin' };
      const target = probe.target(seed);
      const before = await deniedCount(seed.adminA, target);
      const res = await call(API_ROOT, probe.route, probe.verb, probe.params(seed), {
        ...(probe.body !== undefined ? { body: probe.body } : {}),
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

  it('GET /api/admin/metrics/ratings counts the seeded draft rating without content', async () => {
    actor.current = { userId: seed.adminA, role: 'admin' };
    const res = await call(ADMIN_API_ROOT, 'metrics/ratings', 'GET');
    expect(res.status).toBe(200);
    const drafts = (res.json as { drafts?: { rated?: number; soundsLikeMe?: number } })?.drafts;
    expect(drafts?.rated).toBeGreaterThanOrEqual(1);
    expect(drafts?.soundsLikeMe).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain(SECRET_MARKER);
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
