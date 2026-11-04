-- Shared team context for Arunachala: every teammate runs their own install
-- (own keys, own machine) and reads/writes these tables. Each member signs in
-- with their own Supabase user; row level security limits them to their
-- team's rows, and to writing only rows they own. No service_role key ever
-- lives on a laptop.
--
-- Tables: teams, team_members, memory_entries, tasks, agent_runs, ai_calls,
-- ai_limits. Pricing never goes in here (cost_usd is a computed spend figure
-- per call, not a rate card).

-- ---------------------------------------------------------------------------
-- Teams and membership
-- ---------------------------------------------------------------------------
create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 80),
  created_at  timestamptz not null default now()
);

create table public.team_members (
  team_id       uuid not null references public.teams(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  display_name  text not null check (length(display_name) between 1 and 80),
  buzz_pubkey   text check (buzz_pubkey ~ '^[0-9a-f]{64}$'),
  role          text not null default 'member' check (role in ('owner', 'member')),
  created_at    timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members(user_id);

-- Membership check used by every policy. security definer so a policy on
-- team_members itself does not recurse; search_path pinned.
create function public.is_team_member(p_team uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = p_team and m.user_id = (select auth.uid())
  );
$$;

create function public.is_team_owner(p_team uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = p_team and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

revoke execute on function public.is_team_member(uuid), public.is_team_owner(uuid) from public, anon;
grant execute on function public.is_team_member(uuid), public.is_team_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Shared context
-- ---------------------------------------------------------------------------
-- Drisyon memory (was drisyon-memory.json). Append-only: no update policy.
create table public.memory_entries (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  owner       uuid not null default auth.uid() references auth.users(id),
  tenant_id   text not null default 'tenant:drisyon_core',
  project_id  text not null default 'global',
  category    text not null default 'context',
  title       text not null default 'Untitled Knowledge' check (length(title) <= 200),
  content     text not null check (length(content) <= 20000),
  tags        text[] not null default '{}',
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index memory_entries_team_idx on public.memory_entries(team_id, tenant_id, created_at desc);
create index memory_entries_owner_idx on public.memory_entries(owner);

-- Task board (was 04_internal/TASKS.md). Any member moves any task.
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  owner       uuid not null default auth.uid() references auth.users(id),
  title       text not null check (length(title) between 1 and 300),
  project     text,
  status      text not null default 'backlog' check (status in ('backlog', 'in_progress', 'done')),
  assignee    uuid references auth.users(id),
  link        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tasks_team_idx on public.tasks(team_id, status);
create index tasks_owner_idx on public.tasks(owner);
create index tasks_assignee_idx on public.tasks(assignee);

-- Agent runs (was runs.jsonl). id = the dispatcher's run id; the start line
-- inserts, the end line updates the same row.
create table public.agent_runs (
  id             text primary key check (id ~ '^[A-Za-z0-9._-]{1,80}$'),
  team_id        uuid not null references public.teams(id) on delete cascade,
  owner          uuid not null default auth.uid() references auth.users(id),
  agent          text not null check (agent in ('claude', 'codex', 'agy', 'hermes', 'noop')),
  repo           text not null,
  branch         text,
  task           text check (length(task) <= 20000),
  status         text not null default 'running' check (status in ('running', 'done', 'failed', 'timeout')),
  exit_code      int,
  duration_s     int,
  commits_ahead  int,
  head           text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index agent_runs_team_idx on public.agent_runs(team_id, started_at desc);
create index agent_runs_owner_idx on public.agent_runs(owner);

-- ---------------------------------------------------------------------------
-- AI cost controls: a ledger of billable calls + daily caps enforced here
-- ---------------------------------------------------------------------------
create table public.ai_calls (
  id             bigint generated always as identity primary key,
  team_id        uuid not null references public.teams(id) on delete cascade,
  owner          uuid not null default auth.uid() references auth.users(id),
  provider       text not null,
  model          text not null,
  purpose        text not null,
  ok             boolean not null default true,
  input_tokens   int not null default 0 check (input_tokens >= 0),
  output_tokens  int not null default 0 check (output_tokens >= 0),
  cost_usd       numeric(10, 6) not null default 0 check (cost_usd >= 0),
  ms             int,
  created_at     timestamptz not null default now()
);
create index ai_calls_team_day_idx on public.ai_calls(team_id, created_at);
create index ai_calls_owner_day_idx on public.ai_calls(owner, created_at);

-- One row per team: calls per member per day and for the whole team per day.
create table public.ai_limits (
  team_id               uuid primary key references public.teams(id) on delete cascade,
  member_daily_calls    int not null default 200 check (member_daily_calls >= 0),
  team_daily_calls      int not null default 1000 check (team_daily_calls >= 0),
  updated_at            timestamptz not null default now()
);

-- Reject a ledger insert past either cap (UTC day). The caller checks the
-- error and skips the model call, so no answer is ever paid for and dropped.
create function public.enforce_ai_caps()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  lim public.ai_limits;
  member_count int;
  team_count int;
begin
  select * into lim from public.ai_limits where team_id = new.team_id;
  if not found then
    lim.member_daily_calls := 200;
    lim.team_daily_calls := 1000;
  end if;
  select count(*) into member_count from public.ai_calls
    where team_id = new.team_id and owner = new.owner
      and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  select count(*) into team_count from public.ai_calls
    where team_id = new.team_id
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
create trigger ai_calls_cap before insert on public.ai_calls
  for each row execute function public.enforce_ai_caps();

-- ---------------------------------------------------------------------------
-- updated_at upkeep
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger tasks_touch before update on public.tasks
  for each row execute function public.touch_updated_at();
create trigger ai_limits_touch before update on public.ai_limits
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.teams          enable row level security;
alter table public.team_members   enable row level security;
alter table public.memory_entries enable row level security;
alter table public.tasks          enable row level security;
alter table public.agent_runs     enable row level security;
alter table public.ai_calls       enable row level security;
alter table public.ai_limits      enable row level security;

-- Teams and members: members read; owners manage membership. Teams and the
-- first owner are created by an admin (SQL editor), not from a laptop.
create policy teams_select on public.teams for select to authenticated
  using ((select public.is_team_member(id)));

create policy members_select on public.team_members for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy members_insert on public.team_members for insert to authenticated
  with check ((select public.is_team_owner(team_id)));
create policy members_update on public.team_members for update to authenticated
  using ((select public.is_team_owner(team_id)) or user_id = (select auth.uid()))
  with check ((select public.is_team_owner(team_id)) or (user_id = (select auth.uid()) and role = 'member'));
create policy members_delete on public.team_members for delete to authenticated
  using ((select public.is_team_owner(team_id)));

-- Memory: team reads, members add as themselves, delete only their own.
create policy memory_select on public.memory_entries for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy memory_insert on public.memory_entries for insert to authenticated
  with check ((select public.is_team_member(team_id)) and owner = (select auth.uid()));
create policy memory_delete on public.memory_entries for delete to authenticated
  using (owner = (select auth.uid()));

-- Tasks: shared board - any member adds and moves tasks; creator deletes.
create policy tasks_select on public.tasks for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select public.is_team_member(team_id)) and owner = (select auth.uid()));
create policy tasks_update on public.tasks for update to authenticated
  using ((select public.is_team_member(team_id)))
  with check ((select public.is_team_member(team_id)));
create policy tasks_delete on public.tasks for delete to authenticated
  using (owner = (select auth.uid()));

-- Agent runs: team reads; each person records and finishes only their own.
create policy runs_select on public.agent_runs for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy runs_insert on public.agent_runs for insert to authenticated
  with check ((select public.is_team_member(team_id)) and owner = (select auth.uid()));
create policy runs_update on public.agent_runs for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- AI ledger: team reads (for the Costs page); rows only added, as yourself.
create policy calls_select on public.ai_calls for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy calls_insert on public.ai_calls for insert to authenticated
  with check ((select public.is_team_member(team_id)) and owner = (select auth.uid()));

-- Limits: team reads, owners change.
create policy limits_select on public.ai_limits for select to authenticated
  using ((select public.is_team_member(team_id)));
create policy limits_upsert on public.ai_limits for insert to authenticated
  with check ((select public.is_team_owner(team_id)));
create policy limits_update on public.ai_limits for update to authenticated
  using ((select public.is_team_owner(team_id)))
  with check ((select public.is_team_owner(team_id)));
