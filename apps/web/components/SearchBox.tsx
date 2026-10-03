'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { SearchHit, SearchResponse } from '@noltri/schema';
import { apiPost, describeError } from '@/lib/client-api';
import { matchedByLabels } from '@/lib/labels';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

export interface SearchBoxProps {
  onPickNode: (nodeId: string) => void;
}

/** Search is a top-bar field, not a menu item: results open nodes in the existing detail panel. */
export default function SearchBox({ onPickNode }: SearchBoxProps): ReactElement {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setHits(null);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      void run(query.trim());
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  async function run(term: string): Promise<void> {
    setSearching(true);
    try {
      const response = await apiPost<SearchResponse>('/api/web/search', { query: term, limit: 12 });
      setHits(response.hits);
      setError(null);
      setOpen(true);
    } catch (failure) {
      setHits(null);
      setError(describeError(failure));
      setOpen(true);
    } finally {
      setSearching(false);
    }
  }

  function pick(hit: SearchHit): void {
    if (hit.nodeId === null) return;
    onPickNode(hit.nodeId);
    setOpen(false);
  }

  return (
    <div className="search">
      <input
        className="search-input"
        type="search"
        value={query}
        placeholder="搜索知识：语义 + 关键词"
        aria-label="搜索知识"
        aria-expanded={open}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Enter' && query.trim().length >= MIN_QUERY_LENGTH) {
            if (timer.current) clearTimeout(timer.current);
            void run(query.trim());
          }
        }}
      />
      {open ? (
        <div className="search-results" role="dialog" aria-label="搜索结果">
          <div className="search-head">
            <span>{searching ? '正在搜索…' : `${hits?.length ?? 0} 条结果`}</span>
            <span className="muted-note">点击结果打开节点</span>
          </div>
          {error !== null ? <p className="error-note">{error}</p> : null}
          {hits !== null && hits.length === 0 ? <p className="muted-note">没有匹配的知识条目。</p> : null}
          <ul>
            {(hits ?? []).map((hit) => (
              <li key={`${hit.itemId ?? 'node'}-${hit.nodeId ?? hit.title}`}>
                <button type="button" className="hit" onClick={() => pick(hit)} onMouseDown={(event) => event.preventDefault()}>
                  <span className="hit-top">
                    <span className="hit-title">{hit.title}</span>
                    <span className="badge badge-accent">{matchedByLabels[hit.matchedBy]}</span>
                  </span>
                  <span className="hit-text">{hit.text}</span>
                  <span className="hit-score">相关度 {hit.score.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
