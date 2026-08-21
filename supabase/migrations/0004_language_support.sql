alter table public.agent_settings
add column if not exists sarvam_language text not null default 'auto';

alter table public.callers
add column if not exists preferred_language text not null default 'en';

alter table public.memory_chunks
add column if not exists language text not null default 'en';
