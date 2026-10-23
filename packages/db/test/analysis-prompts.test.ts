import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_WRAPPER_EFFORT,
  ANALYSIS_WRAPPER_KEYS,
  ANALYSIS_WRAPPER_MAX_TOKENS,
  ANALYSIS_WRAPPER_TEMPLATES,
  buildAnalysisPromptFromDimensions,
  valueGuidance,
} from '../src/data/analysis-prompts';
import type { Dimension } from '../src/schema';

const formality: Dimension = {
  key: 'formality',
  name: 'Formality',
  description: 'How formal or casual the writing is.',
  valueType: 'scale',
  scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
};

describe('valueGuidance', () => {
  it('describes each value type', () => {
    expect(valueGuidance(formality)).toBe('Rate it on a scale 1-5 (1=very casual, 5=very formal).');
    expect(valueGuidance({ ...formality, valueType: 'enum', allowedValues: ['a', 'b'] })).toBe('Pick one of: a, b.');
    expect(valueGuidance({ ...formality, valueType: 'text' })).toBe('Describe it in free text.');
    expect(valueGuidance({ ...formality, valueType: 'list' })).toBe('Give a list of short phrases.');
  });
});

describe('buildAnalysisPromptFromDimensions', () => {
  const header =
    'Write one section for each aspect below. For each aspect, describe how the author does it, with a short explanation based on the samples. Use the value guidance where it is given.\n\nAspects:';

  it('produces the exact contract text', () => {
    const out = buildAnalysisPromptFromDimensions({
      name: 'General voice',
      description: 'A general description.',
      dimensions: [formality],
    });
    expect(out).toBe(
      `Analyse how the author writes for "General voice". A general description.\n\n${header}\n- Formality: How formal or casual the writing is. Rate it on a scale 1-5 (1=very casual, 5=very formal).`,
    );
  });

  it('omits an empty description and keeps stored order', () => {
    const out = buildAnalysisPromptFromDimensions({
      name: 'V',
      description: '  ',
      dimensions: [
        { ...formality, key: 'zed', name: 'Zed', valueType: 'text', description: 'Z desc.' },
        { ...formality, key: 'abe', name: 'Abe', valueType: 'list', description: 'A desc.', guidance: 'Look  for   habits.' },
      ],
    });
    expect(out.startsWith('Analyse how the author writes for "V".\n\n')).toBe(true);
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- Zed: Z desc. Describe it in free text.',
      '- Abe: A desc. Give a list of short phrases. Look for habits.',
    ]);
  });

  it('is trimmed and within 20,000 characters', () => {
    const out = buildAnalysisPromptFromDimensions({ name: 'V', description: '', dimensions: [] });
    expect(out).toBe(out.trim());
    expect(out.length).toBeLessThanOrEqual(20000);
  });
});

describe('wrapper v2 templates', () => {
  const ALLOWED = new Set([
    'definition.name',
    'definition.description',
    'analysisPrompt',
    'authoredSamples',
    'receivedContext',
    'authoredStats.itemCount',
    'authoredStats.wordCount',
    'authoredStats.languages',
    'previousDocumentJson',
    'user.firstName',
    'excludedCategoryLabels',
    'feedback',
  ]);

  it('covers both keys with the pinned settings', () => {
    expect([...ANALYSIS_WRAPPER_KEYS]).toEqual(['tone_profile.generate', 'tone_profile.feedback']);
    expect(ANALYSIS_WRAPPER_MAX_TOKENS).toBe(16000);
    expect(ANALYSIS_WRAPPER_EFFORT).toBe('medium');
  });

  for (const key of ANALYSIS_WRAPPER_KEYS) {
    it(`${key} only uses whitelisted variables and has the required ones`, () => {
      const t = ANALYSIS_WRAPPER_TEMPLATES[key];
      const all = `${t.systemTemplate}\n${t.userTemplate}`;
      const tags = [...all.matchAll(/\{\{\{?\s*([^}]+?)\s*\}?\}\}/g)].map((m) => m[1]!);
      for (const tag of tags) expect(ALLOWED.has(tag), tag).toBe(true);
      const required = ['definition.name', 'analysisPrompt', 'authoredSamples'];
      if (key === 'tone_profile.feedback') required.push('feedback', 'previousDocumentJson');
      for (const r of required) expect(tags).toContain(r);
      expect(all).not.toMatch(/dimensionsJson|definition\.dimensions|previousProfileJson/);
      expect(t.description.length).toBeGreaterThan(0);
    });
  }
});
