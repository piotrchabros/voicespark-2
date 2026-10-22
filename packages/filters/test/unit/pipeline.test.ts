import { describe, expect, it, vi } from 'vitest';
import {
  FILTER_CATEGORY_KEYS,
  type ClassifierCategory,
  type InspectionInput,
  type Policy,
} from '../../src/categories';
import { inspect, postCheck } from '../../src/pipeline';
import {
  createHaikuClassifier,
  ClassifierError,
  type Classifier,
  type ClassifierOutput,
} from '../../src/classifier';
import { createRecordedClassifier } from '../../src/classifier/recorded';

const PASSWORD = 'Hunter2xyz!';
const API_KEY = 'ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const PASSWORD_LABEL = 'Passwords and passphrases';

function input(over: Partial<InspectionInput> = {}): InspectionInput {
  return {
    kind: 'email',
    subject: 'Lunch on Friday',
    bodyText: 'Hi Anna, shall we have lunch on Friday? Best, Me',
    headers: { from: 'Anna Kowalska <anna@friends.test>', to: 'me@voicespark.test' },
    folders: ['INBOX'],
    ownAddresses: ['me@voicespark.test'],
    ...over,
  };
}

const ALL: Policy = { selectedCategories: FILTER_CATEGORY_KEYS, rules: [] };
const NONE: Policy = { selectedCategories: [], rules: [] };
const noop = createRecordedClassifier();

function spyClassifier(output: ClassifierOutput = { spans: [], mostlySensitive: false }) {
  const classify = vi.fn(async () => output);
  const classifier: Classifier = { classify };
  return { classifier, classify };
}

describe('inspect: locked categories', () => {
  it('forces locked categories on with an empty selectedCategories', async () => {
    const r = await inspect(
      input({ bodyText: `Note to self.\nLogin details\npassword: ${PASSWORD}\nThanks` }),
      NONE,
      { classifier: noop },
    );
    expect(r.outcome).toBe('accepted');
    expect(r.text).toContain(`[excluded: ${PASSWORD_LABEL}]`);
    expect(r.text).not.toContain(PASSWORD);
    expect(r.counts).toEqual([{ category: 'passwords', redactedValues: 1, wholeItem: false }]);
  });

  it('redacts a locked api key even when the policy omits the category', async () => {
    const r = await inspect(input({ bodyText: `deploy with api_key = ${API_KEY} today` }), NONE, {
      classifier: noop,
    });
    expect(r.outcome).toBe('accepted');
    expect(r.text).not.toContain(API_KEY);
    expect(r.text).toContain('[excluded: API keys and access tokens]');
  });

  it('counts each occurrence of a redacted value', async () => {
    const r = await inspect(
      input({ bodyText: `password: ${PASSWORD}\nagain, password: ${PASSWORD}` }),
      ALL,
      { classifier: noop },
    );
    expect(r.counts).toEqual([{ category: 'passwords', redactedValues: 2, wholeItem: false }]);
  });
});

