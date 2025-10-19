import { createNavigationContainerRef, CommonActions } from '@react-navigation/native';
import type { RootStackParamList } from '../App';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * Resetea el stack y abre directamente RetroPad (señuelo).
 * Útil solo cuando el flag DECOY_FLAG ya fue limpiado.
 */
export function resetToDecoy() {
  if (!navigationRef.isReady()) return;

  navigationRef.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'DecoyRetro' as never }],
    })
  );
}

/**
 * Resetea completamente a la pantalla de Login (sin RetroPad).
 * Esto se usa después de login exitoso o de cierre normal.
 */
export function resetToLogin() {
  if (!navigationRef.isReady()) return;

  navigationRef.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'Login' as never }],
    })
  );
}

/**
 * Helper para navegar a Home después de login exitoso.
 */
export function goToHome(admin: string) {
  if (!navigationRef.isReady()) return;

  navigationRef.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: 'Home' as never, params: { admin } }],
    })
  );
}
