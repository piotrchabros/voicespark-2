// htmlparser2 builds the whole DOM before html-to-text's maxDepth applies; callers must pre-check deeper input.
export const HTML_MAX_NESTING = 1000;
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HTML_IMPLIED_END = new Set(['p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'rt', 'rp']);

const isTagNameChar = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

/** One linear pass that follows htmlparser2's nesting (end tags close down to the nearest open element of that name). */
export function exceedsHtmlNesting(html: string, max: number): boolean {
  const stack: string[] = [];
  const open = new Map<string, number>();
  let i = html.indexOf('<');
  while (i >= 0) {
    let pos = i + 1;
    if (html.startsWith('!--', pos)) {
      const end = html.indexOf('-->', pos + 3);
      i = end < 0 ? -1 : html.indexOf('<', end + 3);
      continue;
    }
    const closing = html.charCodeAt(pos) === 47;
    if (closing) pos++;
    const nameStart = pos;
    while (pos < html.length && isTagNameChar(html.charCodeAt(pos))) pos++;
    if (pos === nameStart) {
      i = html.indexOf('<', pos);
      continue;
    }
    const end = html.indexOf('>', pos);
    if (end < 0) break;
    const name = html.slice(nameStart, pos).toLowerCase();
    if (!HTML_VOID.has(name) && !HTML_IMPLIED_END.has(name)) {
      if (!closing) {
        stack.push(name);
        open.set(name, (open.get(name) ?? 0) + 1);
        if (stack.length > max) return true;
      } else if (open.get(name)) {
        let top: string | undefined;
        do {
          top = stack.pop()!;
          open.set(top, open.get(top)! - 1);
        } while (top !== name);
      }
    }
    i = html.indexOf('<', end + 1);
  }
  return false;
}

const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'hr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Linear tag strip for HTML too deeply nested for html-to-text; block tags become line breaks. */
export function stripHtmlLinear(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    let pos = lt + 1;
    if (html.startsWith('!--', pos)) {
      const end = html.indexOf('-->', pos + 3);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html.charCodeAt(pos) === 47) pos++;
    const nameStart = pos;
    while (pos < html.length && isTagNameChar(html.charCodeAt(pos))) pos++;
    if (pos === nameStart && html[pos] !== '!' && html[pos] !== '?') {
      out += '<';
      i = lt + 1;
      continue;
    }
    const end = html.indexOf('>', pos);
    if (end < 0) break;
    if (BLOCK_TAGS.has(html.slice(nameStart, pos).toLowerCase())) out += '\n';
    i = end + 1;
  }
  return out
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/[ \t\r\f\v\u00a0]+/g, ' ')
    .replace(/ ?\n[ \n]*/g, (m) => (m.split('\n').length > 2 ? '\n\n' : '\n'))
    .trim();
}
