import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { DateTime } from 'luxon';
import tzlookup from 'tz-lookup';
import { ScreenContainer } from '../components/ScreenContainer';
import { TextField } from '../components/TextField';
import { GradientButton } from '../components/GradientButton';
import { useAuth } from '../context/AuthContext';
import { saveBirthData } from '../lib/birthData';
import { searchPlaces, PlaceResult } from '../lib/geocode';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { BirthData } from '../types/birthData';
import { colors, fonts, radii, spacing } from '../theme';

function formatDate(date: Date) {
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function BirthDataScreen({ onSaved }: { onSaved: (data: BirthData) => void }) {
  const { session } = useAuth();

  const [birthDate, setBirthDate] = useState<Date | null>(null);
  const [birthTime, setBirthTime] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const [locationQuery, setLocationQuery] = useState('');
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debouncedQuery = useDebouncedValue(locationQuery, 450);

  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (selectedPlace && debouncedQuery === selectedPlace.displayName) {
      setPlaces([]);
      return;
    }
    if (debouncedQuery.trim().length < 3) {
      setPlaces([]);
      return;
    }
    setSearching(true);
    searchPlaces(debouncedQuery)
      .then((results) => {
        if (!cancelled) setPlaces(results);
      })
      .catch(() => {
        if (!cancelled) setPlaces([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, selectedPlace]);

  const canSubmit = Boolean(birthDate && birthTime && selectedPlace) && !saving;

  const handleSubmit = async () => {
    if (!birthDate || !birthTime || !selectedPlace || !session?.user) return;
    setError(undefined);
    setSaving(true);
    try {
      const timezone = tzlookup(selectedPlace.latitude, selectedPlace.longitude);
      const local = DateTime.fromObject(
        {
          year: birthDate.getFullYear(),
          month: birthDate.getMonth() + 1,
          day: birthDate.getDate(),
          hour: birthTime.getHours(),
          minute: birthTime.getMinutes(),
        },
        { zone: timezone }
      );
      if (!local.isValid) {
        throw new Error('That date and time could not be understood.');
      }

      const saved = await saveBirthData({
        userId: session.user.id,
        birthDate: local.toFormat('yyyy-MM-dd'),
        birthTime: local.toFormat('HH:mm'),
        birthUtc: local.toUTC().toISO()!,
        locationName: selectedPlace.displayName,
        latitude: selectedPlace.latitude,
        longitude: selectedPlace.longitude,
        timezone,
      });
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your birth details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScreenContainer>
      <View style={styles.top}>
        <Text style={styles.heading}>Your birth details</Text>
        <Text style={styles.subheading}>
          These three details are what the chart is drawn from. An exact time makes the angles
          (and the map) meaningful, so there isn&apos;t a way to skip it for now.
        </Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Date of birth</Text>
        <Pressable style={styles.pickerField} onPress={() => setShowDatePicker(true)}>
          <Text style={birthDate ? styles.pickerValue : styles.pickerPlaceholder}>
            {birthDate ? formatDate(birthDate) : 'Select a date'}
          </Text>
        </Pressable>
        {showDatePicker && (
          <View>
            {Platform.OS === 'ios' && (
              <View style={styles.pickerHeader}>
                <Pressable onPress={() => setShowDatePicker(false)}>
                  <Text style={styles.pickerHeaderAction}>Done</Text>
                </Pressable>
              </View>
            )}
            <DateTimePicker
              value={birthDate ?? new Date(2000, 0, 1)}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              maximumDate={new Date()}
              onChange={(event, date) => {
                if (Platform.OS === 'android') setShowDatePicker(false);
                if (event.type !== 'dismissed' && date) setBirthDate(date);
              }}
            />
          </View>
        )}

        <Text style={styles.label}>Time of birth</Text>
        <Pressable style={styles.pickerField} onPress={() => setShowTimePicker(true)}>
          <Text style={birthTime ? styles.pickerValue : styles.pickerPlaceholder}>
            {birthTime ? formatTime(birthTime) : 'Select the exact time'}
          </Text>
        </Pressable>
        {showTimePicker && (
          <View>
            {Platform.OS === 'ios' && (
              <View style={styles.pickerHeader}>
                <Pressable onPress={() => setShowTimePicker(false)}>
                  <Text style={styles.pickerHeaderAction}>Done</Text>
                </Pressable>
              </View>
            )}
            <DateTimePicker
              value={birthTime ?? new Date(2000, 0, 1, 12, 0)}
              mode="time"
              is24Hour={false}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event, date) => {
                if (Platform.OS === 'android') setShowTimePicker(false);
                if (event.type !== 'dismissed' && date) setBirthTime(date);
              }}
            />
          </View>
        )}

        <TextField
          label="Place of birth"
          value={locationQuery}
          onChangeText={(text) => {
            setLocationQuery(text);
            if (selectedPlace && text !== selectedPlace.displayName) setSelectedPlace(null);
          }}
          placeholder="City, region, country"
        />
        {searching && <ActivityIndicator style={styles.searchSpinner} color={colors.inkSoft} />}
        {places.length > 0 && (
          <View style={styles.resultsList}>
            {places.map((place) => (
              <Pressable
                key={place.id}
                style={styles.resultItem}
                onPress={() => {
                  setSelectedPlace(place);
                  setLocationQuery(place.displayName);
                  setPlaces([]);
                }}
              >
                <Text style={styles.resultText}>{place.displayName}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <GradientButton
          label="Continue"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={saving}
          style={styles.submit}
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  top: {
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  heading: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 30,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  subheading: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.inkSoft,
    lineHeight: 21,
  },
  form: {
    flex: 1,
  },
  label: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.inkSoft,
    marginBottom: spacing.xs,
  },
  pickerField: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: colors.panelBackground,
    marginBottom: spacing.md,
  },
  pickerValue: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.ink,
  },
  pickerPlaceholder: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.inkSoft,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: spacing.xs,
  },
  pickerHeaderAction: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    color: colors.ink,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  searchSpinner: {
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
    alignSelf: 'flex-start',
  },
  resultsList: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.md,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
    overflow: 'hidden',
    backgroundColor: colors.panelBackground,
  },
  resultItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  resultText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.ink,
  },
  error: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.error,
    marginBottom: spacing.md,
  },
  submit: {
    marginTop: spacing.md,
  },
});
