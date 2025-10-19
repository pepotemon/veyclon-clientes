// utils/firestoreFallback.ts
import {
  onSnapshot,
  getDocs,
  type Query,
  type QuerySnapshot,
  type DocumentData,
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore';

/**
 * Suscribe a `qMain`. Si aparece `failed-precondition` (falta índice),
 * intenta con `qFallback`. Si tampoco hay fallback, hace un `getDocs(qMain)`
 * y llama una vez a `onNext`. Siempre devuelve un Unsubscribe seguro.
 */
export function onSnapshotWithFallback<T = DocumentData>(
  qMain: Query<T>,
  qFallback: Query<T> | null = null,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (err: FirestoreError) => void
): Unsubscribe {
  const next: (s: QuerySnapshot<T>) => void = onNext ?? (() => {});
  const errCb: (e: FirestoreError) => void = onError ?? (() => {});

  let unsub: Unsubscribe | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const attach = (q: Query<T>) => {
    // Limpia suscripción previa si la hubiera
    try { unsub?.(); } catch {}
    unsub = onSnapshot(
      q,
      next,
      (err) => {
        // Índice faltante → usar fallback o lectura única
        if (err?.code === 'failed-precondition') {
          if (qFallback) {
            try { unsub?.(); } catch {}
            unsub = onSnapshot(qFallback, next, errCb);
          } else {
            // Sin fallback: lectura única para no romper la UI
            getDocs(q)
              .then((snap) => next(snap))
              .catch((e) => errCb(e as FirestoreError));
          }
          return;
        }

        // Errores transitorios → reintento corto
        if (err?.code === 'unavailable' || err?.code === 'resource-exhausted') {
          clearRetry();
          retryTimer = setTimeout(() => {
            clearRetry();
            try {
              attach(q); // reintenta misma query
            } catch (e) {
              errCb((e as FirestoreError) || err);
            }
          }, 500); // retardo corto
          return;
        }

        // Otros errores → propagar
        errCb(err);
      }
    );
  };

  try {
    attach(qMain);
  } catch (e: any) {
    if (e?.code === 'failed-precondition') {
      if (qFallback) {
        attach(qFallback);
      } else {
        // Último intento: fetch único
        getDocs(qMain)
          .then((snap) => next(snap))
          .catch((err) => errCb(err as FirestoreError));
      }
    } else {
      errCb(e as FirestoreError);
    }
  }

  // Siempre devolver un unsubscribe que limpie todo
  return () => {
    clearRetry();
    try { unsub?.(); } catch {}
  };
}

/**
 * Lectura única con fallback si hay `failed-precondition`.
 * Si no hay fallback, el error se propaga.
 */
export async function getDocsWithFallback<T = DocumentData>(
  qMain: Query<T>,
  qFallback: Query<T> | null = null
) {
  try {
    return await getDocs(qMain);
  } catch (err: any) {
    if (err?.code === 'failed-precondition' && qFallback) {
      return await getDocs(qFallback);
    }
    throw err;
  }
}
