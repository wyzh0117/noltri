-- 知序 Noltri · V1 P3 — a capture gets an idempotency key the database can enforce.
--
-- Forward-only: adds two nullable columns, one CHECK and one partial unique index. Rows written before
-- P3 keep a null key and stay out of the index, so an upgrade cannot fail on history and cannot invent a
-- key for a capture that never stated one.

set statement_timeout = 0;
set client_min_messages = warning;

alter table public.raw_sources add column if not exists request_id text;
alter table public.raw_sources add column if not exists client_id text;

-- The key is the pair (client_id, request_id). A request id without the client that issued it would let
-- two entry points replay into each other, so a half-stated key is rejected where it is written.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.raw_sources'::regclass
      and conname = 'raw_sources_idempotency_pair_check'
  ) then
    return;
  end if;
  execute 'alter table public.raw_sources add constraint raw_sources_idempotency_pair_check check (request_id is null or client_id is not null)';
end
$$;

-- Postgres treats NULLs in a unique index as distinct, so the partial predicate is what keeps the
-- unkeyed historical rows from colliding with each other.
create unique index if not exists raw_sources_idempotency_uq
  on public.raw_sources (user_id, client_id, request_id)
  where request_id is not null;
