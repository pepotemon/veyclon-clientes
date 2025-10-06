// security/AppInactivityLock.tsx
import React, { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetTo } from '../navigation/navigationRef';

type Props = {
  idleMs?: number;            // tiempo de inactividad (ms)
  countWhileInactive?: boolean; // cuenta cuando la app está inactive/background
};

export default function AppInactivityLock({
  idleMs = 3 * 60_000,
  countWhileInactive = true,
}: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastState = useRef<AppStateStatus>(AppState.currentState);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const scheduleTimer = () => {
    clearTimer();
    timerRef.current = setTimeout(async () => {
      try {
        await AsyncStorage.removeItem('usuarioSesion');
      } finally {
        // Volver al señuelo (antes del Login)
        resetTo('DecoyRetro');
      }
    }, idleMs);
  };

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      lastState.current = s;
      if (s === 'background' || s === 'inactive') {
        if (countWhileInactive) scheduleTimer();
      } else if (s === 'active') {
        clearTimer();
      }
    });
    return () => {
      clearTimer();
      sub.remove();
    };
  }, [idleMs, countWhileInactive]);

  return null;
}
