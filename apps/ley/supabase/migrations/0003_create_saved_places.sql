-- One row per place a user has saved, sourced from a Foursquare search result (or, later, a
-- manually dropped pin — hence fsq_place_id/category being nullable rather than required).
create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  fsq_place_id text,
  name text not null,
  category text,
  latitude double precision not null,
  longitude double precision not null,
  formatted_address text,
  notes text,
  raw_metadata jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, fsq_place_id)
);

alter table public.saved_places enable row level security;

create policy "Users can view their own saved places"
  on public.saved_places for select
  using (auth.uid() = user_id);

create policy "Users can insert their own saved places"
  on public.saved_places for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own saved places"
  on public.saved_places for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own saved places"
  on public.saved_places for delete
  using (auth.uid() = user_id);