describe('inspect: stage order', () => {
  it('user rule wins over credential delivery', async () => {
    const r = await inspect(
      input({
        subject: 'Your verification code',
        bodyText: 'Your verification code is 482913. Do not share it.',
        headers: { from: 'no-reply@bank.test' },
      }),
      { selectedCategories: FILTER_CATEGORY_KEYS, rules: [{ type: 'sender', value: 'no-reply@bank.test' }] },
      { classifier: noop },
    );
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'user_rule', redactedValues: 0, wholeItem: true }]);
  });

  it('credential delivery excludes the whole item before span redaction', async () => {
    const r = await inspect(
      input({
        subject: 'Your verification code',
        bodyText: 'Your verification code is 482913. Do not share it with anyone.',
        headers: { from: 'no-reply@service.test' },
      }),
      ALL,
      { classifier: noop },
    );
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'otp_codes', redactedValues: 0, wholeItem: true }]);
  });

  it('excluded results carry no text or fields', async () => {
    const r = await inspect(
      input({ bodyText: 'x' }),
      { selectedCategories: [], rules: [{ type: 'keyword', value: 'lunch' }] },
      { classifier: noop },
    );
    expect(r.outcome).toBe('excluded');
    expect(r.text).toBeUndefined();
    expect(r.fields).toBeUndefined();
  });

  it('user rule excludes without calling the classifier', async () => {
    const { classifier, classify } = spyClassifier();
    await inspect(
      input(),
      { selectedCategories: FILTER_CATEGORY_KEYS, rules: [{ type: 'domain', value: 'friends.test' }] },
      { classifier },
    );
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('inspect: classifier stage', () => {
  it('is not called when no classifier category is selected', async () => {
    const { classifier, classify } = spyClassifier();
    await inspect(input(), { selectedCategories: ['payment_cards'], rules: [] }, { classifier });
    expect(classify).not.toHaveBeenCalled();
  });

  it('is called with the selected classifier categories only', async () => {
    const { classifier, classify } = spyClassifier();
    await inspect(input(), { selectedCategories: ['health', 'payment_cards'], rules: [] }, { classifier });
    expect(classify).toHaveBeenCalledTimes(1);
    const call = classify.mock.calls[0] as unknown as [string, { categories?: ClassifierCategory[] }];
    expect(call[1].categories).toEqual(['health']);
  });

  it('is called on the stage-3 text, with locked values already redacted', async () => {
    const { classifier, classify } = spyClassifier();
    await inspect(
      input({ bodyText: `I have a cold. password: ${PASSWORD}` }),
      { selectedCategories: ['health'], rules: [] },
      { classifier },
    );
    const text = (classify.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('I have a cold.');
    expect(text).not.toContain(PASSWORD);
  });

  it('redacts located classifier spans with the category label token', async () => {
    const r = await inspect(
      input({ bodyText: 'Lunch is fine. I was diagnosed with diabetes last year.' }),
      { selectedCategories: ['health'], rules: [] },
      { classifier: createRecordedClassifier({ spans: [{ category: 'health', text: 'diagnosed with diabetes' }], mostlySensitive: false }) },
    );
    expect(r.outcome).toBe('accepted');
    expect(r.text).not.toContain('diabetes');
    expect(r.text).toContain('[excluded: Health information]');
    expect(r.counts).toEqual([{ category: 'health', redactedValues: 1, wholeItem: false }]);
  });

  it('redacts every occurrence of a located span', async () => {
    const r = await inspect(
      input({ bodyText: 'My asthma is bad. Again, my asthma flared.' }),
      { selectedCategories: ['health'], rules: [] },
      { classifier: createRecordedClassifier({ spans: [{ category: 'health', text: 'my asthma' }], mostlySensitive: false }) },
    );
    expect(r.text).not.toContain('my asthma');
    expect(r.counts[0]?.redactedValues).toBeGreaterThanOrEqual(2);
  });

  it('excludes the whole item when mostlySensitive', async () => {
    const r = await inspect(
      input({ bodyText: 'Long text about my treatment and diagnosis.' }),
      { selectedCategories: ['health'], rules: [] },
      {
        classifier: createRecordedClassifier({
          spans: [{ category: 'health', text: 'treatment' }],
          mostlySensitive: true,
        }),
      },
    );
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'health', redactedValues: 0, wholeItem: true }]);
  });

  it('mostlySensitive with no spans falls back to special_category', async () => {
    const r = await inspect(
      input(),
      { selectedCategories: ['special_category'], rules: [] },
      { classifier: createRecordedClassifier({ spans: [], mostlySensitive: true }) },
    );
    expect(r.counts).toEqual([{ category: 'special_category', redactedValues: 0, wholeItem: true }]);
  });

  it('excludes the whole item when a span cannot be located in the text', async () => {
    const r = await inspect(
      input(),
      { selectedCategories: ['health'], rules: [] },
      {
        classifier: createRecordedClassifier({
          spans: [{ category: 'health', text: 'this text is not in the body' }],
          mostlySensitive: false,
        }),
      },
    );
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'health', redactedValues: 0, wholeItem: true }]);
  });
});

