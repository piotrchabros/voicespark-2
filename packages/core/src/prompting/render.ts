import Mustache from 'mustache';

export interface TemplatePair {
  systemTemplate: string;
  userTemplate: string;
}

// Escaping is off (contract "Template rules"): injected values are already filtered and wrapped in tags.
const RENDER_OPTIONS = { escape: (value: unknown) => String(value) };

/** Renders both templates of a prompt version; partials are never supplied. */
export function render(
  version: TemplatePair,
  variables: Record<string, unknown>,
): { system: string; user: string } {
  return {
    system: Mustache.render(version.systemTemplate, variables, {}, RENDER_OPTIONS),
    user: Mustache.render(version.userTemplate, variables, {}, RENDER_OPTIONS),
  };
}
