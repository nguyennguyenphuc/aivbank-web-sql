-- Đồng bộ tài khoản từ AIV Bank.
--
-- Mỗi user AIV Bank (một PostgreSQL login role bên `aivb_app`) ứng với đúng một
-- tài khoản game qua `account_identities(provider = 'aivb', provider_subject =
-- username)`. Hai đường cùng đi qua hàm dưới đây nên chỉ có MỘT logic upsert:
--   * SSO khi mở tab Trò chơi (`POST /api/v1/auth/aivb-sso`);
--   * đồng bộ hàng loạt từ `backend/game_sync.py` bên AIV Bank.

create table if not exists aivb_sso_used_tickets (
  jti text primary key,
  expires_at timestamptz not null
);
create index if not exists idx_aivb_sso_used_tickets_expiry on aivb_sso_used_tickets(expires_at);

create or replace function aivb_upsert_account(p_username text, p_display_name text, p_role text)
returns uuid
language plpgsql
as $$
declare
  v_account uuid;
  v_name text := coalesce(nullif(btrim(p_display_name), ''), p_username);
  v_role text := case when p_role = 'instructor' then 'instructor' else 'student' end;
begin
  if p_username is null or btrim(p_username) = '' then
    raise exception 'aivb_upsert_account: username is required';
  end if;

  -- Khoá theo username để hai lần SSO đồng thời không cùng tạo tài khoản.
  perform pg_advisory_xact_lock(hashtext('aivb:' || p_username));

  select account_id into v_account
    from account_identities
   where provider = 'aivb' and provider_subject = p_username and deleted_at is null;

  if v_account is null then
    v_account := gen_random_uuid();
    insert into accounts (account_id, display_name, is_guest, status)
    values (v_account, v_name, false, 'active');
    insert into account_identities (identity_id, account_id, provider, provider_subject, profile)
    values (gen_random_uuid(), v_account, 'aivb', p_username, jsonb_build_object('username', p_username));
    insert into player_profiles (account_id, display_name)
    values (v_account, v_name)
    on conflict (account_id) do nothing;
  else
    update accounts
       set display_name = v_name, status = 'active', is_guest = false,
           deleted_at = null, updated_at = now()
     where account_id = v_account
       and (display_name is distinct from v_name or status <> 'active' or is_guest or deleted_at is not null);
  end if;

  -- Vai trò đi theo AIV Bank: gỡ vai trò lớp học cũ nếu đã đổi.
  delete from role_grants
   where account_id = v_account and role in ('student', 'instructor') and role <> v_role;
  insert into role_grants (grant_id, account_id, role)
  values (gen_random_uuid(), v_account, v_role)
  on conflict (account_id, role) do nothing;

  return v_account;
end;
$$;

-- User đã bị xoá bên AIV Bank: khoá tài khoản game và thu hồi phiên đang mở.
create or replace function aivb_disable_missing(p_usernames text[])
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  with gone as (
    update accounts a
       set status = 'disabled', updated_at = now()
      from account_identities i
     where i.account_id = a.account_id
       and i.provider = 'aivb'
       and a.status <> 'disabled'
       and not (i.provider_subject = any(p_usernames))
    returning a.account_id
  ), revoked as (
    update auth_sessions s set revoked_at = now(), updated_at = now()
      from gone g
     where s.account_id = g.account_id and s.revoked_at is null
  )
  select count(*) into v_count from gone;
  return v_count;
end;
$$;
