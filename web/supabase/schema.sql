create table if not exists public.user_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  workspace jsonb not null,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.user_workspaces enable row level security;

create policy "users can read their own workspace"
on public.user_workspaces
for select
to authenticated
using (auth.uid() = user_id);

create policy "users can insert their own workspace"
on public.user_workspaces
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "users can update their own workspace"
on public.user_workspaces
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
