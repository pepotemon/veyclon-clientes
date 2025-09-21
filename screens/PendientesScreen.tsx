// screens/PendientesScreen.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppTheme } from '../theme/ThemeProvider';
import { MaterialCommunityIcons as MIcon } from '@expo/vector-icons';

// Helpers de outbox (motor nuevo + subs)
import {
  processOutboxBatch,
  processOutboxOne,
  subscribeOutbox,
  subscribeCount, // fallback si no hay emitter
} from '../utils/outbox';

type OutboxStatus = 'pending' | 'processing' | 'done' | 'error';

/** ==== TIPOS: aceptar legacy y normalizar ==== */
type KindEs = 'abono' | 'no_pago' | 'otro';
type KindLegacy = 'payment' | 'other';
type OutboxKind = KindEs | KindLegacy;

type OutboxItem = {
  id: string;
  kind: OutboxKind;       // <- acepta ambos
  createdAtMs: number;
  payload: any;

  // Campos reales del motor con backoff
  attempts?: number;
  status?: OutboxStatus;
  nextRetryAt?: number;
  lastError?: string;

  // Compat con versión previa del screen
  error?: string;
};

const STORAGE_KEY = 'outbox:pending';

/** Normaliza cualquier kind legacy al canónico en español */
function normalizeKind(kind: OutboxKind): KindEs {
  if (kind === 'payment') return 'abono';
  if (kind === 'other') return 'otro';
  return kind; // ya es 'abono' | 'no_pago' | 'otro'
}

/** Etiqueta base para UI (columna izquierda) */
function kindBaseLabel(kind: OutboxKind): 'Abono' | 'No pago' | 'Otro' {
  const k = normalizeKind(kind);
  if (k === 'abono') return 'Abono';
  if (k === 'no_pago') return 'No pago';
  return 'Otro';
}

/** Píldora de estado */
function StatusPill({
  status,
  colorSet,
}: {
  status?: OutboxStatus;
  colorSet: { text: string; border: string; bg: string };
}) {
  const label =
    status === 'processing'
      ? 'Procesando'
      : status === 'error'
      ? 'Error'
      : status === 'done'
      ? 'Hecho'
      : 'Pendiente';
  return (
    <Text
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        alignSelf: 'flex-start',
        fontSize: 11,
        fontWeight: '800',
        color: colorSet.text,
        borderColor: colorSet.border,
        backgroundColor: colorSet.bg,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {label}
    </Text>
  );
}

type FilterKey = 'todos' | 'abono' | 'no_pago' | 'otro';

