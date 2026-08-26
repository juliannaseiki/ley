-- One birth-data row per user, tied to their auth account.
create table if not exists public.birth_data (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  birth_date date not null,
  birth_time time not null,
  birth_utc timestamptz not null,
  location_name text not null,
  latitude double precision not null,
  longitude double precision not null,
  timezone text not null,
  created_at timestamptz not null default now()
);

alter table public.birth_data enable row level security;

create policy "Users can view their own birth data"
  on public.birth_data for select
  using (auth.uid() = user_id);

create policy "Users can insert their own birth data"
  on public.birth_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own birth data"
  on public.birth_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own birth data"
  on public.birth_data for delete
  using (auth.uid() = user_id);
