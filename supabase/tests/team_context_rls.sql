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
\i /migrations/20261104000100_arunachala_revoke_trigger_fn_execute.sql
\i /migrations/20261105000000_arunachala_ai_calls_ledger.sql
\i /migrations/20261105000100_arunachala_memory_client_id.sql
\i /migrations/20261105000200_arunachala_runs_auto.sql

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

  -- 7. local Ollama calls are recorded past the cap and do not count
  insert into public.arunachala_ai_calls (team_id, provider, model, purpose, client_id)
    values ('10000000-0000-0000-0000-00000000000a', 'ollama', 'gemma3:4b', 'persona', 'local-1');
  raise notice 'PASS 7: local call recorded past the paid-call cap';

  -- 8. a resent ledger line (same client_id) is skipped, not duplicated
  insert into public.arunachala_ai_calls (team_id, provider, model, purpose, client_id)
    values ('10000000-0000-0000-0000-00000000000a', 'ollama', 'gemma3:4b', 'persona', 'local-1')
    on conflict (client_id) do nothing;
  if (select count(*) from public.arunachala_ai_calls where client_id = 'local-1') <> 1 then
    raise exception 'FAIL 8: duplicate ledger line stored';
  end if;
  raise notice 'PASS 8: resent ledger line ignored';

  -- 9. a resent memory entry (same client_id) is skipped
  insert into public.arunachala_memory (team_id, content, client_id)
    values ('10000000-0000-0000-0000-00000000000a', 'note', 'mem_1');
  insert into public.arunachala_memory (team_id, content, client_id)
    values ('10000000-0000-0000-0000-00000000000a', 'note', 'mem_1')
    on conflict (client_id) do nothing;
  if (select count(*) from public.arunachala_memory where client_id = 'mem_1') <> 1 then
    raise exception 'FAIL 9: duplicate memory stored';
  end if;
  raise notice 'PASS 9: resent memory ignored';

  -- 10. any member moves a task on the shared board
  insert into public.arunachala_tasks (team_id, title) values ('10000000-0000-0000-0000-00000000000a', 'Ship it');
  update public.arunachala_tasks set status = 'in_progress' where title = 'Ship it';
  if (select status from public.arunachala_tasks where title = 'Ship it') <> 'in_progress' then
    raise exception 'FAIL 10: task not moved';
  end if;
  raise notice 'PASS 10: task created and moved';

  -- 11. an auto run records whether it escalated
  insert into public.arunachala_agent_runs (id, team_id, agent, repo, escalated)
    values ('run-auto', '10000000-0000-0000-0000-00000000000a', 'auto', 'r', false);
  raise notice 'PASS 11: auto run with escalated stored';
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
