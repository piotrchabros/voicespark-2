import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/api-keys';
import { covers, ctx } from './helpers';

// Synthetic, format-valid values (no "example"/"dummy" markers, which secretlint allowlists).
const AWS_KEY = 'AKIAQ3XW7ZP2LM9TR5VB';
const GITHUB_TOKEN = 'ghp_a8Kd92LmQx7Zp3Vb1Nc6Ty4Wr0Es5HuJiOfG';
const SLACK_TOKEN = 'xoxb-8142093756-5907312846201-Qw8ErTy3UiOp5AsDf2GhJk7L';
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5ODc2NTQzMjEwIiwibmFtZSI6IkphbmUifQ.Kq8Zr3vXw1Yt5Ub7Nc9Md2Lf6Hg4Js0Pa';

describe('api-keys detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^api/);
  });

  it.each([
    ['AWS access key', `aws id ${AWS_KEY} in the console`, AWS_KEY],
    ['GitHub token', `Use ${GITHUB_TOKEN} for CI`, GITHUB_TOKEN],
    ['Slack token', `Bot token ${SLACK_TOKEN} here`, SLACK_TOKEN],
    ['JWT', `Session: ${JWT} ok`, JWT],
  ])('redacts a %s', async (_name, text, value) => {
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
  });

  it('redacts a Bearer token and not the word Bearer', async () => {
    const token = 'q8Zr3vXw1Yt5Ub7Nc9Md2Lf6Hg4Js0Pa';
    const text = `Authorization: Bearer ${token}`;
    const spans = await detect(text, ctx());
    expect(covers(text, spans, token)).toBe(true);
    expect(covers(text, spans, 'Bearer')).toBe(false);
  });

  it('redacts a generic high-entropy key assignment and not the key name', async () => {
    const value = 'f83Kd92LmQx7Zp3Vb1Nc6Ty4Wr0E';
    const text = `api_key = ${value}`;
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
    expect(covers(text, spans, 'api_key')).toBe(false);
  });

  it('redacts a generic secret assignment', async () => {
    const value = 'Zr3vXw1Yt5Ub7Nc9Md2Lf6Hg4Js0Pa8K';
    const text = `secret: ${value}`;
    const spans = await detect(text, ctx());
    expect(covers(text, spans, value)).toBe(true);
  });

  it('returns spans in the api_keys_tokens category', async () => {
    const spans = await detect(`key ${GITHUB_TOKEN}`, ctx());
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(s.category).toBe('api_keys_tokens');
  });

  it('does not flag a short or low-entropy generic assignment', async () => {
    expect(await detect('token: abc123', ctx())).toEqual([]);
    expect(await detect('api_key = aaaaaaaaaaaaaaaaaaaaaaaa', ctx())).toEqual([]);
  });

  it('returns nothing for benign prose', async () => {
    expect(await detect('We shipped the new release version 2.4.1 on Tuesday.', ctx())).toEqual([]);
  });
});
