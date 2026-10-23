// Browser-safe: no Node-only imports and no DOM. The web editor imports `hubExtensions` too, so
// server validation and the editor share one schema (Tiptap 3.31.4).
import { getSchema, type Extensions } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';

export type HubNodeType =
  | 'paragraph' | 'heading' | 'text' | 'bulletList' | 'orderedList' | 'listItem'
  | 'taskList' | 'taskItem' | 'hardBreak' | 'horizontalRule' | 'blockquote' | 'codeBlock';

export type HubMarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';

export interface HubNode {
  type: HubNodeType;
  attrs?: { level?: 1 | 2 | 3; checked?: boolean; href?: string };
  content?: HubNode[];
  text?: string;
  marks?: { type: HubMarkType; attrs?: { href?: string } }[];
}

export interface HubNoteDoc {
  type: 'doc';
  content: HubNode[];
}

export const HUB_NOTE_MAX_BYTES = 1_048_576;
export const HUB_NOTE_MAX_TEXT_CHARS = 100_000;
const HREF_RE = /^(https?|mailto):/i;

const NODE_TYPES: ReadonlySet<string> = new Set<HubNodeType>([
  'paragraph', 'heading', 'text', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'hardBreak', 'horizontalRule', 'blockquote', 'codeBlock',
]);
const MARK_TYPES: ReadonlySet<string> = new Set<HubMarkType>(['bold', 'italic', 'underline', 'strike', 'code', 'link']);

/** The one extension set: the editor and the server validator must not drift apart. */
export const hubExtensions: Extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { protocols: ['http', 'https', 'mailto'], autolink: true, openOnClick: false },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
];

let schemaCache: ReturnType<typeof getSchema> | undefined;
const schema = () => (schemaCache ??= getSchema(hubExtensions));

export type NoteValidation = { ok: true; doc: HubNoteDoc } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Allowlist walk: node and mark types, heading level, link hrefs, text size. */
function walk(node: unknown, state: { chars: number }): string | null {
  if (!isObj(node)) return 'node_not_object';
  const type = node.type;
  if (typeof type !== 'string' || !NODE_TYPES.has(type)) return `unknown_node:${String(type)}`;
  if (type === 'heading') {
    const level = isObj(node.attrs) ? node.attrs.level : undefined;
    if (level !== 1 && level !== 2 && level !== 3) return 'bad_heading_level';
  }
  if (type === 'text') {
    if (typeof node.text !== 'string') return 'text_missing';
    state.chars += node.text.length;
    if (state.chars > HUB_NOTE_MAX_TEXT_CHARS) return 'too_many_chars';
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return 'marks_not_array';
    for (const m of node.marks) {
      if (!isObj(m) || typeof m.type !== 'string' || !MARK_TYPES.has(m.type)) return `unknown_mark:${isObj(m) ? String(m.type) : '?'}`;
      if (m.type === 'link') {
        const href = isObj(m.attrs) ? m.attrs.href : undefined;
        if (typeof href !== 'string' || !HREF_RE.test(href)) return 'bad_href';
      }
    }
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return 'content_not_array';
    for (const c of node.content) {
      const err = walk(c, state);
      if (err) return err;
    }
  }
  return null;
}

