import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as placeholderExt } from '@codemirror/view';
import { useEffect, useRef } from 'preact/hooks';

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', fontSize: 'var(--vscode-editor-font-size)' },
  '.cm-content': { fontFamily: 'var(--vscode-editor-font-family)', padding: '8px 0', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
});

/** Plain code editor (monospace, line numbers, Tab indents) used by `code` fields. */
export function CodeEditor(props: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    const v = new EditorView({
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          lineNumbers(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          theme,
          placeholderExt(props.placeholder ?? ''),
          EditorView.updateListener.of((u) => u.docChanged && onChange.current(u.state.doc.toString())),
          EditorView.contentAttributes.of({ spellcheck: 'false' }),
        ],
      }),
      parent: host.current!,
    });
    v.dom.style.minHeight = `${(props.rows ?? 6) * 1.5 + 1}em`;
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === props.value) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return <div class="md-editor code-editor" ref={host} />;
}
