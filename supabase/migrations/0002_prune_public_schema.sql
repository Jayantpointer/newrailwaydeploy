do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename not in (
        'agent_settings',
        'callers',
        'call_sessions',
        'call_turns',
        'call_events',
        'memory_chunks'
      )
  loop
    execute format('drop table if exists public.%I cascade;', r.tablename);
  end loop;

  for r in
    select viewname
    from pg_views
    where schemaname = 'public'
      and viewname not in (
        'agent_settings',
        'callers',
        'call_sessions',
        'call_turns',
        'call_events',
        'memory_chunks'
      )
  loop
    execute format('drop view if exists public.%I cascade;', r.viewname);
  end loop;
end
$$;
