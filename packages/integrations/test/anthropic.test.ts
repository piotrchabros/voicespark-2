import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  LlmConfigError,
  LlmRefusedError,
  createAnthropicClient,
  createFakeLlm,
  createLlm,
  type AnthropicSdkLike,
} from '../src/anthropic';

const schema = z.object({ tone: z.string() });
const base = { effort: 'low' as const, maxTokens: 100, system: 's', user: 'u', schema };

function stubSdk(message: { stop_reason: string; parsed_output?: unknown }) {
  const parse = vi.fn(async (_p: Record<string, unknown>) => message);
  const finalMessage = vi.fn(async () => message);
  const stream = vi.fn(() => ({ finalMessage }));
  const sdk = { beta: { messages: { parse, stream } } } as unknown as AnthropicSdkLike;
  return { sdk, parse, stream };
}

describe('fake llm', () => {
  it('validates responder output with the schema', async () => {
    const llm = createFakeLlm(() => ({ tone: 'warm' }));
    await expect(llm.parseStructured({ ...base, model: 'm' })).resolves.toEqual({ tone: 'warm' });
    const bad = createFakeLlm(() => ({ nope: 1 }));
    await expect(bad.parseStructured({ ...base, model: 'm' })).rejects.toThrow();
  });
});

describe('anthropic client', () => {
  it('maps refusal stop_reason to LlmRefusedError', async () => {
    const { sdk } = stubSdk({ stop_reason: 'refusal' });
    const llm = createAnthropicClient({ apiKey: 'k', sdk });
    const err = await llm.parseStructured({ ...base, model: 'claude-sonnet-5-5' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmRefusedError);
    expect(err.code).toBe('llm_refused');
  });

  it('sends cached system block and fallback only for sonnet', async () => {
    const { sdk, parse } = stubSdk({ stop_reason: 'end_turn', parsed_output: { tone: 'x' } });
    const llm = createAnthropicClient({ apiKey: 'k', sdk });
    await llm.parseStructured({ ...base, model: 'claude-sonnet-5-5' });
    await llm.parseStructured({ ...base, model: 'claude-haiku-5-5' });
    const [sonnet, haiku] = parse.mock.calls.map((c) => c[0]);
    expect(sonnet?.system).toEqual([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]);
    expect(sonnet?.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(sonnet?.fallbacks).toBe('default');
    expect(haiku?.fallbacks).toBeUndefined();
    expect(sonnet).not.toHaveProperty('tool_choice');
  });

  it('uses streaming finalMessage when stream is true', async () => {
    const { sdk, parse, stream } = stubSdk({ stop_reason: 'end_turn', parsed_output: { tone: 'y' } });
    const llm = createAnthropicClient({ apiKey: 'k', sdk });
    await expect(llm.parseStructured({ ...base, model: 'm', stream: true })).resolves.toEqual({ tone: 'y' });
    expect(stream).toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('createLlm', () => {
  const fake = createFakeLlm(() => ({ tone: 'f' }));
  it('uses the fake only in test modes', () => {
    expect(createLlm({ NODE_ENV: 'test' }, fake)).toBe(fake);
    expect(createLlm({ NODE_ENV: 'production', AUTH_TEST_MODE: true }, fake)).toBe(fake);
  });
  it('fails startup without a key outside test modes', () => {
    expect(() => createLlm({ NODE_ENV: 'production' }, fake)).toThrow(LlmConfigError);
  });
});
