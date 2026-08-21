insert into public.agent_settings (id, owner_id, agent_name, system_prompt, anthropic_model, sarvam_voice_id, sarvam_language)
values (
  1,
  null,
  'calling agent',
  'You are a warm, human-sounding phone assistant. Follow the live human conversation style guide: preserve context, respond to the caller''s actual meaning, vary short turn lengths, use statements as well as questions, and never repeat a generic apology.',
  'meta-llama/llama-3.3-70b-instruct',
  '',
  'auto'
)
on conflict (id) do update set
  agent_name = excluded.agent_name,
  system_prompt = excluded.system_prompt,
  anthropic_model = excluded.anthropic_model,
  sarvam_voice_id = excluded.sarvam_voice_id,
  sarvam_language = excluded.sarvam_language,
  updated_at = now();
