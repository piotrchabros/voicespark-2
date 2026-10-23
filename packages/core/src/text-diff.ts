import { diffLines, diffWords } from 'diff';

export interface DiffOp {
  op: 'equal' | 'insert' | 'delete';
  value: string;
}

function push(out: DiffOp[], op: DiffOp['op'], value: string): void {
  if (value === '') return;
  const last = out[out.length - 1];
  if (last && last.op === op) last.value += value;
  else out.push({ op, value });
}

// Line-based diff; inside a deleted block directly followed by an inserted block the pair is
// re-diffed by words so a small edit does not mark the whole line as changed.
export function textDiff(a: string, b: string): DiffOp[] {
  const out: DiffOp[] = [];
  const parts = diffLines(a, b);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (part.removed && next?.added) {
      for (const w of diffWords(part.value, next.value)) {
        push(out, w.added ? 'insert' : w.removed ? 'delete' : 'equal', w.value);
      }
      i++;
    } else {
      push(out, part.added ? 'insert' : part.removed ? 'delete' : 'equal', part.value);
    }
  }
  return out;
}
