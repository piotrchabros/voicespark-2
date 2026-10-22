import type { DocumentHeader, FilteredText, InspectionResult } from './categories';
import { asFiltered } from './internal/brand';

function formatFrom(name?: FilteredText, address?: FilteredText): string | undefined {
  if (name !== undefined && address !== undefined) return `${name} <${address}>`;
  return name ?? address;
}

/**
 * The only producer of a Supermemory document (contracts/supermemory.md "Document"). Header
 * values come from the inspected `fields` the caller passes in (typed `FilteredText`); lines
 * whose value is undefined are omitted. `From:` shows the display name alone when the address
 * was dropped (third_party_contacts selected).
 */
export function buildDocument(result: InspectionResult, header: DocumentHeader): FilteredText {
  if (result.outcome !== 'accepted' || result.text === undefined) {
    throw new Error('buildDocument requires an accepted InspectionResult');
  }
  const lines: string[] = [];
  switch (header.kind) {
    case 'email':
    case 'attachment': {
      if (header.subject !== undefined) lines.push(`Subject: ${header.subject}`);
      lines.push(`Date: ${header.date}`);
      if (header.direction !== undefined) lines.push(`Direction: ${header.direction}`);
      const from = formatFrom(header.fromName, header.fromAddress);
      if (from !== undefined) lines.push(`From: ${from}`);
      break;
    }
    case 'file':
      if (header.filename !== undefined) lines.push(`Title: ${header.filename}`);
      break;
    case 'note':
      if (header.title !== undefined) lines.push(`Title: ${header.title}`);
      break;
  }
  const head = lines.join('\n');
  return asFiltered(head ? `${head}\n\n${result.text}` : result.text);
}
