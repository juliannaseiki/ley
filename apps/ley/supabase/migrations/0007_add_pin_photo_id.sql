-- Null means "use the earliest-uploaded photo" (the default, Pinterest-style cover photo
-- behavior) — a set value is an explicit user override. on delete set null (not cascade) so
-- deleting the currently pinned photo just falls back to the default rather than being blocked
-- or taking the saved_places row down with it.
alter table public.saved_places
  add column pin_photo_id uuid references public.saved_place_photos (id) on delete set null;
