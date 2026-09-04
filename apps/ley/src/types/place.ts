export type SavedPlace = {
  id: string;
  name: string;
  category: string | null;
  formatted_address: string | null;
  latitude: number;
  longitude: number;
  pin_photo_id: string | null;
};
