-- OPTIONAL ACTIVATION, only after Gmail verification and worker deployment.
-- signup-notifications.sql generates the internal worker token inside Vault.
-- The worker validates it via a service-only RPC; no second Edge secret entry
-- is needed. GROWELL_GMAIL_APP_PASSWORD is saved directly in Edge secrets.
-- Never paste either secret into this file or output a Vault decrypted value.
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
