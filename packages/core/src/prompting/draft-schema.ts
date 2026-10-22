import { z } from 'zod';
import type { DraftContentType } from '@voicespark/db';

/** Body word caps per content type (FR-057); longer model output is cut and flagged `truncated`. */
export const DRAFT_WORD_CAPS: Record<DraftContentType, number> = {
  social_post: 300,
  bio: 250,
  short_article: 1500,
};

/** `contentTypeLabel` template variable. */
export const CONTENT_TYPE_LABEL: Record<DraftContentType, string> = {
  social_post: 'social post',
  bio: 'bio',
  short_article: 'short article',
};

export const DRAFT_PROMPT_KEY: Record<DraftContentType, `draft.${DraftContentType}`> = {
  social_post: 'draft.social_post',
  bio: 'draft.bio',
  short_article: 'draft.short_article',
};

export const DRAFT_TITLE_MAX = 150;

export interface DraftOutput {
  title: string | null;
  body: string;
  notes: string | null;
}

// Lets the fake generation LLM recover the content type a schema was built for.
const schemaContentTypes = new WeakMap<object, DraftContentType>();

/** Draft output schema (T150). The word cap is applied after parsing (`applyWordCap`), not by the schema. */
export function buildDraftOutputSchema(contentType: DraftContentType): z.ZodType<DraftOutput> {
  const schema = z.strictObject({
    title: z.string().max(DRAFT_TITLE_MAX).nullable(),
    body: z.string(),
    notes: z.string().nullable(),
  });
  schemaContentTypes.set(schema, contentType);
  return schema;
}

export function draftSchemaContentType(schema: unknown): DraftContentType | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  return schemaContentTypes.get(schema);
}

/** Cuts the body after the content type's word cap, keeping the original whitespace of the kept words. */
export function applyWordCap(contentType: DraftContentType, out: DraftOutput): DraftOutput & { truncated: boolean } {
  const cap = DRAFT_WORD_CAPS[contentType];
  const word = /\S+/g;
  let count = 0;
  let end = 0;
  for (let m = word.exec(out.body); m !== null; m = word.exec(out.body)) {
    if (++count > cap) return { ...out, body: out.body.slice(0, end), truncated: true };
    end = m.index + m[0].length;
  }
  return { ...out, truncated: false };
}
