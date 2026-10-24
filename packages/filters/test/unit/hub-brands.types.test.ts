import { describe, expect, it } from 'vitest';
import type { ContactValue, FilteredText, HubLlmText, Policy } from '../../src/categories';
import { buildHubDocument } from '../../src/hub';

/** Structural copy of `MemoryDoc` (packages/integrations/src/supermemory/port.ts); filters cannot import integrations. */
interface MemoryDoc {
  id: string;
  content: FilteredText;
  documentDate: string;
  metadata: Record<string, string | number | boolean | string[]>;
}

declare const hubText: HubLlmText;
declare const filtered: FilteredText;
declare const contact: ContactValue;
declare const policy: Policy;

describe('hub brands (compile-time)', () => {
  it('keeps HubLlmText, FilteredText and ContactValue apart', () => {
    // These only matter to `tsc --noEmit` (pnpm typecheck); vitest strips types.
    // The body is never called: `declare const` values have no runtime binding.
    const check = () => {
      // @ts-expect-error HubLlmText must not become MemoryDoc content
      const doc: MemoryDoc = { id: 'x', content: hubText, documentDate: '', metadata: {} };
      // @ts-expect-error HubLlmText is not FilteredText
      const f: FilteredText = hubText;
      // @ts-expect-error FilteredText is not HubLlmText
      const h: HubLlmText = filtered;
      // @ts-expect-error a plain string is not a ContactValue
      const c: ContactValue = 'jan@acme.example';
      // @ts-expect-error FilteredText is not a ContactValue
      const c2: ContactValue = filtered;
      // @ts-expect-error a plain string is not FilteredText
      const f2: FilteredText = 'text';
      void [doc, f, h, c, c2, f2];
    };
    expect(typeof check).toBe('function');
  });

  it('rejects plain strings in buildHubDocument parts', () => {
    const run = () => {
      // @ts-expect-error plain string name
      buildHubDocument('project', { policy, name: 'Apollo', people: [], companies: [] });
      // @ts-expect-error HubLlmText name
      buildHubDocument('project', { policy, name: hubText, people: [], companies: [] });
      // @ts-expect-error plain string contact
      buildHubDocument('person', { policy, name: filtered, emails: ['jan@acme.example'], phones: [], companies: [], projects: [] });
      // @ts-expect-error FilteredText is not a contact value
      buildHubDocument('person', { policy, name: filtered, emails: [filtered], phones: [], companies: [], projects: [] });
      buildHubDocument('person', { policy, name: filtered, emails: [contact], phones: [], companies: [], projects: [] });
    };
    expect(typeof run).toBe('function');
  });
});
