drop index if exists public.callers_owner_full_name_unique;

create unique index callers_owner_full_name_unique
on public.callers (
  coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(regexp_replace(btrim(full_name), '\s+', ' ', 'g'))
)
where full_name is not null and btrim(full_name) <> '';
