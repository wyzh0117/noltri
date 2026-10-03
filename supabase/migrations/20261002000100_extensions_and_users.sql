-- 知序 Noltri · V1 data layer — extensions and the auth-linked profile table.
-- Forward-only: never edit a shipped migration, add a newer file instead.

set statement_timeout = 0;
set client_min_messages = warning;

-- pgvector powers semantic search, pg_trgm backs the keyword fallback.
-- Installed in "extensions" so a Supabase project and a bare Postgres both work.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Business tables key on user_id as text (see 20261002000200_core_tables.sql), so this table is a
-- projection of the Supabase Auth identity, not a second account store: no password, no token and
-- no provider credentials live here (PROJECT_MASTER §9, V1_DEVELOPMENT §7).
create table if not exists public.users (
  id uuid primary key,
  handle text,
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_handle_length_check check (handle is null or length(handle) between 1 and 120)
);

-- Mirrors a new Auth user into public.users. Guarded because auth.users only exists on Supabase.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, handle)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'handle', split_part(coalesce(new.email, ''), '@', 1)))
  on conflict (id) do nothing;
  return new;
end
$$;

do $$
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  execute 'alter table public.users add constraint users_auth_id_fkey foreign key (id) references auth.users (id) on delete cascade';
  execute 'drop trigger if exists users_auth_insert on auth.users';
  execute 'create trigger users_auth_insert after insert on auth.users for each row execute function public.handle_new_user()';
end
$$;
