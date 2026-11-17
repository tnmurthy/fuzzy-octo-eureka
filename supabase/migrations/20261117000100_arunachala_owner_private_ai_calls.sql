-- Owner (admin) AI usage is private too, like their memory and runs
-- (20261117000000). Rows in arunachala_ai_calls get the same visibility
-- column and default (owners private, members team). The daily cap trigger
-- (arunachala_enforce_ai_caps) is security definer, so it still counts every
-- row: hiding usage from members does not loosen the team caps.

alter table public.arunachala_ai_calls
  add column visibility text check (visibility in ('private', 'team'));

update public.arunachala_ai_calls c
  set visibility = case when exists (
    select 1 from public.arunachala_team_members tm
    where tm.team_id = c.team_id and tm.user_id = c.owner and tm.role = 'owner'
  ) then 'private' else 'team' end;

create trigger arunachala_calls_visibility before insert on public.arunachala_ai_calls
  for each row execute function public.arunachala_default_visibility();

alter table public.arunachala_ai_calls alter column visibility set not null;

drop policy calls_select on public.arunachala_ai_calls;
create policy calls_select on public.arunachala_ai_calls for select to authenticated
  using (
    owner = (select auth.uid())
    or (visibility = 'team' and (select public.arunachala_is_team_member(team_id)))
  );

create index arunachala_calls_team_visibility on public.arunachala_ai_calls (team_id, visibility);
