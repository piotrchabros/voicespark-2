import { describe, expect, it } from 'vitest';
import { textDiff, type DiffOp } from '../src/text-diff';

const side = (ops: DiffOp[], drop: 'insert' | 'delete') =>
  ops
    .filter((o) => o.op !== drop)
    .map((o) => o.value)
    .join('');

describe('textDiff', () => {
  it('returns no ops for two empty strings', () => {
    expect(textDiff('', '')).toEqual([]);
  });

  it('returns a single equal op for identical text', () => {
    expect(textDiff('a\nb\n', 'a\nb\n')).toEqual([{ op: 'equal', value: 'a\nb\n' }]);
  });

  it('marks everything as insert or delete against empty text', () => {
    expect(textDiff('', 'new\n')).toEqual([{ op: 'insert', value: 'new\n' }]);
    expect(textDiff('old\n', '')).toEqual([{ op: 'delete', value: 'old\n' }]);
  });

  it('keeps whole unchanged lines as equal and added lines as insert', () => {
    const ops = textDiff('one\ntwo\n', 'one\ntwo\nthree\n');
    expect(ops).toEqual([
      { op: 'equal', value: 'one\ntwo\n' },
      { op: 'insert', value: 'three\n' },
    ]);
  });

  it('diffs words inside a changed line pair', () => {
    const ops = textDiff('Write in a warm tone.\n', 'Write in a direct tone.\n');
    expect(ops.some((o) => o.op === 'delete' && o.value.includes('warm'))).toBe(true);
    expect(ops.some((o) => o.op === 'insert' && o.value.includes('direct'))).toBe(true);
    const equal = ops
      .filter((o) => o.op === 'equal')
      .map((o) => o.value)
      .join('');
    expect(equal).toContain('Write in a');
    expect(equal).toContain('tone.');
  });

  it('merges adjacent ops of the same kind', () => {
    const ops = textDiff('a b c\nx\n', 'a B C\ny\n');
    for (let i = 1; i < ops.length; i++) expect(ops[i]!.op).not.toBe(ops[i - 1]!.op);
  });

  it('reconstructs both inputs from the ops', () => {
    const a = 'Intro line\nUse short sentences.\nAvoid jargon\n\nEnd';
    const b = 'Intro line\nUse long, flowing sentences.\nAvoid all jargon\nNew line\n\nEnd!';
    const ops = textDiff(a, b);
    expect(side(ops, 'insert')).toBe(a);
    expect(side(ops, 'delete')).toBe(b);
  });

  it('diffs two 20,000-character texts in under 100 ms', () => {
    const line = (i: number) => `Line ${i}: describe the writing voice in plain words.\n`;
    const build = (changed: boolean) => {
      let s = '';
      for (let i = 0; s.length < 20_000; i++) {
        s +=
          changed && i % 5 === 0
            ? `Line ${i}: describe the speaking voice in vivid words.\n`
            : line(i);
      }
      return s.slice(0, 20_000);
    };
    const a = build(false);
    const b = build(true);
    expect(a.length).toBe(20_000);
    expect(b.length).toBe(20_000);
    // Warm up (JIT), then take the median of several runs so a one-off load spike does not fail CI.
    const ops = textDiff(a, b);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      textDiff(a, b);
      runs.push(performance.now() - start);
    }
    runs.sort((x, y) => x - y);
    expect(runs[2]!).toBeLessThan(100);
    expect(side(ops, 'insert')).toBe(a);
    expect(side(ops, 'delete')).toBe(b);
  });
});
