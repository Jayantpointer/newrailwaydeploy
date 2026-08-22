update public.agent_settings
set system_prompt = system_prompt || E'\n\nMEMORY CONSISTENCY: Treat saved memories as useful but fallible and possibly out of date. If a relevant current statement conflicts with a past memory, do not accuse the caller or silently ignore it. Point it out gently, ask whether the preference or situation changed, and give the current statement priority until clarified.'
where id = 1
  and system_prompt not like '%MEMORY CONSISTENCY%';
