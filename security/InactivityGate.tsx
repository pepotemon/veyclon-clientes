// security/InactivityGate.tsx
import React, { useCallback, useEffect, useRef } from 'react';
import { AppState, Keyboard, View } from 'react-native';
import { logoutAndGoToDecoy } from '../utils/session';

type Props = {
  /** Tiempo de inactividad en ms (por defecto 3 minutos). */
  idleMs?: number;
  children: React.ReactNode;
};

export default function InactivityGate({ idleMs = 180000, children }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const loggingOutRef = useRef(false); // evita dobles llamadas

  const doLogout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    try {
      await logoutAndGoToDecoy('inactivity_timeout');
    } finally {
      // no limpiamos el flag aquí; esta pantalla normalmente se desmonta tras reset de navegación
    }
  }, []);

  const armTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void doLogout();
    }, idleMs);
  }, [idleMs, doLogout]);

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

    // background/foreground
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= idleMs) {
          void doLogout();
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
  }, [idleMs, ping, doLogout]);

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
