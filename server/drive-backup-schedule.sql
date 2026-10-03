-- Activate after drive-backup.sql, production deployment, and Google OAuth setup.
-- Reuse the existing Vault worker secret; never paste its value into this file.
-- This named job does not replace or alter the existing habit sync schedule.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if to_regclass('public.growell_drive_backup_connections') is null then
    raise exception 'Apply drive-backup.sql before scheduling';end if;
  if (select count(*) from vault.decrypted_secrets
      where name='growell_habit_sync_worker_secret' and char_length(decrypted_secret)>=32)<>1 then
    raise exception 'Configure the unique worker secret in Vault first';end if;
end
$guard$;
select cron.schedule('growell-drive-backup','* * * * *',$job$
  select net.http_get(
    url:='https://growell-book.vercel.app/api/drive-backup?action=worker',
    headers:=jsonb_build_object('Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='growell_habit_sync_worker_secret')),
    timeout_milliseconds:=55000
  );
$job$);
commit;
