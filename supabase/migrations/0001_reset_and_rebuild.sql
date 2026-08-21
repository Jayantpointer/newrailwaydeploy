drop view if exists public.call_summary cascade;
drop view if exists public.caller_summary cascade;

drop table if exists public.memory_chunks cascade;
drop table if exists public.call_events cascade;
drop table if exists public.call_turns cascade;
drop table if exists public.call_sessions cascade;
drop table if exists public.callers cascade;
drop table if exists public.agent_settings cascade;

create extension if not exists pgcrypto with schema extensions;

create table public.agent_settings (
  id smallint primary key default 1,
  owner_id uuid references auth.users (id) on delete cascade,
  agent_name text not null default 'calling agent',
  system_prompt text not null default 'You are a warm, human-sounding phone assistant. Follow the live human conversation style guide: preserve context, respond to the caller''s actual meaning, vary short turn lengths, use statements as well as questions, and never repeat a generic apology.',
  anthropic_model text not null default 'meta-llama/llama-3.3-70b-instruct',
  sarvam_voice_id text not null default '',
  sarvam_language text not null default 'auto',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.callers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  full_name text,
  phone_e164 text not null,
  email text,
  preferred_language text not null default 'en',
  symptoms text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint callers_owner_phone_unique unique (owner_id, phone_e164)
);

