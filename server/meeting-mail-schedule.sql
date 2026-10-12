-- Apply only after SMTP verify, the fixed PDF endpoint and Edge worker are ready.
-- Reuses the existing credential; no member content or credential is returned.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if to_regclass('public.growell_meeting_mail_jobs') is null then
    raise exception 'Apply meeting-mail.sql first';end if;
  if (select count(*) from vault.decrypted_secrets
      where name='growell_habit_sync_worker_secret' and char_length(decrypted_secret) between 32 and 256)<>1 then
    raise exception 'Existing unique worker secret required';end if;
end
$guard$;
select cron.schedule('growell-meeting-mail','* * * * *',$job$
  select net.http_post(
    url:='https://oxaeecawijnetwmvggjs.supabase.co/functions/v1/meeting-record-email',
    headers:=jsonb_build_object('Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94YWVlY2F3aWpuZXR3bXZnZ2pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyODQ4NDEsImV4cCI6MjEwMzg2MDg0MX0.TXOCq4lgPZRcWDncN0qlZkkKymXJS_sl5LlCauP_DGk','Content-Type','application/json','x-growell-worker-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret')),
    body:='{"action":"process"}'::jsonb,
    timeout_milliseconds:=55000
  );
$job$);
commit;
