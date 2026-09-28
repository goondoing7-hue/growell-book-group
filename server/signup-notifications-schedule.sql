-- OPTIONAL ACTIVATION, only after sender verification and worker deployment.
-- First save the SAME random worker secret in Edge Function secrets as
-- GROWELL_NOTIFICATION_WORKER_SECRET and Supabase Vault as
-- growell_signup_notification_worker_secret. Never paste a secret in this file.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $guard$
begin
  if not exists(select 1 from vault.decrypted_secrets
    where name='growell_signup_notification_worker_secret' and char_length(decrypted_secret)>=32) then
    raise exception 'Configure worker secret in Vault before scheduling';
  end if;
end
$guard$;
select cron.schedule('growell-signup-notifications','* * * * *',$job$
  select net.http_post(
    url:='https://oxaeecawijnetwmvggjs.supabase.co/functions/v1/signup-notification-worker',
    headers:=jsonb_build_object('Content-Type','application/json',
      'x-growell-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='growell_signup_notification_worker_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=45000
  );
$job$);
commit;
