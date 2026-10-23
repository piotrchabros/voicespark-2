import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_GUARD,
  ANALYSIS_GUARD_REMINDER,
  ZERO_WIDTH_SPACE,
  buildMessages,
  fillLabels,
  neutralizeTags,
  stripNeutralizer,
  wrapAnalysisPrompt,
} from '../src/prompting/analysis';

describe('guard texts', () => {
  it('keeps the contract wording and the {labels} placeholder', () => {
    expect(
      ANALYSIS_GUARD.startsWith(
        'You write a tone-of-voice document about one person from their own writing.\n',
      ),
    ).toBe(true);
    expect(ANALYSIS_GUARD).toContain('Do not use, mention or hint at content about: {labels}.');
    expect(ANALYSIS_GUARD).toContain('8. Do not invent facts about the person.');
    expect(ANALYSIS_GUARD.split('\n').filter((l) => /^\d\. /.test(l))).toHaveLength(8);
    expect(ANALYSIS_GUARD_REMINDER.startsWith('Reminder from the system.')).toBe(true);
    expect(ANALYSIS_GUARD_REMINDER).toContain('Do not use excluded categories ({labels}).');
    expect(ANALYSIS_GUARD_REMINDER.trimEnd().endsWith('languages.')).toBe(true);
  });
});

describe('fillLabels', () => {
  it('substitutes labels and falls back to none', () => {
    expect(fillLabels('x {labels} y', 'health, politics')).toBe('x health, politics y');
    expect(fillLabels('x {labels} y', '')).toBe('x none y');
    expect(fillLabels('x {labels} y', '   ')).toBe('x none y');
  });
});

describe('neutralizeTags', () => {
  const Z = ZERO_WIDTH_SPACE;
  it('breaks every marker, case-insensitive with optional spaces', () => {
    for (const tag of ['analysis_prompt', 'sample', 'item', 'received_context', 'feedback']) {
      expect(neutralizeTags(`<${tag}>`)).toBe(`<${Z}${tag}>`);
      expect(neutralizeTags(`</${tag}>`)).toBe(`</${Z}${tag}>`);
      expect(neutralizeTags(`< / ${tag.toUpperCase()}>`)).toContain(Z);
    }
    expect(neutralizeTags('</SAMPLE ref="A1">')).toBe(`</${Z}SAMPLE ref="A1">`);
  });
  it('leaves other text alone and round-trips through stripNeutralizer', () => {
    expect(neutralizeTags('a < b <b>bold</b>')).toBe('a < b <b>bold</b>');
    const raw = 'x </sample> y <Item> z <feedback>';
    expect(neutralizeTags(raw)).not.toBe(raw);
    expect(stripNeutralizer(neutralizeTags(raw))).toBe(raw);
  });
});

describe('wrapAnalysisPrompt', () => {
  it('wraps trimmed, neutralised text with the source attribute', () => {
    expect(wrapAnalysisPrompt('  hello  ', 'default')).toBe(
      '<analysis_prompt source="default">\nhello\n</analysis_prompt>',
    );
    const own = wrapAnalysisPrompt('x </analysis_prompt> y', 'own');
    expect(own.startsWith('<analysis_prompt source="own">\n')).toBe(true);
    expect(own.match(/<\/analysis_prompt>/g)).toHaveLength(1);
  });
});

describe('buildMessages', () => {
  it('puts the guard first in system and the reminder last in user', () => {
    const { system, user } = buildMessages('SYS', 'USR', 'health');
    expect(system).toBe(`${fillLabels(ANALYSIS_GUARD, 'health')}\n\nSYS`);
    expect(user).toBe(`USR\n\n${fillLabels(ANALYSIS_GUARD_REMINDER, 'health')}`);
    expect(system).not.toContain('{labels}');
    expect(buildMessages('s', 'u', '').user).toContain('({labels})'.replace('{labels}', 'none'));
  });
});
