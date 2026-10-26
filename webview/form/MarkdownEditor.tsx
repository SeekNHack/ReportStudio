import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'preact/hooks';
import { fileToBase64, request } from '../shared/vscode';
import type { Placeholders } from './types';

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700', color: 'var(--vscode-textLink-foreground)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--vscode-textLink-foreground)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--vscode-textLink-activeForeground)' },
  { tag: t.monospace, color: 'var(--vscode-textPreformat-foreground)', fontFamily: 'var(--vscode-editor-font-family)' },
  { tag: t.quote, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--vscode-descriptionForeground)' },
  { tag: t.list, color: 'var(--vscode-textLink-foreground)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', fontSize: 'var(--vscode-editor-font-size)' },
  '.cm-content': { fontFamily: 'var(--vscode-editor-font-family)', padding: '10px 0', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-line': { padding: '0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-tooltip': { backgroundColor: 'var(--vscode-editorSuggestWidget-background)', border: '1px solid var(--vscode-editorSuggestWidget-border)', color: 'var(--vscode-editorSuggestWidget-foreground)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)', color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)' },
  '.cm-completionDetail': { opacity: '0.7', marginLeft: '8px' },
});

function placeholderCompletions(ph: Placeholders) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 80), ctx.pos);
    const open = before.lastIndexOf('{{');
    if (open < 0 || before.lastIndexOf('}}') > open) return null;
    const m = /(\w+)\.(\w*)$/.exec(before);
    if (m) {
      const isItem = m[1] === ph.itemVar || m[1] === 'item';
      const list =
        m[1] === 'report'
          ? ph.report
          : isItem
            ? ph.finding
            : m[1] === 'collections'
              ? ph.collections.map((id) => ({ id, label: id, type: 'collection' }))
              : m[1] === 'stats'
                ? ph.stats.map((id) => ({ id, label: id, type: 'stat' }))
                : [];
      if (!list.length) return null;
      return { from: ctx.pos - m[2].length, options: list.map((f) => ({ label: f.id, detail: f.label !== f.id ? f.label : f.type, type: 'property' })) };
    }
    const w = /(\w*)$/.exec(before)!;
    return {
      from: ctx.pos - w[1].length,
      options: ['report', ph.itemVar, 'collections', 'stats', 'now'].map((label) => ({ label, type: 'variable' })),
    };
  };
}

export interface MarkdownEditorApi {
  wrap(before: string, after?: string, placeholder?: string): void;
  insertBlock(text: string): void;
  focus(): void;
}

async function saveImageFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const res = await request<{ path: string }>({ type: 'saveImage', name: f.name || `image.${f.type.split('/')[1] ?? 'png'}`, data: await fileToBase64(f) });
    paths.push(res.path);
  }
  return paths;
}

export function MarkdownEditor(props: {
  value: string;
  onChange: (v: string) => void;
  placeholders: Placeholders;
  placeholder?: string;
  rows?: number;
  apiRef?: { current: MarkdownEditorApi | null };
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;

  useEffect(() => {
    const insertImages = (v: EditorView, files: File[], pos?: number) => {
      void saveImageFiles(files).then((paths) => {
        if (!paths.length) return;
        const text = paths.map((p) => `![Screenshot](${p})`).join('\n\n');
        const at = pos ?? v.state.selection.main.from;
        v.dispatch({ changes: { from: at, insert: `\n${text}\n` }, selection: EditorSelection.cursor(at + text.length + 2) });
      });
    };
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, { key: 'Mod-b', run: (v) => (wrapIn(v, '**', '**', 'bold'), true) }, { key: 'Mod-i', run: (v) => (wrapIn(v, '_', '_', 'italic'), true) }]),
      markdown(),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      theme,
      autocompletion({ override: [placeholderCompletions(props.placeholders)], icons: false }),
      placeholderExt(props.placeholder ?? 'Markdown — paste or drop screenshots, type {{ for placeholders'),
      EditorView.updateListener.of((u) => u.docChanged && onChange.current(u.state.doc.toString())),
      EditorView.domEventHandlers({
        paste(e, v) {
          const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return false;
          e.preventDefault();
          insertImages(v, files);
          return true;
        },
        drop(e, v) {
          const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return false;
          e.preventDefault();
          insertImages(v, files, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined);
          return true;
        },
      }),
      EditorView.contentAttributes.of({ spellcheck: 'true' }),
    ];
    const v = new EditorView({ state: EditorState.create({ doc: props.value, extensions }), parent: host.current! });
    v.dom.style.minHeight = `${(props.rows ?? 5) * 1.6 + 1.4}em`;
    view.current = v;
    if (props.apiRef)
      props.apiRef.current = {
        wrap: (b, a = b, ph = 'text') => wrapIn(v, b, a, ph),
        insertBlock: (text) => {
          const { from } = v.state.selection.main;
          const line = v.state.doc.lineAt(from);
          const prefix = line.text.trim() ? '\n\n' : '';
          v.dispatch({ changes: { from: line.to, insert: `${prefix}${text}\n` }, selection: EditorSelection.cursor(line.to + prefix.length + text.length) });
          v.focus();
        },
        focus: () => v.focus(),
      };
    return () => v.destroy();
  }, []);

  // External changes (text editor, undo in VS Code) update the editor in place.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current.replace(/\s+$/, '') === props.value.replace(/\s+$/, '')) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return <div class="md-editor" ref={host} />;
}

function wrapIn(v: EditorView, before: string, after: string, ph: string): void {
  const r = v.state.selection.main;
  const selected = v.state.sliceDoc(r.from, r.to) || ph;
  v.dispatch({
    changes: { from: r.from, to: r.to, insert: `${before}${selected}${after}` },
    selection: EditorSelection.range(r.from + before.length, r.from + before.length + selected.length),
  });
  v.focus();
}

export { saveImageFiles };
