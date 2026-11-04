-- RLS and cap checks for 20261104000000_arunachala_team_context.sql, runnable on plain
-- Postgres: stubs Supabase's auth schema and roles, applies the migration,
-- then asserts. Run: supabase/tests/run-local.sh (any failure raises).
\set ON_ERROR_STOP on

-- Supabase stubs -------------------------------------------------------------
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

\i /migrations/20261104000000_arunachala_team_context.sql

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Fixtures (as admin) ----------------------------------------------------------
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
insert into public.arunachala_teams (id, name) values
  ('10000000-0000-0000-0000-00000000000a', 'Team A'),
  ('10000000-0000-0000-0000-00000000000b', 'Team B');
insert into public.arunachala_team_members (team_id, user_id, display_name, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Alice', 'owner'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Bob', 'owner');
insert into public.arunachala_memory (team_id, owner, content) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'A secret'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'B secret');
insert into public.arunachala_agent_runs (id, team_id, owner, agent, repo) values
  ('run-a', '10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'noop', 'r');
insert into public.arunachala_ai_limits (team_id, member_daily_calls, team_daily_calls) values
  ('10000000-0000-0000-0000-00000000000a', 2, 10);

-- As Alice -----------------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

do $$ begin
  -- 1. sees only her team's memory
  if (select count(*) from public.arunachala_memory) <> 1
     or exists (select 1 from public.arunachala_memory where content = 'B secret') then
    raise exception 'FAIL 1: cross-team memory visible';
  end if;
  raise notice 'PASS 1: memory scoped to team';

  -- 2. cannot write into another team
  begin
    insert into public.arunachala_memory (team_id, content) values ('10000000-0000-0000-0000-00000000000b', 'x');
    raise exception 'FAIL 2: wrote into team B';
  exception when insufficient_privilege then raise notice 'PASS 2: other team write refused';
  end;

  -- 3. cannot write as someone else
  begin
    insert into public.arunachala_memory (team_id, owner, content)
      values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'x');
    raise exception 'FAIL 3: wrote as Bob';
  exception when insufficient_privilege then raise notice 'PASS 3: impersonation refused';
  end;

  -- 4. member daily cap (limit 2): third call refused
  insert into public.arunachala_ai_calls (team_id, provider, model, purpose) values ('10000000-0000-0000-0000-00000000000a', 'p', 'm', 'route');
  insert into public.arunachala_ai_calls (team_id, provider, model, purpose) values ('10000000-0000-0000-0000-00000000000a', 'p', 'm', 'route');
  begin
    insert into public.arunachala_ai_calls (team_id, provider, model, purpose) values ('10000000-0000-0000-0000-00000000000a', 'p', 'm', 'route');
    raise exception 'FAIL 4: cap not enforced';
  exception when raise_exception then
    if sqlerrm not like 'ai_cap_member%' then raise; end if;
    raise notice 'PASS 4: member cap enforced (%)', sqlerrm;
  end;
end $$;

-- As Bob -------------------------------------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ declare n int; begin
  -- 5. cannot finish Alice's run (row invisible -> 0 rows updated)
  update public.arunachala_agent_runs set status = 'done' where id = 'run-a';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 5: updated another team''s run'; end if;
  raise notice 'PASS 5: other team run untouched';

  -- 6. cannot add himself to Team A
  begin
    insert into public.arunachala_team_members (team_id, user_id, display_name)
      values ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'Bob');
    raise exception 'FAIL 6: joined team A';
  exception when insufficient_privilege then raise notice 'PASS 6: self-join refused';
  end;
end $$;

reset role;
\echo ALL CHECKS PASSED
