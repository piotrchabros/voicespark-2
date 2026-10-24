import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hubExtractionSchema, hubTriageSchema } from '@voicespark/core/hub/extraction-schema';
import type { LlmClient } from '@voicespark/integrations/anthropic';

// LLM clients of the hub eval runner (T150/T151, research R14): a recorder that wraps the live model and keeps every
// answered triage and extraction call of a conversation, and the replay client that serves those outputs back in
// order. `recorded/{id}.json` holds model outputs only (synthetic data). Ids of `<known_records>` differ per run, so
// a recording stores `@known:{name}` in their place and the replay maps the name back to the id the current prompt
// lists. Each call also stores a hash of its prompt (system text plus user text, known-record ids and hashes
// stripped): a replay whose prompt differs fails as stale, because the prompt, schema or pipeline changed since the
// recording and the live eval has to be run again.

export const RECORDED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recorded');

export type CallPurpose = 'triage' | 'extract';

export interface RecordedCall {
  purpose: CallPurpose;
  /** sha256 of the normalised prompt (`promptHash`). */
  promptHash: string;
  output: unknown;
}

export const recordingSchema = z.strictObject({
  id: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  recordedAt: z.string().min(1),
  calls: z.array(
    z.strictObject({
      purpose: z.enum(['triage', 'extract']),
      promptHash: z.string().regex(/^[0-9a-f]{64}$/),
      output: z.unknown(),
    }),
  ),
});
export type Recording = z.infer<typeof recordingSchema>;

/** A replay or recording problem; the runner reports these and exits non-zero. */
export class EvalLlmError extends Error {}

const KNOWN = '@known:';
type KnownKind = 'people' | 'companies' | 'projects';
const ID_FIELDS = [
  ['people', 'existingPersonId'],
  ['companies', 'existingCompanyId'],
  ['projects', 'existingProjectId'],
] as const;

function purposeOf(schema: unknown): CallPurpose | null {
  if (schema === hubExtractionSchema) return 'extract';
  if (schema === hubTriageSchema) return 'triage';
  return null;
}

/** The `<known_records>` block of an extraction prompt: id -> name per kind. */
export function parseKnownRecords(user: string): Record<KnownKind, Map<string, string>> {
  const out: Record<KnownKind, Map<string, string>> = {
    people: new Map(),
    companies: new Map(),
    projects: new Map(),
  };
  const start = user.indexOf('<known_records>');
  const end = user.indexOf('</known_records>');
  if (start < 0 || end < start) return out;
  let kind: KnownKind | null = null;
  for (const line of user.slice(start, end).split('\n').slice(1)) {
    const header = /^(people|companies|projects):$/.exec(line);
    if (header) {
      kind = header[1] as KnownKind;
      continue;
    }
    const [id, name] = line.split(' | ');
    if (kind && id && name !== undefined) out[kind].set(id, name);
  }
  return out;
}

/** sha256 over the system text and the user text with the known-record lines reduced to their names. */
export function promptHash(system: string, user: string): string {
  const start = user.indexOf('<known_records>');
  const end = user.indexOf('</known_records>');
  let normalised = user;
  if (start >= 0 && end > start) {
    const block = user
      .slice(start, end)
      .split('\n')
      .map((line) => {
        const cells = line.split(' | ');
        return cells.length === 3 ? cells[1]! : line;
      })
      .join('\n');
    normalised = user.slice(0, start) + block + user.slice(end);
  }
  return createHash('sha256').update(system).update('\u0000').update(normalised).digest('hex');
}

type Entries = Record<string, unknown>[];

/** Replaces known-record ids by `@known:{name}` (record) or names by the current ids (replay). */
function mapKnownIds(
  output: unknown,
  user: string,
  direction: 'tokenize' | 'resolve',
  onMissing: (detail: string) => void,
): unknown {
  if (output === null || typeof output !== 'object') return output;
  const known = parseKnownRecords(user);
  const copy = structuredClone(output) as Record<string, unknown>;
  for (const [kind, field] of ID_FIELDS) {
    const list = copy[kind];
    if (!Array.isArray(list)) continue;
    for (const item of list as Entries) {
      const value = item[field];
      if (typeof value !== 'string') continue;
      if (direction === 'tokenize') {
        const name = known[kind].get(value);
        item[field] = name === undefined ? value : `${KNOWN}${name}`;
      } else if (value.startsWith(KNOWN)) {
        const name = value.slice(KNOWN.length);
        const id = [...known[kind]].find(([, n]) => n === name)?.[0];
        if (id === undefined) onMissing(`${kind} "${name}" is not among the known records`);
        item[field] = id ?? null;
      }
    }
  }
  return copy;
}

/** Wraps `inner` (the live model) and keeps every answered call in `calls`, in call order. */
export function createRecordingLlm(inner: LlmClient): LlmClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    parseStructured: async (args) => {
      const out = await inner.parseStructured(args);
      const purpose = purposeOf(args.schema);
      if (purpose === null)
        throw new EvalLlmError('unexpected LLM call outside triage and extraction');
      calls.push({
        purpose,
        promptHash: promptHash(args.system, args.user),
        output: mapKnownIds(out, args.user, 'tokenize', () => undefined),
      });
      return out;
    },
  };
}

/**
 * Serves `recording` back: the n-th triage (extraction) call gets the n-th recorded triage (extraction) output.
 * A missing call or a prompt that differs from the recorded one is a problem (stale recording): the call throws,
 * and the problem is kept in `problems` for the report.
 */
export function createReplayLlm(recording: Recording): LlmClient & { problems: string[] } {
  const problems: string[] = [];
  const cursor: Record<CallPurpose, number> = { triage: 0, extract: 0 };
  const fail = (detail: string): never => {
    problems.push(detail);
    throw new EvalLlmError(`${recording.id}: ${detail}`);
  };
  return {
    problems,
    parseStructured: async (args) => {
      const purpose =
        purposeOf(args.schema) ?? fail('unexpected LLM call outside triage and extraction');
      const n = cursor[purpose]++;
      const call = recording.calls.filter((c) => c.purpose === purpose)[n];
      if (!call) return fail(`no recorded ${purpose} call #${n + 1}`);
      if (call.promptHash !== promptHash(args.system, args.user))
        return fail(`${purpose} call #${n + 1}: the prompt differs from the recorded one`);
      const resolved = mapKnownIds(call.output, args.user, 'resolve', (d) =>
        fail(`${purpose} call #${n + 1}: ${d}`),
      );
      return args.schema.parse(resolved);
    },
  };
}

export async function writeRecording(
  recording: Recording,
  dir: string = RECORDED_DIR,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${recording.id}.json`);
  await writeFile(file, `${JSON.stringify(recordingSchema.parse(recording), null, 2)}\n`);
  return file;
}

/** Every recording of `dir` by id; empty when the directory does not exist. */
export async function loadRecordings(dir: string = RECORDED_DIR): Promise<Map<string, Recording>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const out = new Map<string, Recording>();
  for (const name of names) {
    const parsed = recordingSchema.safeParse(
      JSON.parse(await readFile(path.join(dir, name), 'utf8')),
    );
    if (!parsed.success) throw new EvalLlmError(`${name}: ${z.prettifyError(parsed.error)}`);
    if (`${parsed.data.id}.json` !== name)
      throw new EvalLlmError(`${name}: id "${parsed.data.id}" does not match the file name`);
    out.set(parsed.data.id, parsed.data);
  }
  return out;
}
