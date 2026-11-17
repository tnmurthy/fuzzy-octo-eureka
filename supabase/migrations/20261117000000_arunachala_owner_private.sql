-- Owner (admin) memory and agent runs are private to their author.
--
-- Before: every team member could read every memory and every agent run
-- (task text included). Now each row has a visibility:
--   private - only its author can read it
--   team    - every member of the team can read it
-- New rows written by a team owner default to private; rows by members
-- default to team (unchanged behaviour for them). The author can change the
-- visibility of their own memory later. Tasks (shared board), the AI ledger
-- (no content; needed for the team cost caps) and limits are unchanged.

alter table public.arunachala_memory
  add column visibility text check (visibility in ('private', 'team'));
alter table public.arunachala_agent_runs
  add column visibility text check (visibility in ('private', 'team'));

-- Existing rows: owners' rows become private, everyone else's stay team.
update public.arunachala_memory m
  set visibility = case when exists (
    select 1 from public.arunachala_team_members tm
    where tm.team_id = m.team_id and tm.user_id = m.owner and tm.role = 'owner'
  ) then 'private' else 'team' end;
update public.arunachala_agent_runs r
  set visibility = case when exists (
    select 1 from public.arunachala_team_members tm
    where tm.team_id = r.team_id and tm.user_id = r.owner and tm.role = 'owner'
  ) then 'private' else 'team' end;

-- Default for new rows, by the author's role. An explicit value is kept.
create function public.arunachala_default_visibility()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.visibility is null then
    new.visibility := case when exists (
      select 1 from public.arunachala_team_members tm
      where tm.team_id = new.team_id and tm.user_id = new.owner and tm.role = 'owner'
    ) then 'private' else 'team' end;
  end if;
  return new;
end;
$$;
revoke execute on function public.arunachala_default_visibility() from public, anon, authenticated;

create trigger arunachala_memory_visibility before insert on public.arunachala_memory
  for each row execute function public.arunachala_default_visibility();
create trigger arunachala_runs_visibility before insert on public.arunachala_agent_runs
  for each row execute function public.arunachala_default_visibility();

alter table public.arunachala_memory alter column visibility set not null;
alter table public.arunachala_agent_runs alter column visibility set not null;

-- Read: your own rows, plus rows shared with your team.
drop policy memory_select on public.arunachala_memory;
create policy memory_select on public.arunachala_memory for select to authenticated
  using (
    owner = (select auth.uid())
    or (visibility = 'team' and (select public.arunachala_is_team_member(team_id)))
  );

drop policy runs_select on public.arunachala_agent_runs;
create policy runs_select on public.arunachala_agent_runs for select to authenticated
  using (
    owner = (select auth.uid())
    or (visibility = 'team' and (select public.arunachala_is_team_member(team_id)))
  );

-- The author may change their own memory (e.g. share one entry with the team).
create policy memory_update on public.arunachala_memory for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

create index arunachala_memory_team_visibility on public.arunachala_memory (team_id, visibility);
create index arunachala_runs_team_visibility on public.arunachala_agent_runs (team_id, visibility);
