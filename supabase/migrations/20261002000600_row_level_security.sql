-- 知序 Noltri · V1 data layer — row level security.
--
-- Knowledge Core talks to Postgres over the service-role / direct "postgres" wire connection
-- (DATABASE_URL / DIRECT_URL). That role is the table owner and bypasses RLS by design: the
-- server, not the row policy, is the authorising boundary for the capture pipeline, and every
-- repository statement still carries an explicit user_id predicate. These policies are the
-- browser-facing guard rails for anything that reaches Postgres as "anon" or "authenticated"
-- (Supabase Auth JWT -> auth.uid()), and they scope every one of the nine V1 tables.

set statement_timeout = 0;
set client_min_messages = warning;

alter table public.raw_sources enable row level security;
alter table public.knowledge_nodes enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.knowledge_edges enable row level security;
alter table public.item_node_links enable row level security;
alter table public.version_records enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.users enable row level security;

-- user_id is text while auth.uid() is uuid, so the JWT claim is compared as its text form: the
-- same value Knowledge Core persists.
create policy raw_sources_owner_write on public.raw_sources
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy knowledge_nodes_owner_write on public.knowledge_nodes
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy knowledge_items_owner_write on public.knowledge_items
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy knowledge_edges_owner_write on public.knowledge_edges
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy item_node_links_owner_write on public.item_node_links
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy version_records_owner_write on public.version_records
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

create policy conversations_owner_write on public.conversations
  as permissive for all to authenticated
  using (auth.uid() is not null and user_id = auth.uid()::text)
  with check (auth.uid() is not null and user_id = auth.uid()::text);

-- Messages carry no user_id: ownership follows the parent conversation.
create policy conversation_messages_owner_write on public.conversation_messages
  as permissive for all to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = coalesce(auth.uid()::text, '')
  ))
  with check (exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = coalesce(auth.uid()::text, '')
  ));

-- The profile row is the Auth identity itself, so it is keyed on the uuid.
create policy users_owner_read on public.users
  as permissive for select to authenticated
  using (auth.uid() is not null and id = auth.uid());

create policy users_owner_update on public.users
  as permissive for update to authenticated
  using (auth.uid() is not null and id = auth.uid())
  with check (auth.uid() is not null and id = auth.uid());