describe('inspect: fail closed', () => {
  it('excludes with inspection_failed when the classifier throws', async () => {
    const classifier: Classifier = {
      classify: async () => {
        throw new Error('boom');
      },
    };
    const r = await inspect(input(), ALL, { classifier });
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'inspection_failed', redactedValues: 0, wholeItem: true }]);
    expect(r.text).toBeUndefined();
  });

  it('excludes with inspection_failed on ClassifierError', async () => {
    const classifier: Classifier = {
      classify: async () => {
        throw new ClassifierError('exhausted');
      },
    };
    const r = await inspect(input(), ALL, { classifier });
    expect(r.counts).toEqual([{ category: 'inspection_failed', redactedValues: 0, wholeItem: true }]);
  });

  it('excludes with inspection_failed when the classifier never resolves (timeoutMs)', async () => {
    const classifier: Classifier = { classify: () => new Promise<ClassifierOutput>(() => {}) };
    const r = await inspect(input(), ALL, { classifier, timeoutMs: 50 });
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'inspection_failed', redactedValues: 0, wholeItem: true }]);
  });

  it('createHaikuClassifier with a failing parseStructured is attempted 3 times, then inspection_failed', async () => {
    const parseStructured = vi.fn(async () => {
      throw new Error('upstream down');
    });
    const classifier = createHaikuClassifier({ parseStructured, model: 'test-model' });
    const r = await inspect(input(), ALL, { classifier });
    expect(parseStructured).toHaveBeenCalledTimes(3);
    expect(r.outcome).toBe('excluded');
    expect(r.counts).toEqual([{ category: 'inspection_failed', redactedValues: 0, wholeItem: true }]);
  });
});

describe('postCheck', () => {
  it('returns the locked category for a leaked value', async () => {
    expect(await postCheck(`password: ${PASSWORD}`)).toBe('passwords');
  });

  it('returns null for clean text', async () => {
    expect(await postCheck('See you at lunch on Friday.')).toBeNull();
  });
});

describe('inspect: result hygiene and inspected fields', () => {
  it('never leaks planted values anywhere in the serialized result', async () => {
    const r = await inspect(
      input({
        subject: `Re: password: ${PASSWORD}`,
        bodyText: `api_key = ${API_KEY}\npassword: ${PASSWORD}`,
      }),
      ALL,
      { classifier: noop },
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(API_KEY);
  });

  it('inspects the subject', async () => {
    const r = await inspect(input({ subject: `Login password: ${PASSWORD}` }), ALL, { classifier: noop });
    expect(r.outcome).toBe('accepted');
    expect(r.fields?.subject).toBeDefined();
    expect(r.fields?.subject).not.toContain(PASSWORD);
    expect(r.fields?.subject).toContain('[excluded:');
  });

  it('inspects the title of a note', async () => {
    const r = await inspect(
      input({ kind: 'note', subject: undefined, title: `password: ${PASSWORD}`, headers: {} }),
      ALL,
      { classifier: noop },
    );
    expect(r.fields?.title).not.toContain(PASSWORD);
  });

  it('inspects the filename', async () => {
    const r = await inspect(
      input({ kind: 'file', subject: undefined, filename: `api_key=${API_KEY}.txt`, headers: {} }),
      ALL,
      { classifier: noop },
    );
    expect(r.fields?.filename).not.toContain(API_KEY);
  });

  it('inspects the sender display name', async () => {
    const r = await inspect(
      input({ headers: { from: `"password: ${PASSWORD}" <anna@friends.test>` } }),
      NONE,
      { classifier: noop },
    );
    expect(r.outcome).toBe('accepted');
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });

  it('returns the sender name and address when third_party_contacts is not selected', async () => {
    const r = await inspect(input(), NONE, { classifier: noop });
    expect(r.fields?.fromName).toBe('Anna Kowalska');
    expect(r.fields?.fromAddress).toBe('anna@friends.test');
  });

  it('omits fromAddress when third_party_contacts is selected, without counting it', async () => {
    const r = await inspect(input(), { selectedCategories: ['third_party_contacts'], rules: [] }, { classifier: noop });
    expect(r.outcome).toBe('accepted');
    expect(r.fields?.fromName).toBe('Anna Kowalska');
    expect(r.fields?.fromAddress).toBeUndefined();
    expect(r.counts).toEqual([]);
  });

  it('does not return to/cc headers', async () => {
    const r = await inspect(input({ headers: { from: 'anna@friends.test', to: 'secret@elsewhere.test', cc: 'cc@elsewhere.test' } }), NONE, { classifier: noop });
    const json = JSON.stringify(r);
    expect(json).not.toContain('secret@elsewhere.test');
    expect(json).not.toContain('cc@elsewhere.test');
  });

  it('accepts clean text with empty counts and a language hint', async () => {
    const r = await inspect(
      input({ bodyText: 'Hello, I hope you are doing well. Let us meet next week to discuss the project plan and the budget.' }),
      NONE,
      { classifier: noop },
    );
    expect(r.outcome).toBe('accepted');
    expect(r.counts).toEqual([]);
    expect(r.languageHint).toBe('en');
  });
});
