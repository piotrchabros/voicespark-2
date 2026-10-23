'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react';
import { labelFor, type CountCategory } from '@voicespark/filters/categories';
import { hubExtensions } from '@voicespark/core/hub/content-schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { plural, readHubError, type HubKind, type HubNoteItem } from './labels';

// Limits and the link rule mirror packages/core/src/hub/content-schema.ts; the server stays authoritative.
const TITLE_MAX = 300;
const HREF_RE = /^(https?|mailto):/i;
const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

interface ToolDef {
  label: string;
  short: ReactNode;
  run: (e: Editor) => void;
  active?: (e: Editor) => boolean;
}

const TOOLS: ToolDef[] = [
  ...([1, 2, 3] as const).map((level) => ({
    label: `Heading ${level}`,
    short: `H${level}`,
    run: (e: Editor) => e.chain().focus().toggleHeading({ level }).run(),
    active: (e: Editor) => e.isActive('heading', { level }),
  })),
  { label: 'Bold', short: <b>B</b>, run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { label: 'Italic', short: <i>I</i>, run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  {
    label: 'Underline',
    short: <u>U</u>,
    run: (e) => e.chain().focus().toggleUnderline().run(),
    active: (e) => e.isActive('underline'),
  },
  {
    label: 'Strikethrough',
    short: <s>S</s>,
    run: (e) => e.chain().focus().toggleStrike().run(),
    active: (e) => e.isActive('strike'),
  },
  { label: 'Inline code', short: '`c`', run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive('code') },
  {
    label: 'Bullet list',
    short: '• List',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    active: (e) => e.isActive('bulletList'),
  },
  {
    label: 'Numbered list',
    short: '1. List',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    active: (e) => e.isActive('orderedList'),
  },
  {
    label: 'Checklist',
    short: '☑ List',
    run: (e) => e.chain().focus().toggleTaskList().run(),
    active: (e) => e.isActive('taskList'),
  },
  {
    label: 'Quote',
    short: '“ ”',
    run: (e) => e.chain().focus().toggleBlockquote().run(),
    active: (e) => e.isActive('blockquote'),
  },
  {
    label: 'Code block',
    short: '{ }',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
    active: (e) => e.isActive('codeBlock'),
  },
  { label: 'Divider', short: '―', run: (e) => e.chain().focus().setHorizontalRule().run() },
];

function Toolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => [...TOOLS.map((t) => t.active?.(e) ?? false), e.isActive('link')],
  });
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1">
      {TOOLS.map((t, i) => (
        <Button
          key={t.label}
          type="button"
          size="sm"
          variant={active[i] ? 'secondary' : 'ghost'}
          aria-label={t.label}
          aria-pressed={t.active ? active[i] : undefined}
          title={t.label}
          onClick={() => t.run(editor)}
        >
          {t.short}
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant={active[TOOLS.length] ? 'secondary' : 'ghost'}
        aria-label="Link"
        aria-pressed={active[TOOLS.length]}
        title="Link"
        onClick={onLink}
      >
        Link
      </Button>
    </div>
  );
}

/**
 * FR-008: rich-text note on a record (Tiptap with the shared `hubExtensions`, so the editor can only produce what the
 * server validator accepts). Creates a note, or replaces the title and body of `note`. Shows the excluded-value count
 * of the saved note and the category of a wholly excluded one (`note_excluded`, FR-028).
 */
export function NoteEditor({
  kind,
  recordId,
  note,
  onSaved,
  onCancel,
}: {
  kind: HubKind;
  recordId: string;
  note?: HubNoteItem;
  onSaved: (note: HubNoteItem) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const editor = useEditor({
    extensions: hubExtensions,
    content: (note?.body as JSONContent | undefined) ?? EMPTY_DOC,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'hub-note min-h-32 rounded-md border px-3 py-2',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Note text',
      },
    },
  });

  function openLink() {
    if (!editor) return;
    setHref((editor.getAttributes('link').href as string | undefined) ?? '');
    setLinkError(null);
    setLinkOpen(true);
  }

  function applyLink() {
    if (!editor) return;
    const value = href.trim();
    if (!HREF_RE.test(value)) {
      setLinkError('Only http, https and mailto links are allowed.');
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href: value } }] }).run();
    } else {
      chain.extendMarkRange('link').setLink({ href: value }).run();
    }
    setLinkOpen(false);
    setHref('');
  }

  function clearLink() {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
    setHref('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!editor) return;
    if (title.length > TITLE_MAX) {
      setError(`Title must be at most ${TITLE_MAX} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(note ? `/api/hub/notes/${note.id}` : `/api/hub/${kind}/${recordId}/notes`, {
        method: note ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, body: editor.getJSON() }),
      });
      if (!res.ok) {
        const failure = await readHubError(res);
        const category = failure.details.category;
        setError(
          failure.code === 'note_excluded' && category
            ? `${failure.message} Excluded: ${labelFor(category as CountCategory)}.`
            : failure.message,
        );
        return;
      }
      const data = (await res.json()) as { note: HubNoteItem };
      onSaved(data.note);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`note-title-${note?.id ?? 'new'}`}>Title</Label>
        <Input
          id={`note-title-${note?.id ?? 'new'}`}
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {note && note.redactedValues > 0 ? (
        <p className="text-sm text-muted-foreground">
          {plural(note.redactedValues, 'value')} excluded from this note when it was saved.
        </p>
      ) : null}
      {editor ? <Toolbar editor={editor} onLink={openLink} /> : null}
      {linkOpen ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="note-link-href">Link address</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="note-link-href"
              value={href}
              placeholder="https://"
              className="max-w-sm"
              aria-invalid={linkError ? true : undefined}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                }
              }}
            />
            <Button type="button" size="sm" onClick={applyLink}>
              Apply link
            </Button>
            {editor?.isActive('link') ? (
              <Button type="button" size="sm" variant="outline" onClick={clearLink}>
                Clear link
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>
              Close
            </Button>
          </div>
          {linkError ? (
            <p role="alert" className="text-sm text-destructive">
              {linkError}
            </p>
          ) : null}
        </div>
      ) : null}
      <EditorContent editor={editor} />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !editor}>
          {note ? 'Update note' : 'Add note'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
