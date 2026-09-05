-- Null means "no dedicated thumbnail exists for this photo" — rows uploaded before this pipeline
-- existed fall back to storage_path (the full device-width photo) until re-uploaded. New uploads
-- always populate this alongside storage_path (see handleAddPhoto in PlaceDetailPanel.tsx).
alter table public.saved_place_photos
  add column thumbnail_path text;
