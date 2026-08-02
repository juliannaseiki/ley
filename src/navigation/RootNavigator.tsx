import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { getBirthData } from '../lib/birthData';
import { BirthData } from '../types/birthData';
import { SignUpScreen } from '../screens/SignUpScreen';
import { LogInScreen } from '../screens/LogInScreen';
import { BirthDataScreen } from '../screens/BirthDataScreen';
import { GlobeScreen } from '../screens/GlobeScreen';
import { colors } from '../theme';

type AuthMode = 'signUp' | 'logIn';

export function RootNavigator() {
  const { session, initializing } = useAuth();
  const [authMode, setAuthMode] = useState<AuthMode>('signUp');
  const [birthData, setBirthData] = useState<BirthData | null | undefined>(undefined);

  useEffect(() => {
    if (!session?.user) {
      setBirthData(undefined);
      return;
    }
    let cancelled = false;
    getBirthData(session.user.id)
      .then((data) => {
        if (!cancelled) setBirthData(data);
      })
      .catch(() => {
        if (!cancelled) setBirthData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  if (initializing) {
    return <Loading />;
  }

  if (!session) {
    return authMode === 'signUp' ? (
      <SignUpScreen onNavigateToLogIn={() => setAuthMode('logIn')} />
    ) : (
      <LogInScreen onNavigateToSignUp={() => setAuthMode('signUp')} />
    );
  }

  if (birthData === undefined) {
    return <Loading />;
  }

  if (birthData === null) {
    return <BirthDataScreen onSaved={(data) => setBirthData(data)} />;
  }

  return <GlobeScreen birthData={birthData} />;
}

function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.inkSoft} />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
