import { useEffect, useMemo, useRef, useState } from 'react';
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

// Estado inicial consistente con OutboxKind actual
const INITIAL: OutboxStatusCounts = {
  totalPending: 0,
  byKind: { abono: 0, venta: 0, no_pago: 0, mov: 0, otro: 0 } as Record<OutboxKind, number>,
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

  // Coalescer múltiples emisiones seguidas (va alineado con el throttle del outbox)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = (fn: () => void, ms = 120) => {
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      fn();
    }, ms);
  };

  const refresh = async () => {
    try {
      const next = await getOutboxCounts(); // usa mirror en memoria → rápido
      setCounts((prev) => (shallowEqualCounts(prev, next) ? prev : next));
    } catch {
      // noop
    }
  };

  useEffect(() => {
    // Carga inicial inmediata
    void refresh();

    // Suscribirse a cambios del outbox (event-driven; sin polling)
    const unsub = subscribeOutbox(() => {
      // Coalesce múltiples eventos cercanos
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
  }, []);

  return useMemo(
    () => ({
      pendingTotal: counts.totalPending,
      byKind: counts.byKind,
      refresh,
    }),
    [counts]
  );
}
