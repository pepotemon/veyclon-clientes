// navigation/navigationRef.ts
import { createNavigationContainerRef, CommonActions } from '@react-navigation/native';
import type { RootStackParamList } from '../App'; // solo tipos, evita ciclos en runtime

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export function resetToDecoy() {
  if (navigationRef.isReady()) {
    navigationRef.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: 'DecoyRetro' as never }],
      })
    );
  }
}
