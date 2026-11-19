create table public.player_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 131072),
  revision integer not null default 0 check (revision >= 0)
);

alter table public.player_saves enable row level security;
revoke all on public.player_saves from anon;
grant select, insert, update on public.player_saves to authenticated;
create policy "read own save" on public.player_saves for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert own save" on public.player_saves for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own save" on public.player_saves for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
