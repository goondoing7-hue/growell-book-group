-- Run after web-push.sql and the production worker are verified.
-- Uses the existing private Vault credential. No credential is embedded in SQL.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if to_regclass('public.growell_web_push_jobs') is null then raise exception 'Apply web-push.sql first';end if;
  if (select count(*) from vault.decrypted_secrets where name='growell_habit_sync_worker_secret'
    and char_length(decrypted_secret) between 32 and 256)<>1 then raise exception 'Existing unique worker secret required';end if;
end
$guard$;
-- Keep the morning queue durable even when the HTTP worker is temporarily
-- unavailable. This is a separate cron transaction from provider delivery;
-- the database function itself enforces the Korean-time morning window.
select cron.schedule('growell-daily-verse-queue','* * * * *',$queue$
  select public.growell_web_push_tick();
$queue$);
select cron.schedule('growell-web-push','* * * * *',$job$
  select net.http_post(
    url:='https://growell-book.vercel.app/api/web-push?action=worker',
    headers:=jsonb_build_object('Content-Type','application/json','x-growell-worker-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret')),
    body:='{"action":"worker"}'::jsonb,
    timeout_milliseconds:=55000
  );
$job$);
commit;