create table public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  caller_id uuid references public.callers (id) on delete set null,
  provider_name text not null default 'twilio',
  provider_call_id text,
  provider_session_id text,
  direction text not null default 'outbound' check (direction in ('inbound', 'outbound')),
  status text not null default 'queued' check (status in ('queued', 'ringing', 'live', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  last_activity_at timestamptz,
  summary text,
  transcript text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_sessions_provider_call_unique unique (provider_name, provider_call_id)
);

create table public.call_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.call_sessions (id) on delete cascade,
  owner_id uuid references auth.users (id) on delete cascade,
  caller_id uuid references public.callers (id) on delete set null,
  role text not null check (role in ('system', 'user', 'assistant', 'tool')),
  content text not null,
  audio_url text,
  tool_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.call_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.call_sessions (id) on delete cascade,
  owner_id uuid references auth.users (id) on delete cascade,
  caller_id uuid references public.callers (id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.memory_chunks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users (id) on delete cascade,
  caller_id uuid references public.callers (id) on delete set null,
  session_id uuid not null references public.call_sessions (id) on delete cascade,
  chunk_type text not null default 'call_memory' check (chunk_type in ('call_memory', 'caller_profile', 'follow_up', 'preference', 'task')),
  content text not null,
  source_text text,
  facts jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}'::text[],
  language text not null default 'en',
  symptoms text[] not null default '{}'::text[],
  importance smallint not null default 50 check (importance between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.sync_call_row_context()
returns trigger
language plpgsql
as $$
declare
  session_owner uuid;
  session_caller uuid;
begin
  select owner_id, caller_id
  into session_owner, session_caller
  from public.call_sessions
  where id = new.session_id;

  new.owner_id := coalesce(new.owner_id, session_owner);
  new.caller_id := coalesce(new.caller_id, session_caller);

  return new;
end;
$$;

drop trigger if exists agent_settings_set_updated_at on public.agent_settings;
create trigger agent_settings_set_updated_at
before update on public.agent_settings
for each row execute function public.set_updated_at();

drop trigger if exists callers_set_updated_at on public.callers;
create trigger callers_set_updated_at
before update on public.callers
for each row execute function public.set_updated_at();

drop trigger if exists call_sessions_set_updated_at on public.call_sessions;
create trigger call_sessions_set_updated_at
before update on public.call_sessions
for each row execute function public.set_updated_at();

drop trigger if exists memory_chunks_set_updated_at on public.memory_chunks;
create trigger memory_chunks_set_updated_at
before update on public.memory_chunks
for each row execute function public.set_updated_at();

drop trigger if exists call_turns_sync_context on public.call_turns;
create trigger call_turns_sync_context
before insert or update on public.call_turns
for each row execute function public.sync_call_row_context();

drop trigger if exists call_events_sync_context on public.call_events;
create trigger call_events_sync_context
before insert or update on public.call_events
for each row execute function public.sync_call_row_context();

create index callers_owner_id_idx on public.callers (owner_id);
create index callers_phone_idx on public.callers (phone_e164);
create index call_sessions_owner_id_idx on public.call_sessions (owner_id);
create index call_sessions_caller_id_idx on public.call_sessions (caller_id);
create index call_sessions_status_idx on public.call_sessions (status);
create index call_turns_session_id_idx on public.call_turns (session_id);
create index call_turns_owner_id_idx on public.call_turns (owner_id);
create index call_turns_caller_id_idx on public.call_turns (caller_id);
create index call_events_session_id_idx on public.call_events (session_id);
create index call_events_owner_id_idx on public.call_events (owner_id);
create index call_events_caller_id_idx on public.call_events (caller_id);
create index memory_chunks_owner_id_idx on public.memory_chunks (owner_id);
create index memory_chunks_caller_id_idx on public.memory_chunks (caller_id);
create index memory_chunks_session_id_idx on public.memory_chunks (session_id);
create index memory_chunks_chunk_type_idx on public.memory_chunks (chunk_type);

alter table public.agent_settings enable row level security;
alter table public.callers enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_turns enable row level security;
alter table public.call_events enable row level security;
alter table public.memory_chunks enable row level security;

create policy agent_settings_read
on public.agent_settings
for select
to authenticated
using (owner_id is null or owner_id = auth.uid());

create policy agent_settings_manage
on public.agent_settings
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy callers_read
on public.callers
for select
to authenticated
using (owner_id = auth.uid());

create policy callers_insert
on public.callers
for insert
to authenticated
with check (owner_id = auth.uid());

create policy callers_update
on public.callers
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy callers_delete
on public.callers
for delete
to authenticated
using (owner_id = auth.uid());

create policy call_sessions_read
on public.call_sessions
for select
to authenticated
using (owner_id = auth.uid());

create policy call_sessions_insert
on public.call_sessions
for insert
to authenticated
with check (owner_id = auth.uid());

create policy call_sessions_update
on public.call_sessions
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy call_sessions_delete
on public.call_sessions
for delete
to authenticated
using (owner_id = auth.uid());

create policy call_turns_read
on public.call_turns
for select
to authenticated
using (owner_id = auth.uid());

create policy call_turns_insert
on public.call_turns
for insert
to authenticated
with check (owner_id = auth.uid());

create policy call_turns_update
on public.call_turns
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy call_turns_delete
on public.call_turns
for delete
to authenticated
using (owner_id = auth.uid());

create policy call_events_read
on public.call_events
for select
to authenticated
using (owner_id = auth.uid());

create policy call_events_insert
on public.call_events
for insert
to authenticated
with check (owner_id = auth.uid());

create policy call_events_update
on public.call_events
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy call_events_delete
on public.call_events
for delete
to authenticated
using (owner_id = auth.uid());

create policy memory_chunks_read
on public.memory_chunks
for select
to authenticated
using (owner_id = auth.uid());

create policy memory_chunks_insert
on public.memory_chunks
for insert
to authenticated
with check (owner_id = auth.uid());

create policy memory_chunks_update
on public.memory_chunks
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy memory_chunks_delete
on public.memory_chunks
for delete
to authenticated
using (owner_id = auth.uid());

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.agent_settings to authenticated;
grant select, insert, update, delete on public.callers to authenticated;
grant select, insert, update, delete on public.call_sessions to authenticated;
grant select, insert, update, delete on public.call_turns to authenticated;
grant select, insert, update, delete on public.call_events to authenticated;
grant select, insert, update, delete on public.memory_chunks to authenticated;

grant all on public.agent_settings to service_role;
grant all on public.callers to service_role;
grant all on public.call_sessions to service_role;
grant all on public.call_turns to service_role;
grant all on public.call_events to service_role;
grant all on public.memory_chunks to service_role;
