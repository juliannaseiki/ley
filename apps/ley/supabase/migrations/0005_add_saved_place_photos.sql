-- Photos users attach to a saved place, stored in Supabase Storage under
-- `{user_id}/{saved_place_id}/{filename}` so storage RLS can key off the path alone. The bucket is
-- private, so this column holds storage object paths (not public URLs) — resolve to a signed URL
-- at display time.
alter table public.saved_places
  add column if not exists photo_paths text[] not null default '{}';

insert into storage.buckets (id, name, public)
values ('saved-place-photos', 'saved-place-photos', false)
on conflict (id) do nothing;

create policy "Users can view their own saved place photos"
  on storage.objects for select
  using (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can upload their own saved place photos"
  on storage.objects for insert
  with check (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Users can delete their own saved place photos"
  on storage.objects for delete
  using (
    bucket_id = 'saved-place-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
