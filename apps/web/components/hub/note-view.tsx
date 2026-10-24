import type { ReactNode } from 'react';
import type { JSONContent } from '@tiptap/react';

// FR-008: a stored note rendered read-only from its validated JSON (the same node and mark set as the editor schema,
// content-schema.ts). React builds the elements; the note is never inserted as HTML. No editor instance is mounted
// per note, so a record with 100 notes opens on one screen within SC-002; the editor only mounts while editing.

const HREF_RE = /^(https?|mailto):/i;

function withMarks(text: ReactNode, marks: JSONContent['marks'], key: number): ReactNode {
  let out = text;
  for (const m of marks ?? []) {
    switch (m.type) {
      case 'bold':
        out = <strong>{out}</strong>;
        break;
      case 'italic':
        out = <em>{out}</em>;
        break;
      case 'underline':
        out = <u>{out}</u>;
        break;
      case 'strike':
        out = <s>{out}</s>;
        break;
      case 'code':
        out = <code>{out}</code>;
        break;
      case 'link': {
        const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
        if (HREF_RE.test(href)) {
          out = (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {out}
            </a>
          );
        }
        break;
      }
      default:
        break;
    }
  }
  return <span key={key}>{out}</span>;
}

function children(node: JSONContent): ReactNode {
  return (node.content ?? []).map((c, i) => renderNode(c, i));
}

function renderNode(node: JSONContent, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return withMarks(node.text ?? '', node.marks, key);
    case 'paragraph':
      return <p key={key}>{children(node)}</p>;
    case 'heading': {
      const level = node.attrs?.level;
      if (level === 1) return <h1 key={key}>{children(node)}</h1>;
      if (level === 2) return <h2 key={key}>{children(node)}</h2>;
      return <h3 key={key}>{children(node)}</h3>;
    }
    case 'bulletList':
      return <ul key={key}>{children(node)}</ul>;
    case 'orderedList':
      return <ol key={key}>{children(node)}</ol>;
    case 'listItem':
      return <li key={key}>{children(node)}</li>;
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {children(node)}
        </ul>
      );
    case 'taskItem': {
      const checked = node.attrs?.checked === true;
      return (
        <li key={key} data-type="taskItem" data-checked={checked}>
          <label>
            <input type="checkbox" checked={checked} disabled readOnly />
          </label>
          <div>{children(node)}</div>
        </li>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{children(node)}</blockquote>;
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{(node.content ?? []).map((c) => c.text ?? '').join('')}</code>
        </pre>
      );
    case 'hardBreak':
      return <br key={key} />;
    case 'horizontalRule':
      return <hr key={key} />;
    default:
      return null;
  }
}

export function NoteView({ body }: { body: JSONContent }) {
  return <div className="hub-note">{children(body)}</div>;
}
