// hooks/useOutboxStatus.ts
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { subscribeOutbox, getOutboxCounts, OutboxKind, OutboxStatusCounts } from '../utils/outbox';

export type UseOutboxStatusResult = {
  pendingTotal: number;
  byKind: Record<'abono' | 'no_pago' | 'otro', number>;
  refresh: () => Promise<void>;
};

export default function useOutboxStatus(): UseOutboxStatusResult {
  const [counts, setCounts] = useState<OutboxStatusCounts>({
    totalPending: 0,
    byKind: { abono: 0, no_pago: 0, otro: 0 },
  });

  const refresh = async () => {
    const c = await getOutboxCounts();
    setCounts(c);
  };

  useEffect(() => {
    // carga inicial
    refresh().catch(() => {});
    // escucha cambios del outbox
    const unsub = subscribeOutbox(() => {
      refresh().catch(() => {});
    });
    return () => unsub();
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
