import { describe, expect, it } from 'vitest';
import { LlmRefusedError } from '@voicespark/integrations/anthropic';
// Static import on purpose: the draft schema module is RED until U8 lands.
import {
  CONTENT_TYPE_LABEL,
  DRAFT_PROMPT_KEY,
  DRAFT_TITLE_MAX,
  DRAFT_WORD_CAPS,
  applyWordCap,
  buildDraftOutputSchema,
  createFakeGenerationLlm,
  draftSchemaContentType,
} from '../src/prompting';

const TYPES = ['social_post', 'bio', 'short_article'] as const;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const countWords = (s: string) => s.trim().split(/\s+/).length;

describe('draft constants', () => {
  it('has the caps, labels and prompt keys per content type', () => {
    expect(DRAFT_WORD_CAPS).toEqual({ social_post: 300, bio: 250, short_article: 1500 });
    expect(CONTENT_TYPE_LABEL).toEqual({ social_post: 'social post', bio: 'bio', short_article: 'short article' });
    expect(DRAFT_PROMPT_KEY).toEqual({
      social_post: 'draft.social_post',
      bio: 'draft.bio',
      short_article: 'draft.short_article',
    });
    expect(DRAFT_TITLE_MAX).toBe(150);
  });
});

describe('buildDraftOutputSchema', () => {
  const schema = buildDraftOutputSchema('short_article');

  it('accepts a well-formed output and null title/notes', () => {
    expect(schema.parse({ title: 'A title', body: 'Body', notes: 'note' })).toEqual({
      title: 'A title',
      body: 'Body',
      notes: 'note',
    });
    expect(schema.parse({ title: null, body: 'Body', notes: null }).title).toBeNull();
  });

  it('rejects a title longer than 150 characters, accepts exactly 150', () => {
    expect(schema.safeParse({ title: 'x'.repeat(DRAFT_TITLE_MAX), body: 'b', notes: null }).success).toBe(true);
    expect(schema.safeParse({ title: 'x'.repeat(DRAFT_TITLE_MAX + 1), body: 'b', notes: null }).success).toBe(false);
  });

  it('rejects a missing body', () => {
    expect(schema.safeParse({ title: null, notes: null }).success).toBe(false);
  });

  it.each(TYPES)('registers the content type for %s', (type) => {
    expect(draftSchemaContentType(buildDraftOutputSchema(type))).toBe(type);
  });

  it('returns undefined for foreign schemas', () => {
    expect(draftSchemaContentType({})).toBeUndefined();
    expect(draftSchemaContentType(null)).toBeUndefined();
  });
});

describe('applyWordCap', () => {
  it.each(TYPES)('truncates %s to its cap and flags it', (type) => {
    const cap = DRAFT_WORD_CAPS[type];
    const out = applyWordCap(type, { title: null, body: words(cap + 40), notes: null });
    expect(out.truncated).toBe(true);
    expect(countWords(out.body)).toBe(cap);
    expect(out.body.startsWith('w0 w1')).toBe(true);
  });

  it.each(TYPES)('leaves %s at exactly the cap untouched', (type) => {
    const body = words(DRAFT_WORD_CAPS[type]);
    const out = applyWordCap(type, { title: 'T', body, notes: 'N' });
    expect(out).toEqual({ title: 'T', body, notes: 'N', truncated: false });
  });
});

describe('createFakeGenerationLlm with draft schemas', () => {
  const llm = createFakeGenerationLlm();
  const run = (type: (typeof TYPES)[number], user: string) =>
    llm.parseStructured({
      model: 'fake',
      effort: 'high' as const,
      maxTokens: 1000,
      system: 'sys',
      user,
      schema: buildDraftOutputSchema(type),
    });

  it('echoes the brief line with the content type label', async () => {
    const out = await run('social_post', 'Intro\nBrief: launch day\nmore');
    expect(out).toEqual({ title: null, body: 'Fake social post draft. launch day', notes: null });
  });

  it('titles short articles only', async () => {
    expect((await run('short_article', 'Brief: x')).title).toBe('Fake title');
    expect((await run('bio', 'Brief: x')).title).toBeNull();
  });

  it('handles a missing brief line', async () => {
    expect((await run('bio', 'no brief here')).body).toBe('Fake bio draft. ');
  });

  it('appends [M1] when memory is present', async () => {
    const out = await run('bio', 'Brief: x\n<memory ref="M1">text</memory>');
    expect(out.body.endsWith(' [M1]')).toBe(true);
    expect((await run('bio', 'Brief: x')).body).not.toContain('[M1]');
  });

  it('throws LlmRefusedError on FAKE_LLM_REFUSE', async () => {
    await expect(run('bio', 'Brief: FAKE_LLM_REFUSE please')).rejects.toBeInstanceOf(LlmRefusedError);
  });
});
