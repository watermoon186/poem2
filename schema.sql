create extension if not exists pgcrypto;

-- Clean reset

drop trigger if exists trg_poem_likes_insert on poem_likes;
drop trigger if exists trg_poem_likes_delete on poem_likes;
drop function if exists public.sync_poem_likes_count();
drop function if exists public.cleanup_stale_rooms();
drop function if exists public.touch_room_presence(uuid, uuid, text);
drop function if exists public.leave_room(uuid, uuid);
drop function if exists public.end_room(uuid, uuid);

drop table if exists poem_likes cascade;
drop table if exists poems cascade;
drop table if exists lines cascade;
drop table if exists players cascade;
drop table if exists rooms cascade;

create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  theme text not null default '自由创作',
  total_rounds int not null default 4 check (total_rounds > 0),
  current_round int not null default 1 check (current_round > 0),
  status text not null default 'waiting'
    check (status in ('waiting', 'playing', 'finished', 'closed', 'archived')),
  reveal_mode text not null default 'final'
    check (reveal_mode in ('final', 'round')),
  revealed boolean not null default false,
  current_round_revealed boolean not null default false,
  visibility text not null default 'public'
    check (visibility in ('public', 'private')),
  owner_player_id uuid,
  ended_by_owner boolean not null default false,
  ended_at timestamptz,
  empty_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  nickname text not null,
  role text not null check (role in ('A', 'B')),
  line_position text not null check (line_position in ('upper', 'lower')),
  is_active boolean not null default true,
  left_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(room_id, role),
  unique(room_id, line_position)
);

alter table rooms
  add constraint rooms_owner_player_fk
  foreign key (owner_player_id) references players(id) on delete set null;

create table lines (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  role text not null check (role in ('A', 'B')),
  line_position text not null check (line_position in ('upper', 'lower')),
  round_no int not null check (round_no > 0),
  content text not null check (length(trim(content)) > 0),
  created_at timestamptz not null default now(),
  unique(room_id, player_id, round_no),
  unique(room_id, round_no, line_position)
);

create table poems (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references rooms(id) on delete cascade,
  room_code text not null,
  theme text not null default '自由创作',
  reveal_mode text not null default 'final'
    check (reveal_mode in ('final', 'round')),
  total_rounds int not null default 4 check (total_rounds > 0),
  authors text,
  poem_text text not null check (length(trim(poem_text)) > 0),
  likes_count int not null default 0 check (likes_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table poem_likes (
  id uuid primary key default gen_random_uuid(),
  poem_id uuid not null references poems(id) on delete cascade,
  user_key text not null,
  created_at timestamptz not null default now(),
  unique(poem_id, user_key)
);

create index idx_rooms_code on rooms(code);
create index idx_rooms_status on rooms(status);
create index idx_rooms_visibility_status on rooms(visibility, status, created_at desc);
create index idx_rooms_empty_since on rooms(empty_since);
create index idx_players_room_id on players(room_id);
create index idx_players_room_nickname on players(room_id, nickname);
create index idx_players_room_active on players(room_id, is_active);
create index idx_lines_room_round on lines(room_id, round_no);
create index idx_poems_likes_count on poems(likes_count desc, created_at desc);
create index idx_poems_created_at on poems(created_at desc);
create index idx_poem_likes_poem_id on poem_likes(poem_id);

alter table rooms enable row level security;
alter table players enable row level security;
alter table lines enable row level security;
alter table poems enable row level security;
alter table poem_likes enable row level security;

create policy "rooms public read" on rooms
for select using (true);

create policy "rooms public insert" on rooms
for insert with check (true);

create policy "rooms public update" on rooms
for update using (true)
with check (true);

create policy "players public read" on players
for select using (true);

create policy "players public insert" on players
for insert with check (true);

create policy "players public update" on players
for update using (true)
with check (true);

create policy "players public delete" on players
for delete using (true);

create policy "lines public read" on lines
for select using (true);

create policy "lines public insert" on lines
for insert with check (true);

create policy "lines public delete" on lines
for delete using (true);

create policy "poems public read" on poems
for select using (true);

create policy "poems public insert" on poems
for insert with check (true);

create policy "poems public update" on poems
for update using (true)
with check (true);

create policy "poem_likes public read" on poem_likes
for select using (true);

create policy "poem_likes public insert" on poem_likes
for insert with check (true);

create policy "poem_likes public delete" on poem_likes
for delete using (true);

create or replace function public.sync_poem_likes_count()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update poems
    set likes_count = likes_count + 1,
        updated_at = now()
    where id = new.poem_id;
    return new;
  elsif tg_op = 'DELETE' then
    update poems
    set likes_count = greatest(likes_count - 1, 0),
        updated_at = now()
    where id = old.poem_id;
    return old;
  end if;
  return null;
end;
$$;

create trigger trg_poem_likes_insert
after insert on poem_likes
for each row
execute function public.sync_poem_likes_count();

create trigger trg_poem_likes_delete
after delete on poem_likes
for each row
execute function public.sync_poem_likes_count();

create or replace function public.cleanup_stale_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_count integer;
begin
  update rooms
  set status = 'archived',
      updated_at = now()
  where status in ('waiting', 'playing')
    and empty_since is not null
    and empty_since <= now() - interval '1 minute';

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

grant execute on function public.cleanup_stale_rooms() to anon, authenticated;

create or replace function public.touch_room_presence(p_room_id uuid, p_player_id uuid, p_nickname text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count integer;
begin
  perform public.cleanup_stale_rooms();

  update players
  set is_active = true,
      left_at = null,
      last_seen_at = now(),
      nickname = coalesce(nullif(trim(p_nickname), ''), nickname)
  where id = p_player_id
    and room_id = p_room_id;

  select count(*) into active_count
  from players
  where room_id = p_room_id and is_active = true;

  update rooms
  set empty_since = case when active_count > 0 then null else empty_since end,
      status = case
        when status in ('closed', 'archived') then status
        when active_count >= 2 and status = 'waiting' then 'playing'
        when active_count >= 1 and status in ('waiting', 'playing') then status
        else status
      end,
      updated_at = now()
  where id = p_room_id;
end;
$$;

grant execute on function public.touch_room_presence(uuid, uuid, text) to anon, authenticated;

create or replace function public.leave_room(p_room_id uuid, p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  active_count integer;
begin
  update players
  set is_active = false,
      left_at = now(),
      last_seen_at = now()
  where id = p_player_id and room_id = p_room_id;

  select count(*) into active_count
  from players
  where room_id = p_room_id and is_active = true;

  update rooms
  set empty_since = case when active_count = 0 then now() else null end,
      status = case
        when status in ('closed', 'archived', 'finished') then status
        when active_count = 0 then 'waiting'
        else status
      end,
      updated_at = now()
  where id = p_room_id;

  perform public.cleanup_stale_rooms();
end;
$$;

grant execute on function public.leave_room(uuid, uuid) to anon, authenticated;

create or replace function public.end_room(p_room_id uuid, p_player_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  is_owner boolean;
begin
  select owner_player_id = p_player_id into is_owner
  from rooms
  where id = p_room_id;

  if coalesce(is_owner, false) then
    update rooms
    set status = 'closed',
        ended_by_owner = true,
        ended_at = now(),
        updated_at = now()
    where id = p_room_id;
    return true;
  end if;

  return false;
end;
$$;

grant execute on function public.end_room(uuid, uuid) to anon, authenticated;
