import * as React from 'react';

import type { DiffOp } from '@voicespark/core/text-diff';

import { cn } from '@/lib/utils';

function TextDiff({
  ops,
  label,
  className,
  ...props
}: { ops: DiffOp[]; label?: string } & Omit<React.ComponentProps<'div'>, 'children'>) {
  return (
    <div
      data-slot="text-diff"
      role="group"
      aria-label={label}
      className={cn('text-sm leading-relaxed break-words whitespace-pre-wrap', className)}
      {...props}
    >
      {ops.map((op, i) => {
        if (op.op === 'insert') {
          return (
            <ins
              key={i}
              aria-label="added"
              className="rounded-sm bg-green-500/20 text-foreground no-underline"
            >
              {op.value}
            </ins>
          );
        }
        if (op.op === 'delete') {
          return (
            <del
              key={i}
              aria-label="removed"
              className="rounded-sm bg-destructive/20 text-foreground line-through"
            >
              {op.value}
            </del>
          );
        }
        return <React.Fragment key={i}>{op.value}</React.Fragment>;
      })}
    </div>
  );
}

export { TextDiff };
