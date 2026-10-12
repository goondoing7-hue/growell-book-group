-- Run explicitly only AFTER the PDF endpoint and mail worker are deployed.
-- The user requested automatic mail after an already-completed unified Google
-- connection. This enrolls verified approved connections, queues only their
-- latest accessible public operator record, and preserves an existing OFF switch.
-- It never backfills archives, changes authored records or sends mail in SQL.
begin;
do $activate$
declare member record;
begin
  for member in select p.id,p.auth_user_id from public.profiles p
    join public.growell_drive_backup_connections d on d.owner_id=p.id and d.auth_user_id=p.auth_user_id
    join public.growell_meeting_calendar_connections c on c.owner_id=p.id and c.auth_user_id=p.auth_user_id
    where p.approval_status='approved' and p.is_deleted=false and d.token_cipher is not null and c.token_cipher is not null
      and d.account_id=c.account_id and lower(d.account_email)=lower(c.account_email)
      and d.account_email !~ '[[:space:][:cntrl:]]' and d.account_email ~ '^[^@]+@[^@]+\.[^@]+$'
      and char_length(d.account_email) between 3 and 254 loop
    perform public.growell_meeting_mail_configure(member.id,member.auth_user_id,'connect','{}'::jsonb);
  end loop;
end
$activate$;
commit;
