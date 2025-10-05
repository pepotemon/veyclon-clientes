// security/InactivityGate.tsx
import React, { useCallback, useEffect, useRef } from 'react';
import { AppState, Keyboard, View } from 'react-native';
import { navigationRef } from '../navigation/navigationRef';
import { logoutAndGoToDecoy } from '../utils/session';

type Props = {
  idleMs?: number;           // por defecto 3 minutos
  children: React.ReactNode;
};

export default function InactivityGate({ idleMs = 180000, children }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now()); // marca de última interacción

  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (navigationRef.isReady()) {
        await logoutAndGoToDecoy(navigationRef);
      }
    }, idleMs);
  }, [idleMs]);

  const ping = useCallback(() => {
    lastActivityRef.current = Date.now();
    armTimer();
  }, [armTimer]);

  useEffect(() => {
    // arranque
    armTimer();

    // teclado también cuenta como actividad
    const k1 = Keyboard.addListener('keyboardDidShow', ping);
    const k2 = Keyboard.addListener('keyboardDidHide', ping);

    // al ir/volver de background
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= idleMs) {
          if (navigationRef.isReady()) logoutAndGoToDecoy(navigationRef);
        } else {
          ping();
        }
      } else {
        // marcamos cuándo salió al background / se apagó pantalla
        lastActivityRef.current = Date.now();
      }
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      try { k1.remove(); k2.remove(); sub.remove(); } catch {}
    };
  }, [idleMs, ping]);

  return (
    <View
      style={{ flex: 1 }}
      // Captura global de interacción táctil (antes que los hijos)
      onStartShouldSetResponderCapture={() => { ping(); return false; }}
      onTouchStart={ping}
    >
      {children}
    </View>
  );
}
