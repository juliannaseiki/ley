export type BirthData = {
  id: string;
  userId: string;
  birthDate: string; // YYYY-MM-DD, local calendar date at birth location
  birthTime: string; // HH:mm, local 24h time at birth location
  birthUtc: string; // ISO instant, derived from date+time+timezone
  locationName: string;
  latitude: number;
  longitude: number;
  timezone: string; // IANA zone name
  createdAt: string;
};

export type BirthDataRow = {
  id: string;
  user_id: string;
  birth_date: string;
  birth_time: string;
  birth_utc: string;
  location_name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  created_at: string;
};

export function fromRow(row: BirthDataRow): BirthData {
  return {
    id: row.id,
    userId: row.user_id,
    birthDate: row.birth_date,
    birthTime: row.birth_time,
    birthUtc: row.birth_utc,
    locationName: row.location_name,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    createdAt: row.created_at,
  };
}
