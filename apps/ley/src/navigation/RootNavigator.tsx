import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '@ley/auth';
import { SignUpScreen } from '../screens/SignUpScreen';
import { LogInScreen } from '../screens/LogInScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { colors } from '@ley/ui';

type AuthMode = 'signUp' | 'logIn';

export function RootNavigator() {
  const { session, initializing } = useAuth();
  const [authMode, setAuthMode] = useState<AuthMode>('signUp');

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

  return <HomeScreen />;
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
