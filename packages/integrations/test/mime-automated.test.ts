import { describe, expect, it } from 'vitest';
import { classifyAutomated, threadIsAutomated } from '../src/mime/automated';

const msg = (headers: Record<string, string> = {}, from = 'Ann Nowak <ann@acme.example>') => ({ headers, from });

describe('classifyAutomated', () => {
  it('passes ordinary human mail', () => {
    expect(classifyAutomated(msg(), ['INBOX'])).toEqual({ automated: false, reason: null });
  });

  it.each([
    [{ 'list-unsubscribe': '<mailto:u@acme.example>' }, 'list_header'],
    [{ 'list-id': 'news.acme.example' }, 'list_header'],
    [{ precedence: 'bulk' }, 'precedence'],
    [{ precedence: ' List ' }, 'precedence'],
    [{ precedence: 'junk' }, 'precedence'],
    [{ 'auto-submitted': 'auto-replied' }, 'auto_submitted'],
    [{ 'x-auto-response-suppress': 'All' }, 'auto_response_suppress'],
    [{ 'return-path': '<>' }, 'null_return_path'],
    [{ 'return-path': ' < > ' }, 'null_return_path'],
    [{ 'x-mailgun-variables': '{}' }, 'esp_header'],
    [{ 'x-mailchimp-campaign': 'c' }, 'esp_header'],
    [{ 'x-campaignid': '1' }, 'esp_header'],
    [{ 'x-sg-eid': 'e' }, 'esp_header'],
    [{ 'x-ses-outgoing': 'x' }, 'esp_header'],
    [{ 'x-mc-user': 'u' }, 'esp_header'],
    [{ 'feedback-id': '1:2' }, 'esp_header'],
  ])('header rule %o -> %s', (headers, reason) => {
    expect(classifyAutomated(msg(headers), [])).toEqual({ automated: true, reason });
  });

  it('ignores non-matching header values', () => {
    expect(classifyAutomated(msg({ precedence: 'first-class' }), []).automated).toBe(false);
    expect(classifyAutomated(msg({ 'auto-submitted': 'No' }), []).automated).toBe(false);
    expect(classifyAutomated(msg({ 'return-path': '<ann@acme.example>' }), []).automated).toBe(false);
  });

  it.each([
    'noreply@acme.example',
    'no-reply@acme.example',
    'do-not-reply@acme.example',
    'DoNotReply@acme.example',
    'donotreply@acme.example',
    'notification@acme.example',
    'notifications+abc@acme.example',
    'notify@acme.example',
    'mailer-daemon@acme.example',
    'postmaster@acme.example',
    'bounce@acme.example',
    'bounces-123@acme.example',
    'alert@acme.example',
    'alerts.prod@acme.example',
    'newsletter@acme.example',
    'news@acme.example',
    'marketing@acme.example',
    'automated@acme.example',
    'system@acme.example',
    'robot_1@acme.example',
    'powiadomienia@bank.example',
    'nie-odpowiadaj@sklep.example',
    'nieodpowiadaj@sklep.example',
  ])('sender pattern %s', (address) => {
    expect(classifyAutomated(msg({}, `Robot <${address}>`), [])).toEqual({ automated: true, reason: 'sender_pattern' });
    expect(classifyAutomated(msg({}, address), []).reason).toBe('sender_pattern');
  });

  it.each(['newsroom@acme.example', 'systems-team@acme.example', 'ann.noreply@acme.example', 'alertness@acme.example'])(
    'sender %s is not a pattern match',
    (address) => {
      expect(classifyAutomated(msg({}, address), []).automated).toBe(false);
    },
  );

  it.each(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'])('gmail label %s', (label) => {
    expect(classifyAutomated(msg(), ['INBOX', label])).toEqual({ automated: true, reason: 'gmail_category' });
  });

  it('does not treat CATEGORY_PERSONAL as automated', () => {
    expect(classifyAutomated(msg(), ['CATEGORY_PERSONAL']).automated).toBe(false);
  });

  it('the first matching rule wins', () => {
    const all = {
      'list-id': 'x',
      precedence: 'bulk',
      'auto-submitted': 'auto-generated',
      'x-auto-response-suppress': 'All',
      'return-path': '<>',
      'x-mailgun-tag': 't',
    };
    const from = 'noreply@acme.example';
    const labels = ['CATEGORY_UPDATES'];
    expect(classifyAutomated(msg(all, from), labels).reason).toBe('list_header');
    const { 'list-id': _l, ...noList } = all;
    expect(classifyAutomated(msg(noList, from), labels).reason).toBe('precedence');
    const { precedence: _p, ...noPrec } = noList;
    expect(classifyAutomated(msg(noPrec, from), labels).reason).toBe('auto_submitted');
    const { 'auto-submitted': _a, ...noAuto } = noPrec;
    expect(classifyAutomated(msg(noAuto, from), labels).reason).toBe('auto_response_suppress');
    const { 'x-auto-response-suppress': _x, ...noSupp } = noAuto;
    expect(classifyAutomated(msg(noSupp, from), labels).reason).toBe('null_return_path');
    const { 'return-path': _r, ...noRet } = noSupp;
    expect(classifyAutomated(msg(noRet, from), labels).reason).toBe('esp_header');
    expect(classifyAutomated(msg({}, from), labels).reason).toBe('sender_pattern');
    expect(classifyAutomated(msg({}), labels).reason).toBe('gmail_category');
  });

  it('stays linear on a 1M-char adversarial sender and headers', () => {
    const long = 'no-reply' + '-'.repeat(1_000_000) + '!';
    const started = performance.now();
    classifyAutomated(msg({ precedence: ' '.repeat(1_000_000) + 'x', 'return-path': '<' + ' '.repeat(1_000_000) }, `${long}@acme.example`), []);
    classifyAutomated(msg({}, '<'.repeat(1_000_000)), []);
    classifyAutomated(msg({}, 'a'.repeat(1_000_000) + '@'), []);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('threadIsAutomated', () => {
  const inbound = (automated: boolean) => ({ direction: 'inbound' as const, automated });
  const outbound = { direction: 'outbound' as const, automated: false };

  it('is true when every inbound message is automated and none is outbound', () => {
    expect(threadIsAutomated([inbound(true)])).toBe(true);
    expect(threadIsAutomated([inbound(true), inbound(true)])).toBe(true);
  });

  it('is false with any outbound message', () => {
    expect(threadIsAutomated([inbound(true), outbound])).toBe(false);
  });

  it('is false when one inbound message is human', () => {
    expect(threadIsAutomated([inbound(true), inbound(false)])).toBe(false);
  });

  it('is false without inbound messages', () => {
    expect(threadIsAutomated([])).toBe(false);
    expect(threadIsAutomated([outbound])).toBe(false);
  });
});
