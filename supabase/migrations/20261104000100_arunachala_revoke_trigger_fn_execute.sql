-- Trigger functions are not an API: Supabase's advisor flagged
-- arunachala_enforce_ai_caps (security definer) as callable over
-- /rest/v1/rpc by anon and authenticated. Triggers still fire without it.
revoke execute on function public.arunachala_enforce_ai_caps() from public, anon, authenticated;
revoke execute on function public.arunachala_touch_updated_at() from public, anon, authenticated;
