-- Every AI call is now logged, local ones included, so the ledger shows where
-- tokens actually go. Two changes:
-- 1. client_id: the id the machine's local ledger gave the call, so a resend
--    after a crash is ignored instead of counted twice.
-- 2. Local Ollama calls cost nothing: they are recorded but neither count
--    towards nor are blocked by the daily caps, which guard paid calls only.

alter table public.arunachala_ai_calls add column client_id text;
alter table public.arunachala_ai_calls
  add constraint arunachala_ai_calls_client_id_key unique (client_id);

create or replace function public.arunachala_enforce_ai_caps()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  lim public.arunachala_ai_limits;
  member_count int;
  team_count int;
begin
  if new.provider = 'ollama' then
    return new;
  end if;
  select * into lim from public.arunachala_ai_limits where team_id = new.team_id;
  if not found then
    lim.member_daily_calls := 200;
    lim.team_daily_calls := 1000;
  end if;
  select count(*) into member_count from public.arunachala_ai_calls
    where team_id = new.team_id and owner = new.owner and provider <> 'ollama'
      and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  select count(*) into team_count from public.arunachala_ai_calls
    where team_id = new.team_id and provider <> 'ollama'
      and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  if member_count >= lim.member_daily_calls then
    raise exception 'ai_cap_member: daily limit of % calls reached', lim.member_daily_calls
      using errcode = 'P0001';
  end if;
  if team_count >= lim.team_daily_calls then
    raise exception 'ai_cap_team: team daily limit of % calls reached', lim.team_daily_calls
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- create or replace keeps grants; restate the revoke so this file stands alone.
revoke execute on function public.arunachala_enforce_ai_caps() from public, anon, authenticated;
