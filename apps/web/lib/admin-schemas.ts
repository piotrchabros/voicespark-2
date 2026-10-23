import { z } from 'zod';
import {
  APP_SETTING_DEFAULTS,
  AUDIT_ACTOR_TYPES,
  DEFINITION_AVAILABILITIES,
  IMPORT_JOB_STATUS,
  PROFILE_STATUS,
  PROMPT_EFFORTS,
  SIGN_IN_PROVIDERS,
  SOURCE_STATUS,
  SOURCE_TYPES,
  USER_ROLES,
  USER_STATUS,
  VERSION_ACTIONS,
  VERSION_STATUS,
  dimensionSchema,
} from '@voicespark/db';
import { logger } from '@voicespark/core/logger';
import { AppError } from '@voicespark/core/errors';

// Single source of admin response shapes (constitution III, SC-010). Next forbids extra exports
// from route.ts, so admin routes respond through `adminJson`, which fails closed on any field not
// declared here. Admin responses carry metadata, counts and aggregates only, never content.

/** Keys that must never appear at any depth of an admin response, plus anything matching /_enc$|Enc$/. */
export const ADMIN_FORBIDDEN_FIELDS = [
  'body',
  'bodyText',
  'subject',
  'snippet',
  'text',
  'generatedText',
  'editedText',
  'brief',
  'feedback',
  'excerpts',
  'topic',
  'title',
  'content',
  'accessToken',
  'refreshToken',
  'password',
  'promptText',
  'sections',
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
export const ADMIN_FORBIDDEN_FIELD_PATTERN = /_enc$|Enc$/;

export type AdminRouteKey = `${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /api/admin/${string}`;

const id = z.uuid();
const iso = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

const versionRef = z.strictObject({ id, versionNumber: z.number().int().positive() });
const actorRef = z.strictObject({ id, name: z.string().nullable() });

// Users

const userSummary = z.strictObject({
  id,
  name: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUS),
});

const adminUserListItem = z.strictObject({
  id,
  name: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUS),
  providers: z.array(z.enum(SIGN_IN_PROVIDERS)),
  sourceCount: count,
  createdAt: iso,
  lastSignInAt: iso.nullable(),
});

const adminUserDetail = z.strictObject({
  id,
  name: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUS),
  createdAt: iso,
  lastSignInAt: iso.nullable(),
  suspendedAt: iso.nullable(),
  identities: z.array(
    z.strictObject({
      provider: z.enum(SIGN_IN_PROVIDERS),
      providerEmail: z.string().nullable(),
      verified: z.boolean(),
    }),
  ),
  sources: z.array(
    z.strictObject({
      id,
      type: z.enum(SOURCE_TYPES),
      accountLabel: z.string(),
      status: z.enum(SOURCE_STATUS),
      itemCount: count,
      lastSyncAt: iso.nullable(),
      currentImport: z
        .strictObject({
          status: z.enum(IMPORT_JOB_STATUS),
          itemsProcessed: count,
          totalEstimate: count.nullable(),
        })
        .nullable(),
    }),
  ),
  profiles: z.array(
    z.strictObject({
      definitionName: z.string(),
      status: z.enum(PROFILE_STATUS),
      versionCount: count,
      lastGeneratedAt: iso.nullable(),
    }),
  ),
});

// Definitions

const adminDefinitionListItem = z.strictObject({
  id,
  key: z.string(),
  availability: z.enum(DEFINITION_AVAILABILITIES),
  activeVersion: z
    .strictObject({ id, versionNumber: z.number().int().positive(), name: z.string() })
    .nullable(),
  draftVersionId: id.nullable(),
  userChoiceCount: count,
  ownPromptCount: count,
});

const definitionVersionView = z.strictObject({
  id,
  versionNumber: z.number().int().positive(),
  status: z.enum(VERSION_STATUS),
  name: z.string(),
  description: z.string(),
  dimensions: z.array(dimensionSchema),
  createdAt: iso,
  createdBy: id,
  publishedAt: iso.nullable(),
  publishedBy: id.nullable(),
  analysisPrompt: z.string().nullable(),
});

const historyEntries = z.array(
  z.strictObject({
    action: z.enum(VERSION_ACTIONS),
    fromVersion: versionRef.nullable(),
    toVersion: versionRef,
    actor: actorRef,
    occurredAt: iso,
  }),
);

