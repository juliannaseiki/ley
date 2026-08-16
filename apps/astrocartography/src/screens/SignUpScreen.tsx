import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer, TextField, GradientButton, colors, fonts, spacing } from '@ley/ui';
import { useAuth } from '@ley/auth';

export function SignUpScreen({ onNavigateToLogIn }: { onNavigateToLogIn: () => void }) {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const handleSubmit = async () => {
    setError(undefined);
    if (!email.trim() || !password) {
      setError('An email and password are both needed to continue.');
      return;
    }
    if (password.length < 6) {
      setError('Password should be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      const { needsEmailConfirmation } = await signUp(email.trim(), password);
      if (needsEmailConfirmation) {
        setConfirmationSent(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong signing up.');
    } finally {
      setLoading(false);
    }
  };

  if (confirmationSent) {
    return (
      <ScreenContainer>
        <View style={styles.centered}>
          <Text style={styles.heading}>Check your email</Text>
          <Text style={styles.body}>
            A confirmation link has been sent to {email.trim()}. Once confirmed, come back and
            log in.
          </Text>
          <Pressable onPress={onNavigateToLogIn} style={styles.linkButton}>
            <Text style={styles.link}>Back to log in</Text>
          </Pressable>
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <View style={styles.top}>
        <Text style={styles.heading}>Ley</Text>
        <Text style={styles.subheading}>
          A quiet space for exploring where your chart meets the map.
        </Text>
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
          placeholder="At least 6 characters"
          error={error}
        />
        <GradientButton label="Sign up" onPress={handleSubmit} loading={loading} />
        <Pressable onPress={onNavigateToLogIn} style={styles.linkButton}>
          <Text style={styles.link}>Already have an account? Log in</Text>
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
    fontSize: 40,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  subheading: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.inkSoft,
    lineHeight: 22,
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
  centered: {
    flex: 1,
    justifyContent: 'center',
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.inkSoft,
    lineHeight: 22,
    marginTop: spacing.md,
  },
});
