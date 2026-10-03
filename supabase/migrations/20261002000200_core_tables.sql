-- 知序 Noltri · V1 data layer — the nine core tables (PROJECT_MASTER §9, V1_DEVELOPMENT §6.5 + §7).
-- Enum CHECK labels mirror packages/schema/src/enums.ts exactly; test/migrations.test.ts fails the
-- build if the two drift apart. Tables are declared in dependency order.

set statement_timeout = 0;
set client_min_messages = warning;

-- Embedding width follows AI_EMBEDDING_DIM (default 1536). Widening it later is a forward
-- migration: alter both columns, then rebuild the HNSW indexes in 20261002000300_indexes.sql.
-- embedding_model names the model that produced a vector, so a re-embed run can find stale rows.

-- Raw material first, always: no AI output replaces these rows (PROJECT_MASTER §2.2).
create table if not exists public.raw_sources (
  id text primary key,
  -- user_id is text, not uuid: one repository serves a Supabase auth uid, the browser's own uid and
  -- the local single-user dev identity (NOLTRI_DEV_USER_ID).
  user_id text not null,
  raw_text text not null,
  surrounding_context text,
  source_type text not null
    constraint raw_sources_source_type_enum_check
    check (source_type in ('web', 'desktop_app', 'agent', 'manual')),
  source_platform text,
  source_app text,
  source_title text,
  source_url text,
  captured_at timestamptz not null,
  metadata_json jsonb not null default '{}'::jsonb,
  processing_status text not null default 'pending'
    constraint raw_sources_processing_status_enum_check
    check (processing_status in ('pending', 'processing', 'done', 'failed')),
  error_reason text,
  created_at timestamptz not null default now()
);