const versionDiff = z.strictObject({
  from: versionRef,
  to: versionRef,
  changes: z.array(
    z.strictObject({
      path: z.string(),
      op: z.enum(['added', 'removed', 'changed']),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
});

// Prompts

const adminPromptListItem = z.strictObject({
  id,
  key: z.string(),
  isSystem: z.boolean(),
  description: z.string(),
  activeVersion: z
    .strictObject({ id, versionNumber: z.number().int().positive(), model: z.string() })
    .nullable(),
  draftVersionId: id.nullable(),
});

const promptVersionView = z.strictObject({
  id,
  versionNumber: z.number().int().positive(),
  status: z.enum(VERSION_STATUS),
  systemTemplate: z.string(),
  userTemplate: z.string(),
  model: z.string(),
  effort: z.enum(PROMPT_EFFORTS),
  maxTokens: z.number().int().positive(),
  changeNote: z.string().nullable(),
  createdAt: iso,
  createdBy: id,
  publishedAt: iso.nullable(),
  publishedBy: id.nullable(),
});

// Settings, audit, system

const settingKeys = Object.keys(APP_SETTING_DEFAULTS) as [
  keyof typeof APP_SETTING_DEFAULTS,
  ...(keyof typeof APP_SETTING_DEFAULTS)[],
];
const settingView = z.strictObject({
  key: z.enum(settingKeys),
  value: z.number(),
  defaultValue: z.number(),
  updatedAt: iso.nullable(),
});

const queueCounts = z.strictObject({
  waiting: count,
  active: count,
  failed: count,
  delayed: count,
});

const ratingAggregate = z.strictObject({
  rated: count,
  soundsLikeMe: count,
  share: z.number().min(0).max(1).nullable(),
});

export const ADMIN_RESPONSE_SCHEMAS: Record<string, z.ZodType> = {
  'GET /api/admin/users': z.strictObject({
    items: z.array(adminUserListItem),
    nextCursor: z.string().nullable(),
  }),
  'GET /api/admin/users/[id]': adminUserDetail,
  'POST /api/admin/users/[id]/suspend': z.strictObject({ user: userSummary }),
  'POST /api/admin/users/[id]/reinstate': z.strictObject({ user: userSummary }),
  'PUT /api/admin/users/[id]/role': z.strictObject({ user: userSummary }),

  'GET /api/admin/definitions': z.array(adminDefinitionListItem),
  'POST /api/admin/definitions': z.strictObject({
    definition: adminDefinitionListItem,
    draft: definitionVersionView,
  }),
  'GET /api/admin/definitions/[id]': z.strictObject({
    definition: adminDefinitionListItem,
    versions: z.array(definitionVersionView),
  }),
  'POST /api/admin/definitions/[id]/versions': z.strictObject({ version: definitionVersionView }),
  'PATCH /api/admin/definitions/[id]/versions/[versionId]': z.strictObject({
    version: definitionVersionView,
  }),
  'POST /api/admin/definitions/[id]/versions/[versionId]/publish': z.strictObject({
    definition: adminDefinitionListItem,
  }),
  'GET /api/admin/definitions/[id]/versions/[versionId]/diff': versionDiff,
  'POST /api/admin/definitions/[id]/versions/[versionId]/preview': z.strictObject({
    system: z.string(),
    user: z.string(),
  }),
  'POST /api/admin/definitions/[id]/versions/[versionId]/preview-run': z.strictObject({
    jobId: z.string().regex(/^preview-[0-9a-f-]{36}$/),
  }),
  'GET /api/admin/definitions/[id]/versions/[versionId]/preview-run/[jobId]': z.strictObject({
    status: z.enum(['queued', 'running', 'done', 'failed']),
    markdown: z.string().nullable(),
    problems: z.array(z.string()),
  }),
  'POST /api/admin/definitions/[id]/rollback': z.strictObject({
    definition: adminDefinitionListItem,
  }),
  'PUT /api/admin/definitions/[id]/availability': z.strictObject({
    definition: adminDefinitionListItem,
  }),
  'GET /api/admin/definitions/[id]/history': historyEntries,

  'GET /api/admin/prompts': z.array(adminPromptListItem),
  'POST /api/admin/prompts': z.strictObject({
    prompt: adminPromptListItem,
    draft: promptVersionView,
  }),
  'GET /api/admin/prompts/[id]': z.strictObject({
    prompt: adminPromptListItem,
    versions: z.array(promptVersionView),
  }),
  'POST /api/admin/prompts/[id]/versions': z.strictObject({ version: promptVersionView }),
  'PATCH /api/admin/prompts/[id]/versions/[versionId]': z.strictObject({
    version: promptVersionView,
  }),
  'POST /api/admin/prompts/[id]/versions/[versionId]/publish': z.strictObject({
    prompt: adminPromptListItem,
  }),
  'GET /api/admin/prompts/[id]/versions/[versionId]/diff': versionDiff,
  'POST /api/admin/prompts/[id]/versions/[versionId]/validate': z.strictObject({
    valid: z.boolean(),
    unknownVariables: z.array(z.string()),
    missingRequired: z.array(z.string()),
  }),
  'POST /api/admin/prompts/[id]/versions/[versionId]/preview': z.strictObject({
    system: z.string(),
    user: z.string(),
  }),
  'POST /api/admin/prompts/[id]/rollback': z.strictObject({ prompt: adminPromptListItem }),
  'GET /api/admin/prompts/[id]/history': historyEntries,

  'GET /api/admin/settings': z.strictObject({ settings: z.array(settingView) }),
  'PUT /api/admin/settings': z.strictObject({ setting: settingView }),
  'GET /api/admin/audit': z.strictObject({
    items: z.array(
      z.strictObject({
        id,
        occurredAt: iso,
        actorType: z.enum(AUDIT_ACTOR_TYPES),
        actor: actorRef.nullable(),
        action: z.string(),
        targetType: z.string().nullable(),
        targetId: z.string().nullable(),
        metadataKeys: z.array(z.string()),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  'GET /api/admin/system/health': z.strictObject({
    queues: z.record(z.string(), queueCounts),
    overdueDeletions: count,
    credentialAuditHits: count,
  }),
  'GET /api/admin/metrics/ratings': z.strictObject({
    profiles: ratingAggregate,
    drafts: ratingAggregate.extend({
      byContentType: z.record(z.string(), ratingAggregate),
    }),
  }),
};

/**
 * Validates `data` against the route's admin response schema and returns it as JSON. Fails closed:
 * an unknown key, a missing schema or any extra field becomes a 500 (`internal_error`), never a
 * response. 204 routes return undefined from `handle()` instead of calling this.
 */
export function adminJson(key: AdminRouteKey | string, data: unknown, status?: number): Response {
  const schema = ADMIN_RESPONSE_SCHEMAS[key];
  // Round-trip through JSON first so Date values are checked as the ISO strings the client sees.
  const json: unknown = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
  const parsed = schema?.safeParse(json);
  if (!parsed?.success) {
    logger.error({ errorCode: 'admin_response_schema' }, 'admin response failed its schema');
    throw new AppError('internal_error');
  }
  return Response.json(parsed.data, status === undefined ? undefined : { status });
}
