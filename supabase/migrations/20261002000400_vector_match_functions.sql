-- 知序 Noltri · V1 data layer — cosine similarity search over pgvector.
-- Similarity is always 1 - (embedding <=> query), i.e. cosine similarity in 0..1, the same
-- convention as cosineSimilarity() in @noltri/shared and InMemoryRepository.

set statement_timeout = 0;
set client_min_messages = warning;

-- The operator class and the <=> operator live in "extensions", so it must be on the search path
-- both while these bodies are parsed and while they run.
set search_path = extensions, public, pg_catalog;

create or replace function public.match_knowledge_items(
  p_user_id text,
  p_query_embedding extensions.vector,
  p_match_threshold double precision default 0,
  p_match_count integer default 8,
  p_exclude_raw_source text default null,
  p_status_exclude text[] default null
)
returns table (
  item_id text,
  raw_source_id text,
  node_id text,
  normalized_text text,
  summary text,
  embedding_model text,
  similarity double precision
)
language sql
stable
set search_path = extensions, public, pg_catalog
as $$
  select
    k.id,
    k.raw_source_id,
    (
      select l.node_id
      from public.item_node_links l
      where l.item_id = k.id and l.user_id = k.user_id
      order by l.confidence desc, l.created_at asc, l.id asc
      limit 1
    ),
    k.normalized_text,
    k.summary,
    k.embedding_model,
    greatest(0::double precision, least(1::double precision, 1::double precision - (k.embedding <=> p_query_embedding)))
  from public.knowledge_items k
  where k.user_id = p_user_id
    and k.embedding is not null
    and k.status <> 'archived'
    and (p_exclude_raw_source is null or k.raw_source_id <> p_exclude_raw_source)
    and (
      p_status_exclude is null
      or not exists (
        select 1 from public.raw_sources r
        where r.id = k.raw_source_id and r.processing_status = any (p_status_exclude)
      )
    )
    and 1::double precision - (k.embedding <=> p_query_embedding) >= p_match_threshold
  order by k.embedding <=> p_query_embedding
  limit p_match_count;
$$;

create or replace function public.match_knowledge_nodes(
  p_user_id text,
  p_query_embedding extensions.vector,
  p_match_threshold double precision default 0,
  p_match_count integer default 8
)
returns table (
  node_id text,
  title text,
  summary text,
  embedding_model text,
  similarity double precision
)
language sql
stable
set search_path = extensions, public, pg_catalog
as $$
  select
    n.id,
    n.title,
    n.summary,
    n.embedding_model,
    greatest(0::double precision, least(1::double precision, 1::double precision - (n.embedding <=> p_query_embedding)))
  from public.knowledge_nodes n
  where n.user_id = p_user_id
    and n.embedding is not null
    and n.status <> 'archived'
    and 1::double precision - (n.embedding <=> p_query_embedding) >= p_match_threshold
  order by n.embedding <=> p_query_embedding
  limit p_match_count;
$$;
