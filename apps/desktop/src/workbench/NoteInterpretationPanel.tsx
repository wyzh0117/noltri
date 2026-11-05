import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { WorkbenchApi } from './api';
import './NoteInterpretationPanel.css';

type InterpretationMode = 'translation' | 'explanation' | 'question';
interface InterpretationResult {
  mode: InterpretationMode;
  question?: string;
  sourceText: string;
  text: string;
  path: string;
  model?: string;
}

export interface NoteInterpretationPanelProps {
  api: Pick<WorkbenchApi, 'interpretNote'>;
  content: string;
  path: string;
  onReturnToSource: () => void;
  onUpdateSafetyChange?: (safe: boolean) => void;
}

const MAX_SOURCE_CHARS = 20_000;
const MAX_QUESTION_CHARS = 2_000;
const MODE_LABEL: Record<InterpretationMode, string> = {
  translation: '简体中文译文',
  explanation: '通俗解释',
  question: '原文问答',
};

export function NoteInterpretationPanel({ api, content, path, onReturnToSource, onUpdateSafetyChange }: NoteInterpretationPanelProps): ReactElement {
  const [question, setQuestion] = useState('');
  const [questionSubmitted, setQuestionSubmitted] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState<InterpretationMode | null>(null);
  const [result, setResult] = useState<InterpretationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const activeRequestId = useRef<number | null>(null);
  const activeMode = useRef<InterpretationMode | null>(null);
  const latestQuestion = useRef(question);
  latestQuestion.current = question;
  const latestSource = useRef({ content, path });
  latestSource.current = { content, path };

  useEffect(() => {
    requestId.current += 1;
    activeRequestId.current = null;
    activeMode.current = null;
    setBusy(null);
    setResult(null);
    setError(null);
    setQuestionSubmitted(false);
  }, [content, path]);
  useEffect(() => () => { requestId.current += 1; activeRequestId.current = null; activeMode.current = null; }, []);

  const empty = content.trim() === '';
  const tooLong = content.length > MAX_SOURCE_CHARS;
  const disabled = busy !== null || empty || tooLong;
  const updateSafe = busy === null && pendingCount === 0 && (question === '' || questionSubmitted);
  useEffect(() => { onUpdateSafetyChange?.(updateSafe); }, [onUpdateSafetyChange, updateSafe]);
  useEffect(() => () => { onUpdateSafetyChange?.(true); }, [onUpdateSafetyChange]);

  function changeQuestion(value: string): void {
    latestQuestion.current = value;
    setQuestion(value);
    setQuestionSubmitted(false);
    if (activeMode.current === 'question') {
      requestId.current += 1;
      activeRequestId.current = null;
      activeMode.current = null;
      setBusy(null);
    }
    setResult((previous) => previous?.mode === 'question' ? null : previous);
    setError(null);
  }

  async function interpret(mode: InterpretationMode): Promise<void> {
    const submittedQuestion = mode === 'question' ? question : undefined;
    if (disabled || activeRequestId.current !== null || (mode === 'question' && (submittedQuestion!.trim() === '' || submittedQuestion!.length > MAX_QUESTION_CHARS))) return;
    const snapshot = content;
    const sourcePath = path;
    const id = ++requestId.current;
    activeRequestId.current = id;
    activeMode.current = mode;
    const isCurrent = () => requestId.current === id && latestSource.current.content === snapshot && latestSource.current.path === sourcePath && (mode !== 'question' || latestQuestion.current === submittedQuestion);
    setBusy(mode);
    setPendingCount((count) => count + 1);
    setError(null);
    setResult(null);
    try {
      const response = await api.interpretNote({ mode, sourceText: snapshot, ...(mode === 'translation' ? { targetLanguage: '简体中文' } : {}), ...(mode === 'question' ? { question: submittedQuestion! } : {}) });
      if (!isCurrent()) return;
      if (mode === 'question') setQuestionSubmitted(true);
      setResult({ mode, ...(submittedQuestion === undefined ? {} : { question: submittedQuestion }), sourceText: snapshot, path: sourcePath, text: response.text, ...(response.model === undefined ? {} : { model: response.model }) });
    } catch (cause) {
      if (activeRequestId.current === id && isCurrent()) {
        setError(cause instanceof Error && cause.message.trim() !== '' ? cause.message : '解读请求失败。');
      }
    } finally {
      // Invalidated requests still protect app updates until their actual promise settles.
      setPendingCount((count) => count - 1);
      if (activeRequestId.current === id) {
        activeRequestId.current = null;
        activeMode.current = null;
        if (isCurrent()) setBusy(null);
      }
    }
  }

  return <section className="vault-interpretation-panel" aria-label="笔记解读" aria-busy={busy !== null}>
    <p className="vault-interpretation-disclosure">点击后会把当前笔记正文发送给已配置的模型；原文不会被修改，结果只在当前界面暂存。</p>
    <div className="vault-interpretation-actions">
      <button type="button" disabled={disabled} onClick={() => void interpret('translation')}>翻译为简体中文</button>
      <button type="button" disabled={disabled} onClick={() => void interpret('explanation')}>通俗解释</button>
    </div>
    <label className="vault-interpretation-question">基于当前原文提问
      <textarea aria-label="原文问题" value={question} maxLength={MAX_QUESTION_CHARS} rows={3} onChange={(event) => changeQuestion(event.target.value)} />
    </label>
    <button type="button" disabled={disabled || question.trim() === '' || question.length > MAX_QUESTION_CHARS} onClick={() => void interpret('question')}>根据原文回答</button>
    {question.length > MAX_QUESTION_CHARS ? <p role="alert">问题超过 2,000 字符上限。</p> : null}
    {empty ? <p role="status">当前笔记没有正文。</p> : null}
    {tooLong ? <p role="alert">原文超过 20,000 字符上限；请缩短后再解读。</p> : null}
    {busy !== null ? <p role="status">正在生成{MODE_LABEL[busy]}…</p> : null}
    {error !== null ? <p role="alert">{error}</p> : null}
    {result !== null && result.sourceText === content && result.path === path && (result.mode !== 'question' || result.question === question) ? <div className="vault-interpretation-result" aria-label="解读结果">
      <header><strong>{MODE_LABEL[result.mode]}</strong>{result.model ? <small>{result.model}</small> : null}</header>
      {result.mode === 'question' ? <p>本次问题：{result.question}</p> : null}
      <pre>{result.text}</pre>
      <details><summary>本次原文快照：{result.path}</summary><pre>{result.sourceText}</pre></details>
      <div className="vault-interpretation-result-actions">
        <button type="button" aria-label="返回当前原文并保留位置" onClick={onReturnToSource}>返回原文</button>
        <button type="button" onClick={() => setResult(null)}>清除结果</button>
      </div>
    </div> : null}
  </section>;
}
