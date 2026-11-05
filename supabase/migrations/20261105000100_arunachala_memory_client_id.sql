-- Memory entries are synced from each machine's drisyon-memory.json. The
-- local entry id becomes client_id, so a resend after a crash or restart is
-- ignored instead of stored twice.
alter table public.arunachala_memory add column client_id text;
alter table public.arunachala_memory
  add constraint arunachala_memory_client_id_key unique (client_id);
