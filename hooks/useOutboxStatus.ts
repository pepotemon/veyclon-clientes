import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  subscribeOutbox,
  getOutboxCounts,
  OutboxStatusCounts,
  OutboxKind,
} from '../utils/outbox';

export type UseOutboxStatusResult = {
  pendingTotal: number;
  byKind: Record<OutboxKind, number>;
  refresh: () => Promise<void>;
};

/** Shallow compare para evitar renders innecesarios */
function shallowEqualCounts(a: OutboxStatusCounts, b: OutboxStatusCounts) {
  if (a.totalPending !== b.totalPending) return false;
  // compara llaves conocidas
  if (a.byKind.abono !== b.byKind.abono) return false;
  if (a.byKind.venta !== b.byKind.venta) return false;
  if (a.byKind.no_pago !== b.byKind.no_pago) return false;
  if (a.byKind.mov !== b.byKind.mov) return false;
  if (a.byKind.otro !== b.byKind.otro) return false;
  return true;
}

const INITIAL: OutboxStatusCounts = {
  totalPending: 0,
  byKind: { abono: 0, venta: 0, no_pago: 0, mov: 0, otro: 0 },
};

export default function useOutboxStatus(): UseOutboxStatusResult {
  const [counts, setCounts] = useState<OutboxStatusCounts>(INITIAL);

  // Evita setState después de unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getOutboxCounts(); // usa mirror en memoria → rápido
      if (!mountedRef.current) return;
      setCounts((prev) => (shallowEqualCounts(prev, next) ? prev : next));
    } catch {
      // noop
    }
  }, []);

  // Coalescer múltiples emisiones seguidas (ligeramente > throttle interno de 150ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(
    (fn: () => void, ms = 160) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        fn();
      }, ms);
    },
    []
  );

  useEffect(() => {
    // Carga inicial inmediata
    void refresh();

    // Suscribirse a cambios del outbox (event-driven; sin polling)
    const unsub = subscribeOutbox(() => {
      schedule(() => void refresh());
    });

    return () => {
      try {
        unsub && unsub();
      } catch {}
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refresh, schedule]);

  return useMemo(
    () => ({
      pendingTotal: counts.totalPending,
      byKind: counts.byKind,
      refresh,
    }),
    [counts, refresh]
  );
}
