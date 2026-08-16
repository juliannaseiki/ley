import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer, TextField, GradientButton, colors, fonts, spacing } from '@ley/ui';
import { useAuth } from '@ley/auth';

export function LogInScreen({ onNavigateToSignUp }: { onNavigateToSignUp: () => void }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError(undefined);
    if (!email.trim() || !password) {
      setError('An email and password are both needed to continue.');
      return;
    }
    setLoading(true);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong logging in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScreenContainer>
      <View style={styles.top}>
        <Text style={styles.heading}>Welcome back</Text>
        <Text style={styles.subheading}>Log in to keep exploring the globe.</Text>
      </View>
      <View style={styles.form}>
        <TextField
          label="Email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
        />
        <TextField
          label="Password"
          secureTextEntry
          autoCapitalize="none"
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          error={error}
        />
        <GradientButton label="Log in" onPress={handleSubmit} loading={loading} />
        <Pressable onPress={onNavigateToSignUp} style={styles.linkButton}>
          <Text style={styles.link}>New here? Create an account</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  top: {
    marginTop: spacing.xxl,
    marginBottom: spacing.xl,
  },
  heading: {
    fontFamily: fonts.headingSemiBold,
    fontSize: 32,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  subheading: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.inkSoft,
  },
  form: {
    flex: 1,
  },
  linkButton: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  link: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.inkSoft,
  },
});
