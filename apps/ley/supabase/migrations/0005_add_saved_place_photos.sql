-- Photos users attach to a saved place. One row per photo (rather than an array column on
-- saved_places) so concurrent uploads are independent inserts instead of a read-modify-write
-- race on a shared array, and so per-photo metadata can grow later without another migration.
create table if not exists public.saved_place_photos (
  id uuid primary key default gen_random_uuid(),
  saved_place_id uuid not null references public.saved_places (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists saved_place_photos_saved_place_id_idx
  on public.saved_place_photos (saved_place_id);

alter table public.saved_place_photos enable row level security;

create policy "Users can view their own saved place photos"
  on public.saved_place_photos for select
  using (auth.uid() = user_id);

create policy "Users can insert their own saved place photos"
  on public.saved_place_photos for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own saved place photos"
  on public.saved_place_photos for delete
  using (auth.uid() = user_id);

grant select, insert, delete on public.saved_place_photos to authenticated;

-- Photo files themselves live in Supabase Storage under `{user_id}/{saved_place_id}/{filename}`
-- (storage_path above) so storage RLS can key off the path alone.
insert into storage.buckets (id, name, public)
values ('saved-place-photos', 'saved-place-photos', false)
on conflict (id) do nothing;

create policy "Users can view their own saved place photo files"
  on storage.objects for select
  using (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can upload their own saved place photo files"
  on storage.objects for insert
  with check (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own saved place photo files"
  on storage.objects for delete
  using (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
