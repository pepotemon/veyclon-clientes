// hooks/useOutboxStatus.ts
import { useEffect, useMemo, useState } from 'react';
import {
  subscribeOutbox,
  getOutboxCounts,
  OutboxStatusCounts,
  OutboxKind, // 👈 importamos la unión real para mantenernos en sync
} from '../utils/outbox';

export type UseOutboxStatusResult = {
  pendingTotal: number;
  byKind: Record<OutboxKind, number>;
  refresh: () => Promise<void>;
};

export default function useOutboxStatus(): UseOutboxStatusResult {
  const [counts, setCounts] = useState<OutboxStatusCounts>({
    totalPending: 0,
    // 👇 incluimos TODAS las llaves de OutboxKind (abono, venta, no_pago, mov, otro)
    byKind: {
      abono: 0,
      venta: 0,
      no_pago: 0,
      mov: 0,
      otro: 0,
    } as Record<OutboxKind, number>,
  });

  const refresh = async () => {
    try {
      const c = await getOutboxCounts();
      setCounts(c);
    } catch {
      // noop
    }
  };

  useEffect(() => {
    // carga inicial
    void refresh();

    // escucha cambios del outbox
    let unsub: (() => void) | undefined;
    try {
      unsub = subscribeOutbox(() => {
        void refresh();
      });
    } catch {
      unsub = undefined;
    }
    return () => {
      try { unsub && unsub(); } catch {}
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
