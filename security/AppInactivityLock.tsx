// security/AppInactivityLock.tsx
import React, { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { navigationRef } from '../navigation/navigationRef';
import { clearSession } from '../utils/session';

type Props = {
  /** Tiempo de inactividad antes de bloquear (ms). Default: 3min */
  idleMs?: number;
  /** Si cuenta tiempo cuando la app está inactive/background. Default: true */
  countWhileInactive?: boolean;
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

  const goToDecoy = () => {
    if (navigationRef.isReady()) {
      navigationRef.resetRoot({
        index: 0,
        routes: [{ name: 'DecoyRetro' as never }],
      });
    }
  };

  const scheduleTimer = () => {
    clearTimer();
    timerRef.current = setTimeout(async () => {
      try {
        // Limpia la sesión real (coincide con el resto de la app)
        await clearSession();
      } finally {
        // Volver al señuelo (antes del Login)
        goToDecoy();
      }
    }, idleMs);
  };

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      lastState.current = s;
      if (s === 'background' || s === 'inactive') {
        if (countWhileInactive) scheduleTimer();
      } else if (s === 'active') {
        // App vuelve a primer plano → cancelamos el timer
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
