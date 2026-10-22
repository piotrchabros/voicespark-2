import type { ProfileBody } from '@voicespark/core/prompting/profile-schema';

export interface DimensionLabel {
  key: string;
  name: string;
}

function formatValue(v: number | string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export function ProfileBodyView({ body, labels }: { body: ProfileBody; labels: DimensionLabel[] }) {
  const nameOf = (key: string) => labels.find((l) => l.key === key)?.name ?? key;
  return (
    <div className="flex flex-col gap-6 text-sm">
      <p className="text-base">{body.summary}</p>

      <section className="flex flex-col gap-3">
        <h3 className="font-semibold">Dimensions</h3>
        <ul className="flex flex-col gap-3">
          {body.dimensions.map((d) => (
            <li key={d.key} className="flex flex-col gap-1">
              <span className="font-medium">
                {nameOf(d.key)}: <span className="break-words">{formatValue(d.value)}</span>
              </span>
              {d.explanation ? (
                <span className="text-muted-foreground">{d.explanation}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {body.excerpts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Excerpts</h3>
          <ul className="flex flex-col gap-2">
            {body.excerpts.map((x, i) => (
              <li key={`${x.sampleRef}-${i}`}>
                <blockquote className="border-l-2 pl-3 italic break-words">{x.text}</blockquote>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {body.languages.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Languages</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {body.languages.map((l) => (
              <li key={l.code}>
                {l.code} {Math.round(l.share * 100)}%
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Do</h3>
          <ul className="list-disc pl-5">
            {body.doList.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Don&apos;t</h3>
          <ul className="list-disc pl-5">
            {body.dontList.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
