import Mustache from 'mustache';
import type { Dimension } from '@voicespark/db';

export type PromptKeyFamily = 'tone_profile.generate' | 'tone_profile.feedback' | 'draft' | 'custom';

/** Maps a prompt key to its variable whitelist (contracts/prompt-template-variables.md). */
export function familyFor(key: string): PromptKeyFamily {
  if (key === 'tone_profile.generate' || key === 'tone_profile.feedback') return key;
  if (key.startsWith('draft.')) return 'draft';
  return 'custom';
}

export interface VariableSpec {
  scalars: readonly string[];
  lists: Readonly<Record<string, readonly string[]>>;
  /** Boolean sections, e.g. `{{#isRevision}}`. */
  sections: readonly string[];
  required: readonly string[];
}

const DIMENSION_ITEM_FIELDS = ['key', 'name', 'description', 'valueType', 'valueSpec', 'guidance'] as const;

const GENERATE_SCALARS = [
  'definition.name',
  'definition.description',
  'definition.dimensionsJson',
  'authoredSamples',
  'receivedContext',
  'authoredStats.itemCount',
  'authoredStats.wordCount',
  'authoredStats.languages',
  'previousProfileJson',
  'user.firstName',
  'excludedCategoryLabels',
] as const;

const DRAFT_SCALARS = [
  'brief',
  'profileJson',
  'contentTypeLabel',
  'profileSummary',
  'definitionName',
  'memoryContext',
  'previousDraft',
  'feedback',
  'excludedCategoryLabels',
  'user.firstName',
  'languageHint',
] as const;

const PROFILE_LISTS = { 'definition.dimensions': DIMENSION_ITEM_FIELDS };

export const PROMPT_VARIABLES: Readonly<Record<PromptKeyFamily, VariableSpec>> = {
  'tone_profile.generate': {
    scalars: GENERATE_SCALARS,
    lists: PROFILE_LISTS,
    sections: [],
    required: ['definition.name', 'definition.dimensionsJson', 'authoredSamples'],
  },
  'tone_profile.feedback': {
    scalars: [...GENERATE_SCALARS, 'feedback'],
    lists: PROFILE_LISTS,
    sections: [],
    required: ['definition.name', 'definition.dimensionsJson', 'authoredSamples', 'feedback', 'previousProfileJson'],
  },
  draft: {
    scalars: DRAFT_SCALARS,
    lists: {},
    sections: ['isRevision'],
    required: ['brief', 'profileJson'],
  },
  // No generation path renders custom.* prompts, so they get the union and nothing is required (D-P5).
  custom: {
    scalars: [...new Set<string>([...GENERATE_SCALARS, 'feedback', ...DRAFT_SCALARS])],
    lists: PROFILE_LISTS,
    sections: ['isRevision'],
    required: [],
  },
};

export interface TemplateValidation {
  valid: boolean;
  unknownVariables: string[];
  missingRequired: string[];
}

// Mustache token tuple: [type, value, start, end, subTokens?, ...].
type Token = [string, string, number, number, Token[]?, ...unknown[]];

function walk(
  tokens: Token[],
  spec: VariableSpec,
  itemFields: readonly string[],
  seen: Set<string>,
  unknown: Set<string>,
): void {
  for (const token of tokens) {
    const [type, value] = token;
    switch (type) {
      case 'name':
      case '&':
        seen.add(value);
        if (!spec.scalars.includes(value) && !spec.sections.includes(value) && !itemFields.includes(value)) {
          unknown.add(value);
        }
        break;
      case '#':
      case '^': {
        seen.add(value);
        const listFields = spec.lists[value];
        if (listFields === undefined && !spec.sections.includes(value)) unknown.add(value);
        walk(token[4] ?? [], spec, listFields ?? itemFields, seen, unknown);
        break;
      }
      case '>':
        unknown.add(`partial:${value}`);
        break;
      case '=':
        unknown.add('delimiter');
        break;
      default:
        break; // 'text' and '!' comments
    }
  }
}

/** Whitelist + required-variable check for one prompt version (FR-039); used on save, publish and in tests. */
export function validateTemplate(key: string, systemTemplate: string, userTemplate: string): TemplateValidation {
  const spec = PROMPT_VARIABLES[familyFor(key)];
  const seen = new Set<string>();
  const unknown = new Set<string>();
  try {
    for (const template of [systemTemplate, userTemplate]) {
      walk(Mustache.parse(template) as Token[], spec, [], seen, unknown);
    }
  } catch {
    return { valid: false, unknownVariables: ['<parse_error>'], missingRequired: [] };
  }
  const unknownVariables = [...unknown].sort();
  const missingRequired = spec.required.filter((name) => !seen.has(name)).sort();
  return { valid: unknownVariables.length === 0 && missingRequired.length === 0, unknownVariables, missingRequired };
}

export interface SampleInput {
  /** `A{n}` */
  ref: string;
  kind: 'email' | 'attachment' | 'file' | 'note';
  /** YYYY-MM-DD */
  date: string;
  lang: string | null;
  text: string;
}

/** `authoredSamples`: one `<sample ...>` block per inspected authored item. */
export function formatAuthoredSamples(samples: SampleInput[]): string {
  return samples
    .map((s) => `<sample ref="${s.ref}" kind="${s.kind}" date="${s.date}" lang="${s.lang ?? 'und'}">${s.text}</sample>`)
    .join('\n');
}

/** `receivedContext`: background-only block, or '' when there is none. */
export function formatReceivedContext(items: { kind: string; date: string; text: string }[]): string {
  if (items.length === 0) return '';
  const body = items.map((i) => `<item kind="${i.kind}" date="${i.date}">${i.text}</item>`).join('\n');
  return `<received_context>\n${body}\n</received_context>`;
}

export interface DimensionPromptItem {
  key: string;
  name: string;
  description: string;
  valueType: string;
  valueSpec: string;
  guidance: string;
}

export function valueSpec(d: Dimension): string {
  switch (d.valueType) {
    case 'scale':
      return d.scale
        ? `scale ${d.scale.min}-${d.scale.max} (${d.scale.min}=${d.scale.minLabel}, ${d.scale.max}=${d.scale.maxLabel})`
        : 'scale';
    case 'enum':
      return `one of: ${(d.allowedValues ?? []).join(', ')}`;
    case 'text':
      return 'free text';
    case 'list':
      return 'list of short phrases';
  }
}

/** `definition.dimensions` list items with prerendered `valueSpec`. */
export function formatDimensions(dims: Dimension[]): DimensionPromptItem[] {
  return dims.map((d) => ({
    key: d.key,
    name: d.name,
    description: d.description,
    valueType: d.valueType,
    valueSpec: valueSpec(d),
    guidance: d.guidance ?? '',
  }));
}

/** `definition.dimensionsJson`. */
export function dimensionsJson(dims: Dimension[]): string {
  return JSON.stringify(
    dims.map((d) => ({
      key: d.key,
      name: d.name,
      description: d.description,
      valueType: d.valueType,
      scale: d.scale,
      allowedValues: d.allowedValues,
      guidance: d.guidance,
    })),
  );
}
