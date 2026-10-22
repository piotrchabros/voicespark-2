import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high';

export interface ParseStructuredArgs<T> {
  model: string;
  effort: Effort;
  maxTokens: number;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  stream?: boolean;
  fallback?: boolean;
}

export type ParseStructured = <T>(args: ParseStructuredArgs<T>) => Promise<T>;

export interface LlmClient {
  parseStructured: ParseStructured;
}

export class LlmRefusedError extends Error {
  readonly code = 'llm_refused';
  constructor(message = 'The model declined to answer this request') {
    super(message);
    this.name = 'LlmRefusedError';
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Minimal slice of the SDK used here, so tests can stub it. */
interface ParsedMessageLike {
  stop_reason: string | null;
  parsed_output?: unknown;
}
export interface AnthropicSdkLike {
  beta: {
    messages: {
      parse(params: Record<string, unknown>): PromiseLike<ParsedMessageLike>;
      stream(params: Record<string, unknown>): { finalMessage(): PromiseLike<ParsedMessageLike> };
    };
  };
}

export function createAnthropicClient(opts: { apiKey: string; sdk?: AnthropicSdkLike }): LlmClient {
  // The SDK client is constructed lazily so importing this module never needs env.
  let sdk = opts.sdk;
  const getSdk = (): AnthropicSdkLike =>
    (sdk ??= new Anthropic({ apiKey: opts.apiKey }) as unknown as AnthropicSdkLike);

  return {
    async parseStructured<T>(args: ParseStructuredArgs<T>): Promise<T> {
      const params: Record<string, unknown> = {
        model: args.model,
        max_tokens: args.maxTokens,
        // cache_control on the system block; no prefill, no forced tool_choice.
        system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: args.user }],
        output_config: {
          effort: args.effort,
          format: betaZodOutputFormat(args.schema as z.ZodType),
        },
      };
      if (args.fallback !== false && args.model.includes('sonnet')) {
        params.betas = [SERVER_SIDE_FALLBACK_BETA];
        params.fallbacks = 'default';
      }

      const messages = getSdk().beta.messages;
      const message = args.stream
        ? await messages.stream(params).finalMessage()
        : await messages.parse(params);

      if (message.stop_reason === 'refusal') throw new LlmRefusedError();
      if (message.parsed_output == null) {
        throw new Error('LLM response did not contain structured output');
      }
      return message.parsed_output as T;
    },
  };
}

/** Fake selected only under NODE_ENV=test / AUTH_TEST_MODE=1; otherwise a missing key fails startup. */
export function createLlm(
  env: { NODE_ENV: string; AUTH_TEST_MODE?: boolean; ANTHROPIC_API_KEY?: string },
  fake?: LlmClient,
): LlmClient {
  if (env.NODE_ENV === 'test' || env.AUTH_TEST_MODE === true) {
    if (fake) return fake;
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new LlmConfigError('ANTHROPIC_API_KEY is required');
  }
  return createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY });
}
