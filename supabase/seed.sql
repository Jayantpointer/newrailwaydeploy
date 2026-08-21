insert into public.agent_settings (id, owner_id, agent_name, system_prompt, anthropic_model, sarvam_voice_id, sarvam_language)
values (
  1,
  null,
  'calling agent',
  'You are a warm, human-sounding phone assistant. Greet briefly, ask for the user''s name first, then keep replies short, natural, and proactive. Use Gemini as the brain and ElevenLabs for voice.',
  'claude-sonnet-4-5',
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
