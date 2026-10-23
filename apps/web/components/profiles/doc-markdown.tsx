import React, { type ReactNode } from 'react';

// Safe renderer for the Markdown subset in contracts/analysis-prompt.md: paragraphs, flat `-` and
// `1.` lists, **bold**, *italic* and `###` headings. Everything else stays literal text.
// Output is React elements only, so React escapes all content.

const INLINE = /\*\*(?!\s)(.+?)(?<!\s)\*\*|\*(?!\s)(.+?)(?<!\s)\*/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[1], key)}</strong>);
    } else {
      out.push(<em key={key}>{m[2]}</em>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const HEADING = /^### +(\S.*)$/;
const BULLET = /^- +(\S.*)$/;
const NUMBERED = /^\d+\. +(\S.*)$/;

export function renderDocMarkdown(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const key = `b${blocks.length}`;
    blocks.push(
      <p key={key} className="break-words whitespace-pre-line">
        {renderInline(para.join('\n'), key)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const key = `b${blocks.length}`;
    const items = list.items.map((t, i) => <li key={i}>{renderInline(t, `${key}-${i}`)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={key} className="list-decimal pl-5 break-words">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc pl-5 break-words">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const key = `b${blocks.length}`;
      blocks.push(
        <h3 key={key} className="font-semibold break-words">
          {renderInline(heading[1]!, key)}
        </h3>,
      );
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export function DocMarkdown({ markdown }: { markdown: string }) {
  return <div className="flex flex-col gap-3 text-sm">{renderDocMarkdown(markdown)}</div>;
}
