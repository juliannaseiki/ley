import { supabase } from '@ley/auth';
import { BirthData, BirthDataRow, fromRow } from '../types/birthData';

export async function getBirthData(userId: string): Promise<BirthData | null> {
  const { data, error } = await supabase
    .from('birth_data')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle<BirthDataRow>();

  if (error) throw error;
  return data ? fromRow(data) : null;
}

export async function saveBirthData(input: {
  userId: string;
  birthDate: string;
  birthTime: string;
  birthUtc: string;
  locationName: string;
  latitude: number;
  longitude: number;
  timezone: string;
}): Promise<BirthData> {
  const { data, error } = await supabase
    .from('birth_data')
    .upsert(
      {
        user_id: input.userId,
        birth_date: input.birthDate,
        birth_time: input.birthTime,
        birth_utc: input.birthUtc,
        location_name: input.locationName,
        latitude: input.latitude,
        longitude: input.longitude,
        timezone: input.timezone,
      },
      { onConflict: 'user_id' }
    )
    .select('*')
    .single<BirthDataRow>();

  if (error) throw error;
  return fromRow(data);
}
