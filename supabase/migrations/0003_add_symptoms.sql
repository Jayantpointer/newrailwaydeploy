alter table public.callers
add column if not exists symptoms text[] not null default '{}'::text[];

alter table public.memory_chunks
add column if not exists symptoms text[] not null default '{}'::text[];
