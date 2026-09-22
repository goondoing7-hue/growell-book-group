-- Run as the database owner before deploying the guest password-recovery flow.
-- This is a bounded ownership check, NOT a password-reset authorization token.
-- The existing reset-password Edge Function must still verify the account hint.
-- No recovery key, ciphertext, password, salt, hint, or profile row is returned.
-- The membership SELECT policies remain unchanged.
begin;

create or replace function public.growell_recovery_owner_matches(
  p_login_id text,
  p_user_id text,
  p_auth_user_id text
) returns boolean
language plpgsql stable security definer
set search_path = ''
as $function$
begin
  if p_login_id is null or length(p_login_id) not between 1 and 200
     or p_user_id is null or length(p_user_id) not between 1 and 200
     or p_auth_user_id is null
     or p_auth_user_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  return exists (
    select 1 from public.profiles p
    where p.login_id = p_login_id
      and p.id = p_user_id
      and p.auth_user_id::text = p_auth_user_id
      and p.is_deleted = false
  );
end;
$function$;

revoke all on function public.growell_recovery_owner_matches(text,text,text) from public, anon, authenticated;
grant execute on function public.growell_recovery_owner_matches(text,text,text) to anon, authenticated;

comment on function public.growell_recovery_owner_matches(text,text,text) is
  'Boolean-only exact match of recovery-file login/profile/Auth IDs for an active member. Does not authorize a password reset; reset-password must independently verify the hint.';

commit;
