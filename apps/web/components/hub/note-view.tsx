'use client';

import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { hubExtensions } from '@voicespark/core/hub/content-schema';

// FR-008: a stored note rendered through the same schema as the editor, read-only. ProseMirror builds the DOM from
// the validated JSON; the note is never inserted as HTML.
export function NoteView({ body }: { body: JSONContent }) {
  const editor = useEditor({
    extensions: hubExtensions,
    content: body,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'hub-note' } },
  });
  return <EditorContent editor={editor} />;
}
