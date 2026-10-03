-- 知序 Noltri · Research V1 data layer — the eleven research tables (research doc §9–§20, §27).
-- Enum CHECK labels mirror packages/schema/src/research.ts exactly; test/migrations.test.ts fails the
-- build if the two drift apart. Research is additive: no existing table is touched (research doc §29).
-- Tables are declared in dependency order; every research row hangs off research_projects.

set statement_timeout = 0;
set client_min_messages = warning;

-- Research Project = the common layer's Project extended with the research domain (research doc §9).
create table if not exists public.research_projects (
  id text primary key,
  user_id text not null,
  name text not null,
  description text,
  status text not null default 'active'
    constraint research_projects_status_enum_check
    check (status in ('active', 'archived', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_projects_name_length_check check (length(btrim(name)) between 1 and 200)
);

-- One charter per project: the highest-level constraint of the paper (research doc §10). The unique
-- key on project_id is what makes upsertCharter a create-or-update rather than a stack of drafts.
create table if not exists public.research_charters (
  id text primary key,
  project_id text not null,
  user_id text not null,
  working_title text not null,
  research_topic text,
  research_problem text,
  research_gap text,
  research_questions_text text,
  core_contribution text,
  theoretical_lens text,
  research_context text,
  unit_of_analysis text,
  research_method text,
  target_article_type text,
  target_journal text,
  research_boundary text,
  claim_boundary text,
  current_stage text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_charters_working_title_length_check
    check (length(btrim(working_title)) between 1 and 300),
  constraint research_charters_project_unique unique (project_id),
  constraint research_charters_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Research Question is an entity of its own, never just a paragraph of the charter (research doc §13).
create table if not exists public.research_questions (
  id text primary key,
  project_id text not null,
  user_id text not null,
  question_code text not null,
  question_text text not null,
  status text not null default 'open'
    constraint research_questions_status_enum_check
    check (status in ('open', 'answered', 'revised', 'dropped')),
  rationale text,
  related_method text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_questions_code_length_check check (length(btrim(question_code)) between 1 and 50),
  constraint research_questions_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Evidence stores why a source matters to this research, not a full bibliography (research doc §14).
create table if not exists public.evidence (
  id text primary key,
  project_id text not null,
  user_id text not null,
  type text not null
    constraint evidence_type_enum_check
    check (type in ('literature', 'dataset', 'analysis_result', 'figure', 'table', 'interview',
                    'expert_judgement', 'document', 'note', 'external_source', 'other')),
  title text not null,
  description text,
  source_reference text,
  source_location text,
  reliability_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Claim = a verifiable scholarly statement the paper plans to make (research doc §15).
create table if not exists public.claims (
  id text primary key,
  project_id text not null,
  user_id text not null,
  claim_code text not null,
  claim_text text not null,
  claim_type text not null
    constraint claims_claim_type_enum_check
    check (claim_type in ('descriptive', 'empirical', 'methodological', 'interpretive', 'theoretical',
                          'contribution', 'limitation')),
  status text not null default 'draft'
    constraint claims_status_enum_check
    check (status in ('draft', 'proposed', 'confirmed', 'revised', 'dropped')),
  confidence double precision not null default 0,
  boundary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claims_code_length_check check (length(btrim(claim_code)) between 1 and 50),
  constraint claims_confidence_range_check check (confidence >= 0 and confidence <= 1),
  constraint claims_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- V1 keeps section slots only — no editor: name + reference + order (research doc §17).
create table if not exists public.manuscript_sections (
  id text primary key,
  project_id text not null,
  user_id text not null,
  section_name text not null,
  section_reference text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manuscript_sections_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- One generic relation table for evidence↔claim, claim↔rq, claim↔section, … (research doc §27).
-- source/target are polymorphic (type + id), so they deliberately carry no foreign keys.
create table if not exists public.entity_relations (
  id text primary key,
  project_id text not null,
  user_id text not null,
  source_type text not null
    constraint entity_relations_source_type_enum_check
    check (source_type in ('research_project', 'research_charter', 'research_question', 'evidence', 'claim',
                           'research_decision', 'research_change', 'drift_finding', 'manuscript_section')),
  source_id text not null,
  relation_type text not null
    constraint entity_relations_relation_type_enum_check
    check (relation_type in ('supports', 'partially_supports', 'contradicts', 'qualifies', 'contextualizes',
                             'answers', 'appears_in', 'changes', 'affects', 'relates_to')),
  target_type text not null
    constraint entity_relations_target_type_enum_check
    check (target_type in ('research_project', 'research_charter', 'research_question', 'evidence', 'claim',
                           'research_decision', 'research_change', 'drift_finding', 'manuscript_section')),
  target_id text not null,
  note text,
  created_at timestamptz not null default now(),
  constraint entity_relations_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Decisions are append-only history (research doc §18): there is no update or delete path, later
-- changes are recorded as ResearchChange rows instead of rewriting what was decided.
create table if not exists public.research_decisions (
  id text primary key,
  project_id text not null,
  user_id text not null,
  title text not null,
  decision text not null,
  reason text,
  alternatives text,
  rejected_alternatives text,
  impact text,
  related_entities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint research_decisions_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Changes are append-only history as well (research doc §19).
create table if not exists public.research_changes (
  id text primary key,
  project_id text not null,
  user_id text not null,
  change_type text not null
    constraint research_changes_change_type_enum_check
    check (change_type in ('research_question', 'method', 'scope', 'claim', 'contribution', 'journal',
                           'structure', 'evidence', 'other')),
  before text not null,
  after text not null,
  reason text,
  impact text,
  related_entities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint research_changes_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Drift findings are written by the deterministic checker and triaged by the researcher (research
-- doc §23); source/target stay polymorphic like entity_relations.
create table if not exists public.drift_findings (
  id text primary key,
  project_id text not null,
  user_id text not null,
  drift_type text not null
    constraint drift_findings_drift_type_enum_check
    check (drift_type in ('rq_drift', 'contribution_drift', 'evidence_drift', 'causality_drift', 'method_drift',
                          'journal_drift')),
  severity text not null
    constraint drift_findings_severity_enum_check
    check (severity in ('info', 'warning', 'critical')),
  description text not null,
  source_entity_type text
    constraint drift_findings_source_entity_type_enum_check
    check (source_entity_type in ('research_project', 'research_charter', 'research_question', 'evidence', 'claim',
                                  'research_decision', 'research_change', 'drift_finding', 'manuscript_section')),
  source_entity_id text,
  target_entity_type text
    constraint drift_findings_target_entity_type_enum_check
    check (target_entity_type in ('research_project', 'research_charter', 'research_question', 'evidence', 'claim',
                                  'research_decision', 'research_change', 'drift_finding', 'manuscript_section')),
  target_entity_id text,
  reason text,
  recommended_action text,
  status text not null default 'open'
    constraint drift_findings_status_enum_check
    check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drift_findings_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);

-- Timeline events for decisions + changes + manual milestones (research doc §20). source_type /
-- source_id point back at the object that produced the event; polymorphic, so no foreign key.
create table if not exists public.timeline_events (
  id text primary key,
  project_id text not null,
  user_id text not null,
  event_type text not null
    constraint timeline_events_event_type_enum_check
    check (event_type in ('decision', 'change', 'milestone')),
  occurred_at timestamptz not null,
  title text not null,
  summary text,
  source_type text
    constraint timeline_events_source_type_enum_check
    check (source_type in ('research_decision', 'research_change', 'manual')),
  source_id text,
  related_entities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint timeline_events_project_fkey foreign key (project_id)
    references public.research_projects (id) on delete cascade
);
