-- 知序 Noltri · V1 data layer — keyword search that serves Latin and CJK from one call.

set statement_timeout = 0;
set client_min_messages = warning;

set search_path = extensions, public, pg_catalog;

-- The 'simple' text search config only splits on whitespace and punctuation and never stems, so a
-- Chinese run such as "Python 装饰器原理" becomes ONE lexeme ("装饰器原理") and a lookup for
-- "装饰器" cannot match it; CJK therefore falls back to ILIKE substring probes built by the caller
-- (tokenize() in @noltri/shared already emits CJK bigrams).
-- p_patterns are LIKE patterns already escaped and lower-casing is done on both sides here; the
-- score is a coarse matched-token ratio and Knowledge Core re-ranks it with the shared tokenizer.
create or replace function public.search_knowledge(
  p_user_id text,
  p_query text,
  p_patterns text[] default '{}'::text[],
  p_retrieval_limit integer default 60
)
returns table (
  item_id text,
  node_id text,
  title text,
  content text,
  score double precision
)
language sql
stable
set search_path = extensions, public, pg_catalog
as $$
  (
    select
      k.id,
      (
        select l.node_id
        from public.item_node_links l
        where l.item_id = k.id and l.user_id = k.user_id
        order by l.confidence desc, l.created_at asc, l.id asc
        limit 1
      ),
      coalesce(k.summary, left(k.normalized_text, 40)),
      k.normalized_text,
      coalesce(
        (select count(*) from unnest(p_patterns) as p(pat) where k.normalized_text ilike p.pat)::double precision
          / nullif(cardinality(p_patterns), 0)::double precision,
        0::double precision
      )
    from public.knowledge_items k
    where k.user_id = p_user_id
      and k.status = 'active'
      and (
        to_tsvector('simple', coalesce(k.summary, '') || ' ' || k.normalized_text)
          @@ websearch_to_tsquery('simple', coalesce(p_query, ''))
        or exists (
          select 1 from unnest(p_patterns) as p(pat)
          where k.normalized_text ilike p.pat or coalesce(k.summary, '') ilike p.pat
        )
      )
    order by 5 desc, 1 asc
    limit p_retrieval_limit
  )
  union all
  (
    select
      null::text,
      n.id,
      n.title,
      coalesce(n.summary, ''),
      coalesce(
        (select count(*) from unnest(p_patterns) as p(pat)
           where n.title ilike p.pat or coalesce(n.summary, '') ilike p.pat)::double precision
          / nullif(cardinality(p_patterns), 0)::double precision,
        0::double precision
      )
    from public.knowledge_nodes n
    where n.user_id = p_user_id
      and n.status <> 'archived'
      and (
        to_tsvector('simple', n.title || ' ' || coalesce(n.summary, ''))
          @@ websearch_to_tsquery('simple', coalesce(p_query, ''))
        or exists (
          select 1 from unnest(p_patterns) as p(pat)
          where n.title ilike p.pat or coalesce(n.summary, '') ilike p.pat
        )
      )
    order by 5 desc, 2 asc
    limit p_retrieval_limit
  );
$$;