export function validateNoteDoc(json: unknown): NoteValidation {
  if (!isObj(json) || json.type !== 'doc' || !Array.isArray(json.content)) return { ok: false, reason: 'not_a_doc' };
  let serialised: string;
  try {
    serialised = JSON.stringify(json);
  } catch {
    return { ok: false, reason: 'not_serialisable' };
  }
  if (serialised.length > HUB_NOTE_MAX_BYTES || new TextEncoder().encode(serialised).length > HUB_NOTE_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  const state = { chars: 0 };
  for (const child of json.content) {
    const err = walk(child, state);
    if (err) return { ok: false, reason: err };
  }
  try {
    PMNode.fromJSON(schema(), json).check();
  } catch {
    return { ok: false, reason: 'schema_mismatch' };
  }
  return { ok: true, doc: json as unknown as HubNoteDoc };
}

export interface NoteSegment {
  kind: 'text' | 'href';
  value: string;
}

/** Text nodes and link hrefs in document order; an href follows the text it belongs to. */
export function noteTextSegments(doc: HubNoteDoc): NoteSegment[] {
  const out: NoteSegment[] = [];
  const visit = (n: HubNode) => {
    if (n.type === 'text' && typeof n.text === 'string') {
      out.push({ kind: 'text', value: n.text });
      for (const m of n.marks ?? []) if (m.type === 'link' && typeof m.attrs?.href === 'string') out.push({ kind: 'href', value: m.attrs.href });
    }
    for (const c of n.content ?? []) visit(c);
  };
  for (const c of doc.content) visit(c);
  return out;
}

/** Puts `values` (one per `noteTextSegments` entry, same order) back into a copy of `doc`. */
export function rebuildNoteDoc(doc: HubNoteDoc, values: readonly (string | NoteSegment)[]): HubNoteDoc {
  const copy = structuredClone(doc);
  let i = 0;
  const next = () => {
    if (i >= values.length) throw new Error('rebuildNoteDoc: too few segments');
    const v = values[i++]!;
    return typeof v === 'string' ? v : v.value;
  };
  const visit = (n: HubNode) => {
    if (n.type === 'text' && typeof n.text === 'string') {
      n.text = next();
      for (const m of n.marks ?? []) if (m.type === 'link' && typeof m.attrs?.href === 'string') m.attrs.href = next();
    }
    for (const c of n.content ?? []) visit(c);
  };
  for (const c of copy.content) visit(c);
  if (i !== values.length) throw new Error('rebuildNoteDoc: too many segments');
  return copy;
}

type Fmt = 'text' | 'md';

function inline(n: HubNode, fmt: Fmt): string {
  if (n.type === 'hardBreak') return '\n';
  if (n.type !== 'text') return (n.content ?? []).map((c) => inline(c, fmt)).join('');
  let s = n.text ?? '';
  if (fmt === 'md') {
    for (const m of n.marks ?? []) {
      if (m.type === 'code') s = `\`${s}\``;
      else if (m.type === 'bold') s = `**${s}**`;
      else if (m.type === 'italic') s = `*${s}*`;
      else if (m.type === 'strike') s = `~~${s}~~`;
      else if (m.type === 'link' && m.attrs?.href) s = `[${s}](${m.attrs.href})`;
    }
  }
  return s;
}

function indent(s: string, pad: string): string {
  return s.split('\n').map((l, i) => (i === 0 || l === '' ? l : pad + l)).join('\n');
}

function block(n: HubNode, fmt: Fmt): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case 'paragraph':
      return inline(n, fmt);
    case 'heading':
      return fmt === 'md' ? `${'#'.repeat(n.attrs?.level ?? 1)} ${inline(n, fmt)}` : inline(n, fmt);
    case 'bulletList':
    case 'orderedList':
      return kids.map((li, i) => `${n.type === 'orderedList' ? `${i + 1}.` : '-'} ${indent(blocks(li.content ?? [], fmt), '  ')}`).join('\n');
    case 'taskList':
      return kids.map((ti) => `- [${ti.attrs?.checked ? 'x' : ' '}] ${indent(blocks(ti.content ?? [], fmt), '  ')}`).join('\n');
    case 'blockquote':
      return blocks(kids, fmt).split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': {
      const code = kids.map((c) => c.text ?? '').join('');
      return fmt === 'md' ? `\`\`\`\n${code}\n\`\`\`` : code;
    }
    case 'horizontalRule':
      return fmt === 'md' ? '---' : '';
    default:
      return blocks(kids, fmt);
  }
}

function blocks(nodes: HubNode[], fmt: Fmt): string {
  return nodes.map((n) => block(n, fmt)).join('\n\n');
}

/** Plain text for search, memory and drafts. Tasks render as `- [ ]` / `- [x]`. */
export function noteToPlainText(doc: HubNoteDoc): string {
  return blocks(doc.content, 'text').trim();
}

export function noteToMarkdown(doc: HubNoteDoc): string {
  return blocks(doc.content, 'md').trim();
}
