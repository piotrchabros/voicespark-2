import { describe, expect, it } from 'vitest';
import { DETECTOR_CHECKSUM, detect } from '../../src/detectors/contacts';
import { coveredText, covers, ctx } from './helpers';

describe('contacts detector', () => {
  it('exports a checksum label', () => {
    expect(DETECTOR_CHECKSUM).toMatch(/^contacts@/);
  });

  it("flags other people's email addresses", async () => {
    const text = 'Please contact anna.kowalska@example.org about the contract.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'anna.kowalska@example.org')).toBe(true);
    expect(spans.every((s) => s.category === 'third_party_contacts')).toBe(true);
  });

  it("does not flag the user's own address", async () => {
    const text = 'Sent from me@voicespark.test to the team.';
    expect(await detect(text, ctx())).toEqual([]);
  });

  it('matches own addresses case-insensitively', async () => {
    const text = 'Reply to Me@VoiceSpark.test please.';
    expect(await detect(text, ctx())).toEqual([]);
  });

  it('flags other addresses while leaving the own address alone', async () => {
    const text = 'From me@voicespark.test, cc bob@partner.test.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, 'bob@partner.test')).toBe(true);
    expect(covers(text, spans, 'me@voicespark.test')).toBe(false);
  });

  it('flags Polish phone numbers with default region PL', async () => {
    const text = 'Zadzwoń do Marka: +48 601 234 567 lub 601 234 568.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '+48 601 234 567')).toBe(true);
    expect(covers(text, spans, '601 234 568')).toBe(true);
  });

  it('flags international numbers written with a country code', async () => {
    const text = 'Call the office on +44 20 7946 0958 tomorrow.';
    const spans = await detect(text, ctx());
    expect(covers(text, spans, '+44 20 7946 0958')).toBe(true);
  });

  it('does not flag surrounding prose', async () => {
    const text = 'Zadzwoń do Marka: +48 601 234 567 jutro.';
    const spans = await detect(text, ctx());
    expect(coveredText(text, spans).join(' ')).not.toContain('Zadzwoń');
  });

  it('does not flag text without contact details', async () => {
    expect(await detect('Meeting at 10:30, invoice 2024/05, version 1.2.3.', ctx())).toEqual([]);
  });
});
