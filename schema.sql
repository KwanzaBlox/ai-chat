-- Выполни этот скрипт целиком в Supabase: SQL Editor -> New query -> Run

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  kind text not null check (kind in ('shared', 'private', 'duo')),
  owner uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

-- Чат "Мы вдвоём" может быть только один
create unique index if not exists one_duo_chat on public.chats (kind) where kind = 'duo';

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  author uuid references auth.users(id) on delete set null default auth.uid(),
  author_name text not null default '',
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  model text,
  status text not null default 'done' check (status in ('generating', 'done', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists messages_chat_idx on public.messages (chat_id, created_at);

alter table public.chats enable row level security;
alter table public.messages enable row level security;

-- Чаты: общие и "мы вдвоём" видят все вошедшие, личные - только владелец
drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats for select to authenticated
  using (kind in ('shared', 'duo') or owner = auth.uid());

drop policy if exists chats_insert on public.chats;
create policy chats_insert on public.chats for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists chats_delete on public.chats;
create policy chats_delete on public.chats for delete to authenticated
  using (owner = auth.uid() and kind <> 'duo');

-- Сообщения: видны, если виден чат
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages for select to authenticated
  using (exists (select 1 from public.chats c where c.id = chat_id));

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.chats c where c.id = chat_id));

drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages for update to authenticated
  using (author = auth.uid()) with check (author = auth.uid());

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages for delete to authenticated
  using (author = auth.uid());

-- Realtime (живое обновление, в том числе потоковой генерации)
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.chats;
  exception when duplicate_object then null;
  end;
end $$;
