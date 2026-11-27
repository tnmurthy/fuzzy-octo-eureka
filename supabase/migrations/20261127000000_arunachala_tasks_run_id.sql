-- A task can carry the id of the agent run working it, so the Ops board and
-- the task/Kanban board can show a linked-run badge (read-only for now - no
-- UI or write-back from the run side yet, that is separate follow-up work).

alter table public.arunachala_tasks add column run_id text;