export default function PendientesScreen() {
  const { palette } = useAppTheme();

  // estados
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true); // carga inicial
  const [refreshing, setRefreshing] = useState(false);        // pull-to-refresh
  const [processing, setProcessing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('todos');

  // Lee la lista desde AsyncStorage (con migración de kind)
  const readFromStorage = useCallback(async (): Promise<OutboxItem[]> => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // si se corrompió el JSON, reseteamos
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([]));
        return [];
      }
      const list: OutboxItem[] = Array.isArray(parsed) ? parsed : [];
      const migrated = list.map((it) => ({ ...it, kind: normalizeKind(it.kind) }));
      // si hubo cambios, persistimos
      if (JSON.stringify(list) !== JSON.stringify(migrated)) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      }
      // ordenar recientes primero
      migrated.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      return migrated;
    } catch {
      return [];
    }
  }, []);

  // Carga con modos: initial / pull / silent
  const load = useCallback(
    async (mode: 'initial' | 'pull' | 'silent' = 'initial') => {
      if (mode === 'initial') setLoadingInitial(true);
      if (mode === 'pull') setRefreshing(true);

      try {
        const data = await readFromStorage();
        setItems(data);
      } finally {
        if (mode === 'initial') setLoadingInitial(false);
        if (mode === 'pull') setRefreshing(false);
      }
    },
    [readFromStorage]
  );

  // Carga inicial
  useEffect(() => {
    load('initial');
  }, [load]);

  // Suscripción reactiva a cambios del outbox (silencioso)
  useEffect(() => {
    // 1) Emitter (si existe en utils/outbox)
    let unsubEvt: (() => void) | null = null;
    try {
      unsubEvt = subscribeOutbox(() => {
        load('silent');
      });
    } catch {
      unsubEvt = null;
    }

    // 2) Fallback: polling liviano (cada 1.5s) si no hay emitter
    let unsubPoll: (() => void) | null = null;
    if (!unsubEvt) {
      try {
        unsubPoll = subscribeCount(() => {
          load('silent');
        });
      } catch {
        unsubPoll = null;
      }
    }

    return () => {
      if (unsubEvt) unsubEvt();
      if (unsubPoll) unsubPoll();
    };
  }, [load]);

  const saveList = async (list: OutboxItem[]) => {
    setItems(list);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  };

  // Reintentar uno (preferir motor nuevo)
  const retryOne = async (id: string) => {
    setProcessing(true);
    try {
      if (typeof processOutboxOne === 'function') {
        await processOutboxOne(id);
      } else {
        await processOutboxBatch(1);
      }
      await load('silent');
    } catch (e: any) {
      Alert.alert('Reintento', 'No se pudo reenviar este elemento.');
    } finally {
      setProcessing(false);
    }
  };

  const retryAll = async () => {
    if (!items.length) return;
    setProcessing(true);
    try {
      await processOutboxBatch(100);
      await load('silent');
      Alert.alert('Pendientes', 'Se intentó enviar la cola.');
    } catch {
      Alert.alert('Error', 'Ocurrió un error al enviar la cola.');
    } finally {
      setProcessing(false);
    }
  };

  const removeOne = async (id: string) => {
    const list = items.filter((x) => x.id !== id);
    await saveList(list);
  };

  const clearAll = async () => {
    Alert.alert('Vaciar cola', '¿Eliminar todos los pendientes?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Vaciar',
        style: 'destructive',
        onPress: async () => {
          await saveList([]);
        },
      },
    ]);
  };

  // Filtro
  const filtered = useMemo(() => {
    if (filter === 'todos') return items;
    return items.filter((it) => normalizeKind(it.kind) === filter);
  }, [items, filter]);

  const nowMs = Date.now();
  const formatNextRetry = (ts?: number) => {
    if (!ts || !Number.isFinite(ts)) return null;
    if (ts <= nowMs) return 'Listo para reintentar';
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return String(ts);
    }
  };

  const colors = useMemo(
    () => ({
      status: {
        pending: { text: palette.text, border: palette.cardBorder, bg: palette.cardBg },
        processing: { text: '#1565C0', border: '#90CAF9', bg: '#E3F2FD' },
        error: { text: '#B71C1C', border: '#FFCDD2', bg: '#FFEBEE' },
        done: { text: '#1B5E20', border: '#C8E6C9', bg: '#E8F5E9' },
      },
    }),
    [palette]
  );

  // ======== Formateo Display por ítem (Título + detalles) ========
  function getDisplayTexts(it: OutboxItem): {
    title: string;
    line1?: string;
    line2?: string;
    icon: string; // usar string para evitar fricciones de tipos con glyphMap
  } {
    const k = normalizeKind(it.kind);
    const p = it.payload || {};
    const tipo = (p.tipo || p._subkind || k) as string // 'venta' | 'retiro' | 'ingreso' | 'gasto' | 'abono' | 'no_pago' | 'otro'
    const monto: number | undefined =
      typeof p.monto === 'number'
        ? p.monto
        : typeof p.valor === 'number'
        ? p.valor
        : undefined;

    const money =
      typeof monto === 'number' && Number.isFinite(monto)
        ? `Monto: R$ ${monto.toFixed(2)}`
        : undefined;

    const fecha = it.createdAtMs ? new Date(it.createdAtMs).toLocaleString() : undefined;
    const cliente = p.clienteNombre || p.nombre || p.cliente || undefined;
    const concepto = p.concepto || p.nota || p.descripcion || p.detalle;

    if (tipo === 'abono') {
      return {
        title: `Pago — ${cliente || '—'}`,
        line1: money,
        line2: fecha,
        icon: 'check-circle',
      };
    }
    if (tipo === 'venta') {
      return {
        title: `Venta — ${cliente || '—'}`,
        line1: money ?? (concepto ? `Concepto: ${concepto}` : undefined),
        line2: fecha,
        icon: 'cart-arrow-down',
      };
    }
    if (tipo === 'retiro') {
      return {
        title: `Retiro — ${cliente || '—'}`,
        line1: money,
        line2: fecha,
        icon: 'cash-minus',
      };
    }
    if (tipo === 'ingreso') {
      const who = cliente || concepto || '—';
      return {
        title: `Ingreso — ${who}`,
        line1: money,
        line2: fecha,
        icon: 'cash-plus',
      };
    }
    if (tipo === 'gasto') {
      const who = cliente || concepto || '—';
      return {
        title: `Gasto — ${who}`,
        line1: money,
        line2: fecha,
        icon: 'cash-remove',
      };
    }
    if (tipo === 'no_pago') {
      return {
        title: `No pago — ${cliente || '—'}`,
        line1: p.reason ? `Motivo: ${p.reason}` : undefined,
        line2: fecha,
        icon: 'alert-circle-outline',
      };
    }

    // Fallback genérico
    return {
      title: `${kindBaseLabel(k)} — ${cliente || concepto || '—'}`,
      line1: money,
      line2: fecha,
      icon: 'dots-horizontal',
    };
  }

  const renderItem = ({ item }: { item: OutboxItem }) => {
    const statusKey: OutboxStatus =
      item.status === 'processing'
        ? 'processing'
        : item.status === 'error'
        ? 'error'
        : item.status === 'done'
        ? 'done'
        : 'pending';

    const statusColors = colors.status[statusKey];
    const nextRetryTxt = formatNextRetry(item.nextRetryAt);
    const attempts = item.attempts ?? 0;

    const display = getDisplayTexts(item);

    return (
      <View
        style={[
          styles.card,
          {
            backgroundColor: palette.cardBg,
            borderColor: palette.cardBorder,
          },
        ]}
      >
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <MIcon name={display.icon as any} size={18} color={palette.text} />
              <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
                {display.title}
              </Text>
            </View>
            <StatusPill status={statusKey} colorSet={statusColors} />
          </View>

          {!!display.line1 && (
            <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
              {display.line1}
            </Text>
          )}
          {!!display.line2 && (
            <Text style={[styles.sub, { color: palette.softText }]} numberOfLines={1}>
              {display.line2}
            </Text>
          )}

          <View style={{ marginTop: 4 }}>
            <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
              Intentos: {attempts}
            </Text>
            {!!nextRetryTxt && (
              <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
                Próximo intento: {nextRetryTxt}
              </Text>
            )}
          </View>

          {!!(item.lastError || item.error) && (
            <Text style={[styles.err, { color: '#c62828' }]} numberOfLines={2}>
              Último error: {item.lastError || item.error}
            </Text>
          )}
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.iconBtn, { borderColor: palette.cardBorder }]}
            onPress={() => retryOne(item.id)}
            disabled={processing}
          >
            <MIcon name="refresh" size={18} color={palette.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconBtn, { borderColor: palette.cardBorder }]}
            onPress={() => removeOne(item.id)}
            disabled={processing}
          >
            <MIcon name="delete" size={18} color={palette.text} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // Barra de filtros (chips)
  const FilterChip = ({ value, label, icon }: { value: FilterKey; label: string; icon: string }) => {
    const active = filter === value;
    return (
      <TouchableOpacity
        onPress={() => setFilter(value)}
        activeOpacity={0.85}
        style={[
          styles.chip,
          {
            backgroundColor: active ? palette.topBg : palette.cardBg,
            borderColor: active ? palette.accent : palette.cardBorder,
          },
        ]}
      >
        <MIcon name={icon as any} size={14} color={active ? palette.accent : palette.text} />
        <Text
          style={[
            styles.chipTxt,
            { color: active ? palette.accent : palette.text },
          ]}
        >
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header de acciones rápidas */}
      <View
        style={[
          styles.header,
          { borderBottomColor: palette.topBorder, backgroundColor: palette.topBg },
        ]}
      >
        <TouchableOpacity
          style={[styles.headerBtn, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          onPress={retryAll}
          disabled={!items.length || processing}
          activeOpacity={0.85}
        >
          <MIcon name="backup-restore" size={18} color={palette.text} />
          <Text style={[styles.headerBtnTxt, { color: palette.text }]}>Enviar todos</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.headerBtn, { backgroundColor: palette.cardBg, borderColor: palette.cardBorder }]}
          onPress={clearAll}
          disabled={!items.length || processing}
          activeOpacity={0.85}
        >
          <MIcon name="delete-sweep" size={18} color={palette.text} />
          <Text style={[styles.headerBtnTxt, { color: palette.text }]}>Vaciar cola</Text>
        </TouchableOpacity>
      </View>

      {/* Filtros */}
      <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, flexDirection: 'row', gap: 8 }}>
        <FilterChip value="todos" label="Todos" icon="select-all" />
        <FilterChip value="abono" label="Abonos" icon="check-circle" />
        <FilterChip value="no_pago" label="No pago" icon="alert-circle-outline" />
        <FilterChip value="otro" label="Otros" icon="dots-horizontal" />
      </View>

      {/* Contenido */}
      {loadingInitial ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', marginTop: 24 }}>
              <Text style={{ color: palette.softText }}>
                {filter === 'todos' ? 'No hay pendientes para enviar.' : 'No hay items en este filtro.'}
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load('pull')}
              tintColor={palette.text}
              titleColor={palette.text}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  headerBtnTxt: { fontWeight: '700' },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipTxt: { fontSize: 12, fontWeight: '800' },

  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: { fontSize: 15, fontWeight: '800', maxWidth: 220 },
  sub: { fontSize: 12, marginTop: 2 },
  meta: { fontSize: 12, marginTop: 2 },
  err: { fontSize: 12, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginLeft: 10 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
