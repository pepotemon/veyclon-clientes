// components/InformeDiario.tsx
import React, { memo, useCallback, useMemo, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, TouchableOpacity, StyleSheet, ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePickerModal from 'react-native-modal-datetime-picker';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useAppTheme } from '../theme/ThemeProvider';
import type { MovimientoItem } from '../utils/useMovimientos';
import { normYYYYMMDD } from '../utils/timezone';

type Props = {
  titulo: string;
  kpiLabel: string;
  icon?: string;                 // nombre de ícono (MaterialCommunityIcons)
  fecha: string;                 // YYYY-MM-DD
  onChangeFecha: (ymd: string) => void;
  items: MovimientoItem[];
  total: number;
  loading: boolean;
  emptyText?: string;            // texto vacío opcional
  onRefresh?: () => void | Promise<void>; // pull-to-refresh opcional
  onEndReached?: () => void | Promise<void>; // paginado opcional
};

/** ===== Row (memorizada) ===== */
type RowProps = {
  item: MovimientoItem;
  iconName: string;
  palette: ReturnType<typeof useAppTheme>['palette'];
};

const Row = memo(function Row({ item, iconName, palette }: RowProps) {
  const metaRight = useMemo(() => {
    const nota = item.nota?.trim();
    const cat  = item.categoria?.trim();
    if (nota) return `${item.hora} • ${nota}`;
    if (cat)  return `${item.hora} • ${cat}`;
    return `Hora: ${item.hora}`;
  }, [item.hora, item.nota, item.categoria]);

  return (
    <View style={[styles.card, { backgroundColor: palette.cardBg, shadowColor: palette.text }]}>
      <View style={[styles.iconBox, { borderColor: palette.cardBorder, backgroundColor: palette.kpiTrack }]}>
        <Icon name={iconName} size={18} color={palette.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.nombre, { color: palette.text }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.meta, { color: palette.softText }]} numberOfLines={1}>
          {metaRight}
        </Text>
      </View>
      <Text style={[styles.monto, { color: palette.text }]}>R$ {Number(item.monto || 0).toFixed(2)}</Text>
    </View>
  );
});

function safeMoney(n: number) {
  const v = Number.isFinite(n) ? n : 0;
  return `R$ ${v.toFixed(2)}`;
}

export default function InformeDiario({
  titulo,
  kpiLabel,
  icon = 'cash',
  fecha,
  onChangeFecha,
  items,
  total,
  loading,
  emptyText = 'No hay registros para esta fecha.',
  onRefresh,
  onEndReached,
}: Props) {
  const { palette } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [mostrarPicker, setMostrarPicker] = useState(false);

  const openPicker = () => setMostrarPicker(true);
  const closePicker = () => setMostrarPicker(false);
  const onConfirm = (d: Date) => {
    onChangeFecha(normYYYYMMDD(d.toISOString()));
    closePicker();
  };

  // memo: keyExtractor y renderItem
  const keyExtractor = useCallback((it: MovimientoItem, idx: number) => it.id || String(idx), []);
  const renderItem = useCallback<ListRenderItem<MovimientoItem>>(
    ({ item }) => <Row item={item} iconName={icon} palette={palette} />,
    [icon, palette]
  );

  const ListEmpty = useMemo(
    () => (
      <View style={{ alignItems: 'center', marginTop: 24 }}>
        <Text style={{ color: palette.softText }}>{emptyText}</Text>
      </View>
    ),
    [emptyText, palette.softText]
  );

  return (
    <View style={{ flex: 1, backgroundColor: palette.screenBg }}>
      {/* Header simple */}
      <View style={[styles.header, { borderBottomColor: palette.topBorder }]}>
        <Text style={[styles.title, { color: palette.text }]}>{titulo}</Text>
      </View>

      {/* KPIs + selector de fecha */}
      <View style={[styles.kpiCard, { backgroundColor: palette.kpiBg }]}>
        <View style={styles.kpiRow}>
          <Text style={[styles.kpiLabel, { color: palette.softText }]}>Registros</Text>
          <Text style={[styles.kpiValue, { color: palette.text }]}>{items.length}</Text>
        </View>
        <View style={styles.kpiRow}>
          <Text style={[styles.kpiLabel, { color: palette.softText }]}>{kpiLabel}</Text>
          <Text style={[styles.kpiValue, { color: palette.text }]}>{safeMoney(total)}</Text>
        </View>

        <TouchableOpacity
          onPress={openPicker}
          activeOpacity={0.85}
          style={[styles.dateBtn, { borderColor: palette.topBorder, backgroundColor: palette.topBg }]}
        >
          <Icon name="calendar" size={18} color={palette.accent} />
          <Text style={[styles.dateTxt, { color: palette.accent }]}>{fecha}</Text>
        </TouchableOpacity>
      </View>

      {/* Lista */}
      {loading && !onRefresh ? (
        <ActivityIndicator size="large" style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ListEmptyComponent={ListEmpty}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16 + insets.bottom }}
          // Pull-to-refresh (opcional)
          refreshing={!!onRefresh && loading}
          onRefresh={onRefresh}
          // Tuning de rendimiento
          initialNumToRender={16}
          maxToRenderPerBatch={24}
          updateCellsBatchingPeriod={50}
          windowSize={7}
          removeClippedSubviews
          // Paginación opcional (solo si viene handler)
          onEndReached={onEndReached ? () => void onEndReached() : undefined}
          onEndReachedThreshold={onEndReached ? 0.6 : undefined}
        />
      )}

      <DateTimePickerModal
        isVisible={mostrarPicker}
        mode="date"
        onConfirm={onConfirm}
        onCancel={closePicker}
        maximumDate={new Date()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingVertical: 10, alignItems: 'center', borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '800' },
  kpiCard: { margin: 12, borderRadius: 12, padding: 12 },
  kpiRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  kpiLabel: { fontSize: 12, fontWeight: '700' },
  kpiValue: { fontSize: 16, fontWeight: '900' },
  dateBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dateTxt: { fontWeight: '800', fontSize: 12 },
  card: {
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 1,
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  nombre: { fontSize: 14, fontWeight: '800' },
  meta: { fontSize: 12, marginTop: 2 },
  monto: { fontSize: 13, fontWeight: '800' },
});