-- The product's visual subject. parent_id is only the tree's main parent pointer; every other
-- relationship is an edge (PROJECT_MASTER §3.8).
create table if not exists public.knowledge_nodes (
  id text primary key,
  user_id text not null,
  title text not null,
  summary text,
  node_type text not null default 'topic',
  parent_id text,
  status text not null default 'active'
    constraint knowledge_nodes_status_enum_check
    check (status in ('active', 'archived', 'needs_review')),
  confidence double precision,
  embedding extensions.vector(1536),
  embedding_model text,
  embedding_status text not null default 'none'
    constraint knowledge_nodes_embedding_status_enum_check
    check (embedding_status in ('none', 'ready', 'failed')),
  -- V1 stores the label only: the mastery UI and the review algorithm stay in V3.
  mastery_level text not null default 'collected'
    constraint knowledge_nodes_mastery_level_enum_check
    check (mastery_level in ('collected', 'organized', 'understood', 'explainable', 'applicable', 'mastered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_nodes_title_length_check check (length(btrim(title)) between 1 and 200),
  constraint knowledge_nodes_confidence_range_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint knowledge_nodes_not_self_parent_check check (parent_id is null or parent_id <> id),
  constraint knowledge_nodes_parent_fkey foreign key (parent_id)
    references public.knowledge_nodes (id) on delete restrict
);

-- Atomic knowledge extracted from a raw source. The raw text never lives here.
create table if not exists public.knowledge_items (
  id text primary key,
  user_id text not null,
  raw_source_id text not null,
  normalized_text text not null,
  summary text,
  confidence double precision not null,
  status text not null default 'active'
    constraint knowledge_items_status_enum_check
    check (status in ('active', 'merged', 'archived')),
  is_ai_derived boolean not null default true,
  embedding extensions.vector(1536),
  embedding_model text,
  -- Persisted as a write-side fact by the repository; downstream code must not re-derive it from
  -- embedding_model or from whether embedding is null (V1_DEVELOPMENT §7.1).
  embedding_status text not null default 'none'
    constraint knowledge_items_embedding_status_enum_check
    check (embedding_status in ('none', 'ready', 'failed')),
  -- V1 only stores the attachment suggestion; V2 Merge / Inbox Engine decides.
  parent_candidate_node_id text,
  parent_confidence double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_items_confidence_range_check check (confidence >= 0 and confidence <= 1),
  constraint knowledge_items_parent_confidence_range_check
    check (parent_confidence is null or (parent_confidence >= 0 and parent_confidence <= 1)),
  constraint knowledge_items_raw_source_fkey foreign key (raw_source_id)
    references public.raw_sources (id) on delete restrict,
  constraint knowledge_items_parent_candidate_fkey foreign key (parent_candidate_node_id)
    references public.knowledge_nodes (id) on delete set null
);

-- Underneath the tree: the relation network.
create table if not exists public.knowledge_edges (
  id text primary key,
  user_id text not null,
  from_node_id text not null,
  to_node_id text not null,
  relation_type text not null
    constraint knowledge_edges_relation_type_enum_check
    check (relation_type in ('part_of', 'prerequisite_of', 'similar_to', 'contrast_with', 'causes', 'implements', 'example_of', 'supports', 'contradicts', 'derived_from')),
  confidence double precision,
  source text not null,
  created_at timestamptz not null default now(),
  constraint knowledge_edges_no_self_loop_check check (from_node_id <> to_node_id),
  constraint knowledge_edges_confidence_range_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint knowledge_edges_from_fkey foreign key (from_node_id)
    references public.knowledge_nodes (id) on delete cascade,
  constraint knowledge_edges_to_fkey foreign key (to_node_id)
    references public.knowledge_nodes (id) on delete cascade
);

-- Many-to-many between atomic knowledge and structure; the merge key is (item_id, node_id).
create table if not exists public.item_node_links (
  id text primary key,
  user_id text not null,
  item_id text not null,
  node_id text not null,
  relation_type text not null default 'primary'
    constraint item_node_links_relation_type_enum_check
    check (relation_type in ('primary', 'example_of', 'supports')),
  confidence double precision not null,
  created_at timestamptz not null default now(),
  constraint item_node_links_confidence_range_check check (confidence >= 0 and confidence <= 1),
  constraint item_node_links_item_fkey foreign key (item_id)
    references public.knowledge_items (id) on delete cascade,
  constraint item_node_links_node_fkey foreign key (node_id)
    references public.knowledge_nodes (id) on delete cascade
);

-- Every structural change stays auditable and reversible (PROJECT_MASTER §2.4).
create table if not exists public.version_records (
  id text primary key,
  user_id text not null,
  entity_type text not null
    constraint version_records_entity_type_enum_check
    check (entity_type in ('knowledge_node', 'knowledge_item', 'raw_source')),
  entity_id text not null,
  operation text not null
    constraint version_records_operation_enum_check
    check (operation in ('create', 'rename', 'move', 'reparent', 'merge', 'split', 'archive', 'restore')),
  before_json jsonb not null default '{}'::jsonb,
  after_json jsonb not null default '{}'::jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);

-- Node-scoped AI conversations.
create table if not exists public.conversations (
  id text primary key,
  user_id text not null,
  node_id text,
  scope text not null
    constraint conversations_scope_enum_check
    check (scope in ('current_node', 'section', 'tree', 'whole_library')),
  title text,
  -- Forward-compat context bookkeeping: V1 stores the rolling summary and the last token estimate
  -- so the node chat loop never has to rebuild them; the UI lands later.
  context_summary text,
  token_estimate integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_node_fkey foreign key (node_id)
    references public.knowledge_nodes (id) on delete cascade
);

create table if not exists public.conversation_messages (
  id text primary key,
  conversation_id text not null,
  role text not null
    constraint conversation_messages_role_enum_check
    check (role in ('system', 'user', 'assistant')),
  content text not null,
  -- A provenance hint, not a relationship: history keeps reading correctly after the node is
  -- archived or removed, so no foreign key is enforced here.
  context_node_id text,
  created_at timestamptz not null default now(),
  constraint conversation_messages_conversation_fkey foreign key (conversation_id)
    references public.conversations (id) on delete cascade
);
