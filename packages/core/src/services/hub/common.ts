import { inspectSegments } from '@voicespark/filters';
import { decrypt, encrypt } from '../../crypto';
import { AppError, type ServiceContext } from '../../errors';
import { getClassifier, loadPolicy } from '../inspection';

// Shared plumbing of the Context Hub services (data-model.md, contracts/http-api.md). Hub text is user content:
// encrypted at rest with the 'user-content' purpose, filtered with the user's full policy before it is stored.

export type HubKind = 'person' | 'company' | 'project';

const KIND_BY_PATH: Record<string, HubKind> = { people: 'person', companies: 'company', projects: 'project' };

/** Maps the `{kind}` URL segment to a record kind; `null` for anything else (the route answers 404). */
export function kindFromPath(path: string): HubKind | null {
  return Object.hasOwn(KIND_BY_PATH, path) ? KIND_BY_PATH[path]! : null;
}

export function encryptContent(text: string): string {
  return encrypt('user-content', text);
}

export function decryptContent(blob: string): string {
  return decrypt('user-content', blob);
}

/** Foreign and missing ids look the same (FR-008). */
export function hubNotFound(): AppError {
  return new AppError('not_found', undefined, undefined, 404);
}

export interface InspectedFields<K extends string> {
  values: Record<K, string>;
  redactedValues: number;
}

/**
 * Inspects free-text fields in one `inspectSegments` pass under the user's full policy (FR-028). Returns the
 * redacted values and the number of redactions. A wholly excluded set throws 422 `sensitive_content`; any
 * failure to inspect throws 503 `inspection_unavailable` and the caller stores nothing (fail-closed).
 */
export async function inspectFields<K extends string>(
  ctx: ServiceContext,
  fields: Record<K, string>,
): Promise<InspectedFields<K>> {
  const keys = Object.keys(fields) as K[];
  if (keys.length === 0) return { values: {} as Record<K, string>, redactedValues: 0 };
  let result: Awaited<ReturnType<typeof inspectSegments>>;
  try {
    const { policy } = await loadPolicy(ctx.userId);
    result = await inspectSegments(
      keys.map((k) => fields[k]),
      policy,
      { classifier: getClassifier() },
    );
  } catch {
    // Error details are dropped deliberately: they may echo content.
    throw new AppError('inspection_unavailable');
  }
  if (result.excluded) {
    if (result.category === 'inspection_failed') throw new AppError('inspection_unavailable');
    throw new AppError('sensitive_content', undefined, { category: result.category });
  }
  const values = {} as Record<K, string>;
  keys.forEach((k, i) => {
    values[k] = result.segments[i] as string;
  });
  return { values, redactedValues: result.redactedValues };
}
