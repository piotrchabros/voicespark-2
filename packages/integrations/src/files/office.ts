import { unzipSync } from 'fflate';

export type OfficeExtractResult = { text: string } | { failure: 'corrupt' | 'empty' | 'unsupported_type' };

const PART_MAX_BYTES = 64 * 1024 * 1024;
const ODF_EXTENSIONS = new Set(['odt', 'ods', 'odp']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Collects the inner text of every `<tag>` element, with nested markup stripped. `tag` is a regex source for the qualified name.
function collect(xml: string, tag: string): string[] {
  const re = new RegExp(`<(${tag})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const inner = m[2]!.replace(/<text:(?:tab|line-break)\s*\/>/g, ' ').replace(/<text:s\b[^>]*\/>/g, ' ').replace(/<[^>]+>/g, '');
    const t = decodeEntities(inner).trim();
    if (t) out.push(t);
  }
  return out;
}

const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function wantedParts(ext: string): ((name: string) => boolean) | null {
  if (ext === 'xlsx') return (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(n);
  if (ext === 'pptx') return (n) => /^ppt\/slides\/[^/]+\.xml$/.test(n);
  if (ODF_EXTENSIONS.has(ext)) return (n) => n === 'content.xml';
  return null;
}

// Text of xlsx (shared + inline strings), pptx (`a:t`) and ODF (`text:p`/`text:h`). Docx goes through mammoth, not here.
export async function extractOoxmlOdf(bytes: Uint8Array, extension: string): Promise<OfficeExtractResult> {
  const ext = extension.toLowerCase();
  const wanted = wantedParts(ext);
  if (!wanted) return { failure: 'unsupported_type' };

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => wanted(f.name) && f.originalSize <= PART_MAX_BYTES });
  } catch {
    return { failure: 'corrupt' };
  }
  const names = Object.keys(files).sort((a, b) => slideNumber(a) - slideNumber(b) || a.localeCompare(b));
  if (names.length === 0) return { failure: 'corrupt' };

  const parts: string[] = [];
  for (const name of names) {
    const xml = decode(files[name]!);
    if (ext === 'xlsx') parts.push(...collect(xml, '(?:\\w+:)?t'));
    else if (ext === 'pptx') parts.push(...collect(xml, 'a:t'));
    else parts.push(...collect(xml, 'text:p|text:h'));
  }
  const text = parts.join('\n').trim();
  return text ? { text } : { failure: 'empty' };
}
