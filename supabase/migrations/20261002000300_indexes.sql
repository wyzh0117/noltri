-- 知序 Noltri · V1 data layer — indexes for the access patterns Knowledge Core actually uses.

set statement_timeout = 0;
set client_min_messages = warning;

-- Every table is read behind a user_id predicate.
create index if not exists raw_sources_user_idx on public.raw_sources (user_id);
create index if not exists raw_sources_user_captured_idx on public.raw_sources (user_id, captured_at desc);
create index if not exists knowledge_items_user_idx on public.knowledge_items (user_id);
create index if not exists knowledge_items_user_status_idx on public.knowledge_items (user_id, status);
create index if not exists knowledge_items_source_idx on public.knowledge_items (raw_source_id);
create index if not exists knowledge_nodes_user_idx on public.knowledge_nodes (user_id);
-- Tree rendering: roots and one level of children.
create index if not exists knowledge_nodes_user_parent_idx on public.knowledge_nodes (user_id, parent_id);
create index if not exists knowledge_edges_user_idx on public.knowledge_edges (user_id);
create index if not exists knowledge_edges_user_from_idx on public.knowledge_edges (user_id, from_node_id);
create index if not exists knowledge_edges_user_to_idx on public.knowledge_edges (user_id, to_node_id);
create index if not exists item_node_links_user_idx on public.item_node_links (user_id);
create index if not exists item_node_links_node_idx on public.item_node_links (node_id);
create index if not exists item_node_links_item_idx on public.item_node_links (item_id);
create index if not exists version_records_user_created_idx on public.version_records (user_id, created_at desc);
create index if not exists version_records_user_entity_idx on public.version_records (user_id, entity_id, created_at desc);
create index if not exists conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index if not exists conversations_user_node_idx on public.conversations (user_id, node_id);
create index if not exists conversation_messages_conversation_idx
  on public.conversation_messages (conversation_id, created_at);

-- (item, node) is the merge key of linkItemToNode: one row per pair, highest confidence wins.
-- Partial so a future soft-deleted link can opt out of the key without dropping the index.
create unique index if not exists item_node_links_pair_uq
  on public.item_node_links (item_id, node_id)
  where user_id is not null;

-- One edge per (user, from, to, relation): createEdge is an upsert.
create unique index if not exists knowledge_edges_pair_uq
  on public.knowledge_edges (user_id, from_node_id, to_node_id, relation_type);

-- Title lookup is case-folded; the index is expression-level so findNodeByTitle stays cheap.
create index if not exists knowledge_nodes_user_title_idx on public.knowledge_nodes (user_id, lower(title));

-- Keyword search: trigram handles substring and CJK retrieval, GIN handles provenance filters.
create index if not exists raw_sources_text_trgm_idx
  on public.raw_sources using gin (raw_text extensions.gin_trgm_ops);
create index if not exists knowledge_items_text_trgm_idx
  on public.knowledge_items using gin (normalized_text extensions.gin_trgm_ops);
create index if not exists knowledge_nodes_title_trgm_idx
  on public.knowledge_nodes using gin (title extensions.gin_trgm_ops);
create index if not exists raw_sources_metadata_idx on public.raw_sources (metadata_json);

-- Approximate nearest neighbour on cosine distance. Rows with a NULL embedding are simply not
-- indexed; match_* still filters them explicitly.
create index if not exists knowledge_items_embedding_hnsw_idx
  on public.knowledge_items using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists knowledge_nodes_embedding_hnsw_idx
  on public.knowledge_nodes using hnsw (embedding extensions.vector_cosine_ops);

-- A re-embed job selects on embedding_status, not on whether the vector happens to be null.
create index if not exists knowledge_items_embedding_status_idx
  on public.knowledge_items (embedding_status)
  where embedding_status <> 'ready';
create index if not exists knowledge_nodes_embedding_status_idx
  on public.knowledge_nodes (embedding_status)
  where embedding_status <> 'ready';
