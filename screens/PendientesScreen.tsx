// screens/PendientesScreen.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

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

// =========================
// TIPOS **LOCALES** (renombrados a UIOutbox*) para evitar choque con utils/outbox
// =========================
type UIOutboxStatus = 'pending' | 'processing' | 'done' | 'error';

// admite español + legacy + 'mov' (del motor nuevo)
type UIKindEs = 'abono' | 'venta' | 'no_pago' | 'otro' | 'mov';
type UILegacy = 'payment' | 'other';
type UIOutboxKind = UIKindEs | UILegacy;

type UIOutboxItem = {
  id: string;
  kind: UIOutboxKind;     // ahora acepta "mov"
  createdAtMs: number;
  payload: any;

  attempts?: number;
  status?: UIOutboxStatus;
  nextRetryAt?: number;
  lastError?: string;

  // compat versiones previas
  error?: string;
};

const STORAGE_KEY = 'outbox:pending';

/** Normaliza cualquier kind legacy al canónico en español (y preserva 'mov') */
function normalizeKind(kind: UIOutboxKind): UIKindEs {
  if (kind === 'payment') return 'abono';
  if (kind === 'other') return 'otro';
  if (kind === 'mov') return 'mov';
  if (kind === 'venta' || kind === 'abono' || kind === 'no_pago' || kind === 'otro') return kind;
  return 'otro';
}

/** Píldora de estado */
function StatusPill({
  status,
  colorSet,
}: {
  status?: UIOutboxStatus;
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

/** Título “inteligente” con nombre del cliente si existe */
function getDisplayTexts(item: UIOutboxItem): { title: string; subtitle?: string } {
  const k = normalizeKind(item.kind);
  const p = item.payload || {};

  // nombre del cliente (varios fallbacks comunes en la app)
  const nombre =
    (p.clienteNombre?.trim?.() ||
      p.cajaPayload?.clienteNombre?.trim?.() ||
      p.concepto?.trim?.() ||
      p.nombre?.trim?.() ||
      '') as string;

  const fallbackId =
    (typeof p.clienteId === 'string' && p.clienteId
      ? `ID ${p.clienteId.slice(-6)}`
      : '') || 'Cliente';

  const who = nombre || fallbackId;

  // subkind para movimientos genéricos
  const sub: string | undefined = p.subkind;
  const subLabelMap: Record<string, string> = {
    ingreso: 'Ingreso',
    retiro: 'Retiro',
    gasto_admin: 'Gasto (admin)',
    gasto_cobrador: 'Gasto (cobrador)',
    apertura: 'Apertura',
    cierre: 'Cierre',
  };

  if (k === 'mov' && sub && subLabelMap[sub]) {
    return { title: `${subLabelMap[sub]} — ${who}` };
  }
  if (k === 'abono') return { title: `Pago — ${who}` };
  if (k === 'venta') return { title: `Venta — ${who}` };
  if (k === 'no_pago') return { title: `No pago — ${who}` };

  // fallback genérico
  return { title: `${k === 'otro' ? 'Otro' : k} ${nombre ? `— ${who}` : ''}` };
}

export default function PendientesScreen() {
  const { palette } = useAppTheme();

  // estados
  const [items, setItems] = useState<UIOutboxItem[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true); // 👈 carga inicial
  const [refreshing, setRefreshing] = useState(false);        // 👈 solo pull-to-refresh
  const [processing, setProcessing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('todos');

  // Carga lista desde AsyncStorage (compat) y migra kinds legacy
  const readFromStorage = useCallback(async (): Promise<UIOutboxItem[]> => {
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
      const list: UIOutboxItem[] = Array.isArray(parsed) ? parsed : [];
      const migrated = list.map((it) => ({ ...it, kind: normalizeKind(it.kind) }));
      // si hubo cambios, persistimos
      if (JSON.stringify(list) !== JSON.stringify(migrated)) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      }
      // ordenar recientes primero
      migrated.sort((a, b) => b.createdAtMs - a.createdAtMs);
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
        // refresco silencioso: no mostrar spinner
        load('silent');
      });
    } catch {
      unsubEvt = null;
    }

    // 2) Fallback: contador (si no hay emitter)
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

  const saveList = async (list: UIOutboxItem[]) => {
    setItems(list);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  };

  // Reintentar uno
  const retryOne = async (id: string) => {
    setProcessing(true);
    try {
      if (typeof processOutboxOne === 'function') {
        await processOutboxOne(id);
      } else {
        await processOutboxBatch(1);
      }
      await load('silent');
    } catch {
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
      Alert.alert('Pendientes', 'Se intentó reenviar la cola.');
    } catch {
      Alert.alert('Error', 'Ocurrió un error al reintentar la cola.');
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

  // Filtro (mantener intactos)
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

  const renderItem = ({ item }: { item: UIOutboxItem }) => {
    const statusKey: UIOutboxStatus =
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

    const { title } = getDisplayTexts(item);

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
            <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
            <StatusPill status={statusKey} colorSet={statusColors} />
          </View>

          <Text style={[styles.sub, { color: palette.softText }]}>
            {new Date(item.createdAtMs).toLocaleString()}
          </Text>

          <View style={{ marginTop: 4 }}>
            <Text style={[styles.meta, { color: palette.softText }]}>
              Intentos: {attempts}
            </Text>
            {!!nextRetryTxt && (
              <Text style={[styles.meta, { color: palette.softText }]}>
                Próximo intento: {nextRetryTxt}
              </Text>
            )}
          </View>

          {!!(item.lastError || item.error) && (
            <Text style={[styles.err, { color: '#c62828' }]}>
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
      <SafeAreaView
    style={{ flex: 1, backgroundColor: palette.screenBg }}
    edges={['left','right','bottom']}   // 👈 evita el hueco
  >
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
          <Text style={[styles.headerBtnTxt, { color: palette.text }]}>Reintentar todos</Text>
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
        // ⛔️ OJO: NO usamos <FlatList<...>> para evitar TS2558
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
  title: { fontSize: 15, fontWeight: '800' },
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
