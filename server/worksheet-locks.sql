-- Independent worksheet locks. Requires member-approval.sql first.
-- New/unconfigured books remain locked. Existing responses are never rewritten.
-- Review and run worksheet-locks-verification.sql without this COMMIT first.
begin;

do $guard$
begin
  if to_regprocedure('public.growell_is_approved_admin()') is null then
    raise exception 'Apply member-approval.sql first';
  end if;
  if not exists(select 1 from pg_class where oid='public.worksheets'::regclass and relrowsecurity) then
    raise exception 'Expected existing worksheet RLS';
  end if;
end
$guard$;

create table if not exists public.growell_worksheet_locks (
  book_id text primary key check (book_id in ('emotion','thought','body','action')),
  locked boolean not null default true,
  revision bigint not null default 1 check (revision>0),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.growell_worksheet_locks enable row level security;
revoke all on public.growell_worksheet_locks from public,anon,authenticated;

create or replace function public.growell_can_access_worksheet(p_book_id text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select public.growell_is_active_member() and
    (public.growell_is_approved_admin() or (
      not coalesce((select b.locked from public.book_locks b where b.book_id=p_book_id),p_book_id<>'emotion')
      and exists (select 1 from public.growell_worksheet_locks l where l.book_id=p_book_id and l.locked=false)
    ));
$function$;
revoke all on function public.growell_can_access_worksheet(text) from public,anon,authenticated;
grant execute on function public.growell_can_access_worksheet(text) to anon,authenticated;

-- Supersedes the earlier permanent admin-only restriction. Other existing
-- SELECT/owner-write policies remain AND-combined with this book-specific gate.
drop policy if exists growell_worksheets_admin_only on public.worksheets;
drop policy if exists growell_worksheets_access on public.worksheets;
create policy growell_worksheets_access on public.worksheets
  as restrictive for all to anon,authenticated
  using (public.growell_can_access_worksheet(book_id))
  with check (public.growell_can_access_worksheet(book_id));

create or replace function public.growell_get_worksheet_locks()
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
begin
  if not public.growell_is_active_member() then
    raise exception 'Approved membership required' using errcode='42501';
  end if;
  return (select jsonb_agg(jsonb_build_object('book_id',b.book_id,
    'locked',coalesce(l.locked,true),'revision',coalesce(l.revision,0)) order by b.position)
    from (values ('emotion',1),('thought',2),('body',3),('action',4)) b(book_id,position)
    left join public.growell_worksheet_locks l on l.book_id=b.book_id);
end
$function$;
revoke all on function public.growell_get_worksheet_locks() from public,anon,authenticated;
grant execute on function public.growell_get_worksheet_locks() to authenticated;

create or replace function public.growell_set_worksheet_lock(p_book_id text,p_locked boolean,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare saved public.growell_worksheet_locks%rowtype; actor text;
begin
  if not public.growell_is_approved_admin() then
    raise exception 'Administrator required' using errcode='42501';
  end if;
  if p_book_id is null or p_book_id not in ('emotion','thought','body','action')
      or p_locked is null or p_expected_revision is null or p_expected_revision<0 then
    raise exception 'Invalid worksheet lock' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('growell_worksheet:'||p_book_id,0));
  select * into saved from public.growell_worksheet_locks where book_id=p_book_id for update;
  if coalesce(saved.revision,0)<>p_expected_revision then
    raise exception 'Worksheet lock changed; reload before saving' using errcode='40001';
  end if;
  select id into actor from public.profiles where auth_user_id=(select auth.uid());
  insert into public.growell_worksheet_locks(book_id,locked,revision,updated_at,updated_by)
    values(p_book_id,p_locked,p_expected_revision+1,now(),actor)
    on conflict(book_id) do update set locked=excluded.locked,revision=excluded.revision,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into saved;
  return jsonb_build_object('book_id',saved.book_id,'locked',saved.locked,'revision',saved.revision);
end
$function$;
revoke all on function public.growell_set_worksheet_lock(text,boolean,bigint) from public,anon,authenticated;
grant execute on function public.growell_set_worksheet_lock(text,boolean,bigint) to authenticated;

commit;
