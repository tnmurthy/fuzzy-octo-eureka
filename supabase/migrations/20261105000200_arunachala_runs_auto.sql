-- `auto` dispatches try a local agent first and escalate to claude only when
-- the repo's tests fail. Allow the agent value and record the outcome, so the
-- team can see how often local models were enough.
alter table public.arunachala_agent_runs drop constraint arunachala_agent_runs_agent_check;
alter table public.arunachala_agent_runs add constraint arunachala_agent_runs_agent_check
  check (agent in ('claude', 'codex', 'agy', 'hermes', 'noop', 'auto'));
alter table public.arunachala_agent_runs add column escalated boolean;
