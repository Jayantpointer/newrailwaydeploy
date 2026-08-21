alter table public.callers
add column if not exists current_activity text,
add column if not exists interests text[] not null default '{}'::text[];
