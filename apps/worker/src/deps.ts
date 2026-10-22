import { loadEnv } from '@voicespark/core/env';
import { createFakeGenerationLlm } from '@voicespark/core/prompting';
import { getClassifier } from '@voicespark/core/services/inspection';
import { openFetcher } from '@voicespark/core/services/mail-access';
import type { Classifier } from '@voicespark/filters';
import { createLlm, type LlmClient } from '@voicespark/integrations/anthropic';
import type { MailFetcher } from '@voicespark/integrations/mail';
import { createMemoryStore, type MemoryStore } from '@voicespark/integrations/supermemory';

/** Collaborators of the content processors; tests override them (InMemory store, recorded classifier). */
export interface WorkerDeps {
  store: MemoryStore;
  classifier: Classifier;
  openFetcher: (sourceId: string) => Promise<MailFetcher>;
  /** Generation LLM; the deterministic fake only under NODE_ENV=test / AUTH_TEST_MODE (via `createLlm`). */
  llm: LlmClient;
}

/** Builds the defaults for whatever `overrides` leaves out. Call lazily (on first job), never at module top level. */
export function defaultDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: overrides.store ?? createMemoryStore(loadEnv()),
    classifier: overrides.classifier ?? getClassifier(),
    openFetcher: overrides.openFetcher ?? openFetcher,
    llm: overrides.llm ?? lazyLlm(),
  };
}

/** Resolved on first call, so processors that never call the LLM do not need ANTHROPIC_API_KEY outside production. */
function lazyLlm(): LlmClient {
  let client: LlmClient | undefined;
  return {
    parseStructured: (args) => {
      client ??= createLlm(loadEnv(), createFakeGenerationLlm());
      return client.parseStructured(args);
    },
  };
}
