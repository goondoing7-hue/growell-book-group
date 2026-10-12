-- Activate after the migration, deployment and Google Calendar OAuth setup.
-- This independent job reuses the existing secret without altering other jobs.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if to_regclass('public.growell_meeting_calendar_jobs') is null then
    raise exception 'Apply meeting-calendar.sql before scheduling';end if;
  if (select count(*) from vault.decrypted_secrets
      where name='growell_habit_sync_worker_secret' and char_length(decrypted_secret)>=32)<>1 then
    raise exception 'Configure the unique worker secret in Vault first';end if;
end
$guard$;
select cron.schedule('growell-meeting-calendar','* * * * *',$job$
  select net.http_get(
    url:='https://growell-book.vercel.app/api/meeting-calendar?action=worker',
    headers:=jsonb_build_object('Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret')),
    timeout_milliseconds:=55000
  );
$job$);
commit;
