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
 * Suscribe a `qMain`. Si aparece `failed-precondition` (índice faltante),
 * intenta con `qFallback`. Si tampoco hay fallback, hace un `getDocs(qMain)`
 * y llama una vez a `onNext`. Siempre pasa callbacks válidos a onSnapshot.
 */
export function onSnapshotWithFallback<T = DocumentData>(
  qMain: Query<T>,
  qFallback: Query<T> | null,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (err: FirestoreError) => void
): Unsubscribe {
  const next: (s: QuerySnapshot<T>) => void = onNext ?? (() => {});
  const errCb: (e: FirestoreError) => void = onError ?? (() => {});
  let unsub: Unsubscribe | null = null;

  const attach = (q: Query<T>) => {
    unsub = onSnapshot(
      q,
      next,
      (err) => {
        if (err?.code === 'failed-precondition') {
          if (qFallback) {
            try { unsub?.(); } catch {}
            unsub = onSnapshot(qFallback, next, errCb);
          } else {
            // Sin fallback: hacemos una lectura única para no romper la UI
            getDocs(q)
              .then((snap) => next(snap))
              .catch((e) => errCb(e as FirestoreError));
          }
          return;
        }
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
      throw e;
    }
  }

  return () => {
    try { unsub?.(); } catch {}
  };
}

/**
 * Lectura única con fallback si hay `failed-precondition`.
 */
export async function getDocsWithFallback<T = DocumentData>(
  qMain: Query<T>,
  qFallback: Query<T> | null
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
