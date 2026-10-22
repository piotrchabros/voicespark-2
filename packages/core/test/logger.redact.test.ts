import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, type SafeLogFields } from '../src/logger';

const SECRET_KEYS = [
  'bodyEnc',
  'body_enc',
  'briefEnc',
  'brief_enc',
  'feedbackEnc',
  'feedback_enc',
  'notesEnc',
  'notes_enc',
  'topicEnc',
  'topic_enc',
  'titleEnc',
  'title_enc',
  'text_enc',
  'generatedTextEnc',
  'editedTextEnc',
  'notifyEmailEnc',
  'email_enc',
  'imapPasswordEnc',
  'password_enc',
  'accessTokenEnc',
  'refreshTokenEnc',
  'token_enc',
  'codeVerifierEnc',
  'verifier_enc',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'password',
  'imapPassword',
  'apiKey',
  'api_key',
  'clientSecret',
  'authorization',
  'cookie',
  'bodyText',
  'subject',
  'headers',
  'someFutureColumnEnc',
  'session_token',
];

function capture(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

function payload(prefix: string): Record<string, string> {
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, `${prefix}-${k}-SECRETVALUE`]));
}

describe('logger redaction (defence in depth)', () => {
  it('never prints content or secret values at top level, nested or deeply nested', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'info', destination: stream });
    const smuggled = {
      ...payload('top'),
      jobId: 'job-1',
      nested: { ...payload('l1'), inner: { ...payload('l2'), deeper: payload('l3') } },
      list: [payload('arr')],
    } as unknown as SafeLogFields;
    log.info(smuggled, 'msg');
    log
      .child({ jobId: 'job-2', ...payload('child') } as unknown as SafeLogFields)
      .warn({ count: 1 });

    expect(lines).toHaveLength(2);
    const out = lines.join('');
    expect(out).not.toContain('SECRETVALUE');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.jobId).toBe('job-1');
    expect(first.bodyEnc).toBe('[redacted]');
    expect(first.accessToken).toBe('[redacted]');
    expect((first.nested as Record<string, unknown>).topic_enc).toBe('[redacted]');
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.jobId).toBe('job-2');
    expect(second.count).toBe(1);
  });

  it('keeps safe fields intact', () => {
    const { lines, stream } = capture();
    createLogger({ destination: stream }).info({
      jobId: 'j',
      errorCode: 'x_y',
      status: 'ok',
      count: 3,
      durationMs: 5,
    });
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({
      jobId: 'j',
      errorCode: 'x_y',
      status: 'ok',
      count: 3,
      durationMs: 5,
    });
  });
});
