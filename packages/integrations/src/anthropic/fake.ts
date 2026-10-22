import type { LlmClient, ParseStructuredArgs } from './client';

/** Test double: the responder returns a recorded fixture, validated against the caller's schema. */
export function createFakeLlm(responder: (args: ParseStructuredArgs<unknown>) => unknown): LlmClient {
  return {
    async parseStructured<T>(args: ParseStructuredArgs<T>): Promise<T> {
      return args.schema.parse(responder(args as ParseStructuredArgs<unknown>));
    },
  };
}
