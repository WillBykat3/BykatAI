-- BykatAI: conversations, messages and private file attachments.
-- Every row belongs to one user; Row Level Security keeps users to their own data.

-- ───────────── Tables ─────────────
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'New chat',
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role             text not null check (role in ('user', 'model')),
  content          text not null default '',
  -- [{ "path": "<uid>/<uuid>/file.png", "name": "file.png", "mime_type": "image/png", "size": 1234 }]
  attachments      jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index if not exists messages_user_idx on public.messages (user_id);

grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;

-- ───────────── Row Level Security ─────────────
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy "Users read own conversations" on public.conversations
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create own conversations" on public.conversations
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update own conversations" on public.conversations
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own conversations" on public.conversations
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read own messages" on public.messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add messages to own conversations" on public.messages
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "Users update own messages" on public.messages
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own messages" on public.messages
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ───────────── Keep conversations.updated_at fresh ─────────────
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;
revoke execute on function public.touch_conversation() from public, anon, authenticated;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ───────────── Storage: private attachments bucket ─────────────
-- Files live at <user id>/<random>/<file name>; users can only touch their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 10485760)
on conflict (id) do nothing;

create policy "Users read own attachments" on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload own attachments" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users delete own attachments" on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
