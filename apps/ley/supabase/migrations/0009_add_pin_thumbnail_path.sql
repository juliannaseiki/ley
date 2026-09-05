-- A pin can be set directly from a photo that's never added to the gallery (LEY-54's "Edit pin"
-- flow) — decoupled from pin_photo_id (which points at a saved_place_photos row) since this path
-- never creates one. Null means no standalone pin image has been set; resolution falls through to
-- pin_photo_id, then the earliest-uploaded gallery photo (see effectivePinPhotoId in
-- PlaceDetailPanel.tsx). Setting one clears pin_photo_id and vice versa, so only one is ever the
-- active source for a place's pin at a time.
alter table public.saved_places
  add column pin_thumbnail_path text;
