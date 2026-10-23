import type { Dimension } from '@voicespark/db';
import { Badge } from '@/components/ui/badge';

// Read-only view of the dimensions on legacy definition versions (R18). New versions carry an analysis prompt
// instead; dimensions can no longer be edited.

export function DimensionList({ dimensions }: { dimensions: Dimension[] }) {
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {dimensions.map((d) => (
        <li key={d.key} className="flex flex-col gap-1 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.name}</span>
            <code className="text-muted-foreground">{d.key}</code>
            <Badge variant="outline">{d.valueType}</Badge>
          </div>
          <p>{d.description}</p>
          {d.scale ? (
            <p className="text-muted-foreground">
              {d.scale.min} ({d.scale.minLabel || 'min'}) to {d.scale.max} (
              {d.scale.maxLabel || 'max'})
            </p>
          ) : null}
          {d.allowedValues && d.allowedValues.length > 0 ? (
            <p className="text-muted-foreground">Allowed: {d.allowedValues.join(', ')}</p>
          ) : null}
          {d.guidance ? <p className="text-muted-foreground">Guidance: {d.guidance}</p> : null}
        </li>
      ))}
    </ul>
  );
}
