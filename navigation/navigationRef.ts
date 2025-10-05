// navigation/navigationRef.ts
import { createNavigationContainerRef, CommonActions } from '@react-navigation/native';
import type { RootStackParamList } from '../App';

// Ref GLOBAL tipado con tu stack
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Reset a una sola ruta (útil para forzar logout / señuelo)
export function resetTo<Name extends keyof RootStackParamList>(
  name: Name,
  params?: RootStackParamList[Name]
) {
  if (!navigationRef.isReady()) return;
  navigationRef.dispatch(
    CommonActions.reset({
      index: 0,
      routes: [{ name: name as any, params: params as any }],
    })
  );
}

// Navegar de forma segura (por si lo quieres usar en otros sitios)
export function nav<Name extends keyof RootStackParamList>(
  name: Name,
  params?: RootStackParamList[Name]
) {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate(name as any, params as any);
}
