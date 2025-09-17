import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme as NavDark, DefaultTheme as NavLight, Theme } from '@react-navigation/native';

type AppTheme = {
  isDark: boolean;
  toggleTheme: () => void;
  palette: {
    screenBg: string;
    topBg: string;
    topBorder: string;
    cardBg: string;
    cardBorder: string;
    text: string;
    softText: string;
    kpiBg: string;
    kpiTrack: string;
    divider: string;
    commBg: string;
    commBorder: string;
    accent: string;
  };
  navigationTheme: Theme; // Para NavigationContainer
};

const ThemeContext = createContext<AppTheme | null>(null);

const STORAGE_KEY = 'app:theme:isDark';

const lightPalette = {
  screenBg: '#f6f7f9',
  topBg: '#E8F5E9',
  topBorder: '#dbe7df',
  cardBg: '#ffffff',
  cardBorder: '#e5e9e6',
  text: '#243c25',
  softText: '#4b5b4c',
  kpiBg: '#ffffff',
  kpiTrack: '#ecf1ec',
  divider: '#e5e9e6',
  commBg: '#f0f3f0',
  commBorder: '#e4ebe5',
  accent: '#2e7d32',
};

const darkPalette = {
  screenBg: '#111416',
  topBg: '#161b1e',
  topBorder: '#263138',
  cardBg: '#1a1f22',
  cardBorder: '#20262a',
  text: '#eef2f5',
  softText: '#c9d1d9',
  kpiBg: '#1a1f22',
  kpiTrack: '#2a3338',
  divider: '#2a3035',
  commBg: '#1b2124',
  commBorder: '#273036',
  accent: '#2e7d32',
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false);

  // cargar preferencia guardada
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved != null) setIsDark(saved === '1');
    })();
  }, []);

  const toggleTheme = async () => {
    setIsDark(prev => {
      const next = !prev;
      AsyncStorage.setItem(STORAGE_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  };

  const palette = useMemo(() => (isDark ? darkPalette : lightPalette), [isDark]);

  // Tema para React Navigation (colores base)
  const navigationTheme: Theme = useMemo(
    () => ({
      ...(isDark ? NavDark : NavLight),
      colors: {
        ...(isDark ? NavDark.colors : NavLight.colors),
        background: palette.screenBg,
        primary: palette.accent,
        card: palette.topBg,
        text: palette.text,
        border: palette.topBorder,
      },
    }),
    [isDark, palette]
  );

  const value: AppTheme = useMemo(
    () => ({ isDark, toggleTheme, palette, navigationTheme }),
    [isDark, palette, navigationTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useAppTheme debe usarse dentro de <ThemeProvider>');
  return ctx;
}
