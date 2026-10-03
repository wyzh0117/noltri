-- 知序 Noltri · Research V1 data layer — indexes and row level security for the research tables.
-- Same rules as the knowledge tables (20261002000300 / 20261002000600): every read runs behind a
-- user_id predicate, and the browser-facing policies guard anything arriving as "authenticated".

set statement_timeout = 0;
set client_min_messages = warning;

-- Project list is user-scoped and ordered by age; charter lookups are one per project.
create index if not exists research_projects_user_created_idx
  on public.research_projects (user_id, created_at);
create index if not exists research_charters_user_idx on public.research_charters (user_id);

-- Project lists are user + project scoped and read in created_at order.
create index if not exists research_questions_user_project_idx
  on public.research_questions (user_id, project_id, created_at);
create index if not exists evidence_user_project_idx on public.evidence (user_id, project_id, created_at);
create index if not exists claims_user_project_idx on public.claims (user_id, project_id, created_at);
create index if not exists manuscript_sections_user_project_idx
  on public.manuscript_sections (user_id, project_id, created_at);
create index if not exists research_decisions_user_project_idx
  on public.research_decisions (user_id, project_id, created_at);
create index if not exists research_changes_user_project_idx
  on public.research_changes (user_id, project_id, created_at);

-- Filtered list variants (evidence ?type=, claims ?status=&claimType=, changes ?changeType=).
create index if not exists evidence_user_project_type_idx on public.evidence (user_id, project_id, type);
create index if not exists claims_user_project_status_idx on public.claims (user_id, project_id, status);
create index if not exists claims_user_project_claim_type_idx on public.claims (user_id, project_id, claim_type);
create index if not exists research_changes_user_project_change_type_idx
  on public.research_changes (user_id, project_id, change_type, created_at);

-- Relations are filtered from either end of the five-tuple (research map, drift checker).
create index if not exists entity_relations_user_project_idx
  on public.entity_relations (user_id, project_id, created_at);
create index if not exists entity_relations_source_idx
  on public.entity_relations (project_id, source_type, source_id);
create index if not exists entity_relations_target_idx
  on public.entity_relations (project_id, target_type, target_id);

-- The five-tuple is the merge key of createEntityRelation: one row per link, repeat creates return
-- the existing row. Partial so a future soft-deleted link can opt out of the key (same idea as
-- item_node_links_pair_uq).
create unique index if not exists entity_relations_tuple_uq
  on public.entity_relations (user_id, project_id, source_type, source_id, relation_type, target_type, target_id)
  where user_id is not null;

-- Drift checker reads open findings by tuple before it drafts new ones (contract §4 de-duplication).
create index if not exists drift_findings_user_project_idx
  on public.drift_findings (user_id, project_id, created_at);
create index if not exists drift_findings_user_project_status_idx
  on public.drift_findings (user_id, project_id, status);
create index if not exists drift_findings_open_tuple_idx
  on public.drift_findings (project_id, drift_type, source_entity_id, target_entity_id)
  where status = 'open';

-- Timeline reads newest-first per project (research doc §20).
create index if not exists timeline_events_user_project_occurred_idx
  on public.timeline_events (user_id, project_id, occurred_at desc);

-- Row level security: same guard rails as the knowledge tables, one owner-scoped policy per table.
alter table public.research_projects enable row level security;
alter table public.research_charters enable row level security;
alter table public.research_questions enable row level security;
alter table public.evidence enable row level security;
alter table public.claims enable row level security;
alter table public.manuscript_sections enable row level security;
alter table public.entity_relations enable row level security;
alter table public.research_decisions enable row level security;
alter table public.research_changes enable row level security;
alter table public.drift_findings enable row level security;
alter table public.timeline_events enable row level security;

-- user_id is text while auth.uid() is uuid, so the JWT claim is compared as its text form.
create policy research_projects_owner_write on public.research_projects
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy research_charters_owner_write on public.research_charters
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy research_questions_owner_write on public.research_questions
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy evidence_owner_write on public.evidence
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy claims_owner_write on public.claims
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy manuscript_sections_owner_write on public.manuscript_sections
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy entity_relations_owner_write on public.entity_relations
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy research_decisions_owner_write on public.research_decisions
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy research_changes_owner_write on public.research_changes
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy drift_findings_owner_write on public.drift_findings
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy timeline_events_owner_write on public.timeline_events
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);
