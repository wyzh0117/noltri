import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotesEditor } from '../src/workbench/NotesEditor';
import { NoteBodyPresentation } from '../src/workbench/NoteBodyPresentation';
import type { SourceJumpRequest } from '../src/workbench/NotesEditor';
import '../src/workbench/notes-workbench.css';

const query = new URLSearchParams(window.location.search);
const isEmptyFixture = query.has('empty');
const isLongFixture = query.has('long');
const useCodeMirror = query.has('editor');
const initialContent = isEmptyFixture ? '' : isLongFixture
  ? ['# 长笔记', ...Array.from({ length: 300 }, (_, index) => `## 章节 ${index}\n正文内容 ${index}`)].join('\n')
  : ['# 研究笔记', '开篇说明：同一份原文在两种视图中展示。', '## 采样', '保留未经修改的段落。', '### 误差', '重复标题用来源位置定位。', '## 采样', '第二个同名标题仍能单独定位。', '```md', '## 代码里的标题不是层级', '```', '结尾。'].join('\n');
let nextEditorInstance = 0;

function HarnessTextView({ content, onChange, jumpToSource, onCursorChange }: {
  content: string;
  onChange: (value: string) => void;
  jumpToSource: SourceJumpRequest | null;
  onCursorChange: (offset: number) => void;
}) {
  const [instance] = useState(() => ++nextEditorInstance);
  const mode = useCodeMirror ? 'source' : null;
  return <div className="harness-editor-wrap" data-testid="text-instance" data-instance={instance}>
    {mode !== null ? <NotesEditor value={content} mode="source" sourcePath="Synthetic.md" onChange={onChange} onOpenLink={() => undefined} onCursorChange={onCursorChange} jumpToSource={jumpToSource} />
      : <textarea className="harness-textarea" aria-label="合成笔记文本" value={content} onChange={(event) => onChange(event.target.value)} />}
  </div>;
}

function Harness() {
  const [content, setContent] = useState(initialContent);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [jumpToSource, setJumpToSource] = useState<SourceJumpRequest | null>(null);
  const [apiCalls, setApiCalls] = useState(0);
  const originalContent = useMemo(() => initialContent, []);
  const textView = <HarnessTextView content={content} onChange={setContent} jumpToSource={jumpToSource} onCursorChange={setCursorOffset} />;

  useEffect(() => {
    (window as any).__mindmapHarness = {
      getContent: () => content,
      getOriginalContent: () => originalContent,
      getCursorOffset: () => cursorOffset,
      getApiCalls: () => apiCalls,
    };
  }, [apiCalls, content, cursorOffset, originalContent]);

  return <NoteBodyPresentation content={content} path="Synthetic.md" textView={textView} onLocate={(sourceOffset) => {
    if (useCodeMirror) setJumpToSource((current) => ({ requestId: (current?.requestId ?? 0) + 1, sourceOffset }));
    setCursorOffset(sourceOffset);
  }}>{({ toggleButton, viewport, isMindmap }) => <main className="harness">
    <header className="harness-toolbar"><strong>合成笔记演示</strong>{toggleButton}</header>
    <div className="harness-status"><span data-testid="current-view">{isMindmap ? 'mindmap' : 'text'}</span><span data-testid="cursor-offset">{cursorOffset}</span><span data-testid="source-unchanged">{content === originalContent ? 'unchanged' : 'changed'}</span><span data-testid="api-calls">{apiCalls}</span></div>
    <section className="harness-workspace">{viewport}</section>
    <button type="button" onClick={() => setApiCalls((value) => value + 1)}>synthetic API counter</button>
  </main>}</NoteBodyPresentation>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
