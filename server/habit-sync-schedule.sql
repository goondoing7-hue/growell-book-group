-- Activate only after habit-sync.sql, production API and Microsoft setup pass.
-- In Supabase Vault, save the SAME value as Vercel CRON_SECRET under
-- growell_habit_sync_worker_secret. Never paste the value into this file.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if to_regclass('public.growell_habit_sync_connections') is null then
    raise exception 'Apply habit-sync.sql before scheduling';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='growell_habit_sync_worker_secret' and char_length(decrypted_secret)>=32) <> 1 then
    raise exception 'Configure the unique habit sync worker secret in Vault first';
  end if;
end
$guard$;
select cron.schedule('growell-habit-sync','* * * * *',$job$
  select net.http_get(
    url:='https://growell-book.vercel.app/api/habit-sync?action=worker',
    headers:=jsonb_build_object('Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret')),
    timeout_milliseconds:=55000
  );
$job$);
commit;
