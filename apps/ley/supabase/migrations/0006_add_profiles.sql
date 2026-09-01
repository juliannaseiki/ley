-- One profile row per user, holding app-specific user fields (starting with `name`) that don't
-- belong on auth.users itself — same pattern as birth_data/saved_places, a public table keyed off
-- auth.users(id) rather than altering the auth schema directly.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

grant select, insert, update on public.profiles to authenticated;
