// utils/movimientoHelper.ts
export type MovimientoTipo =
  | 'abono'
  | 'gasto_admin'
  | 'gasto_cobrador'
  | 'ingreso'
  | 'retiro'
  | 'apertura'
  | 'cierre';

// Normaliza: quita acentos, separa camelCase, pasa a minúsculas y reemplaza espacios/guiones por "_"
function normToken(raw: any): string {
  const s = String(raw ?? '')
    // separa camelCase -> "gastoAdmin" => "gasto_Admin"
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin acentos
    .toLowerCase().trim()
    .replace(/[\s\-]+/g, '_')        // espacios/guiones -> _
    .replace(/__+/g, '_');           // colapsa dobles
  return s;
}

// Mapea lo viejo a lo canónico (compatibilidad hacia atrás)
export function canonicalTipo(raw: any): MovimientoTipo | null {
  if (raw == null) return null;
  const t = normToken(raw);

  // Abonos / pagos
  if (['abono', 'pago', 'pago_diario', 'payment', 'pay'].includes(t)) return 'abono';

  // Gastos administrativos (preferencia al cierre si era ambiguo "gasto")
  if (['gasto_admin', 'gasto', 'gasto_caja', 'gasto_administrativo', 'gasto_admin_manual'].includes(t)) {
    return 'gasto_admin';
  }

  // Gasto del cobrador (no entra al cierre)
  if (['gasto_cobrador', 'gasto_cob'].includes(t)) return 'gasto_cobrador';

  // Ingresos / Retiros
  if (['ingreso', 'entrada', 'deposito'].includes(t)) return 'ingreso';
  if (['retiro', 'extraccion', 'retiro_caja', 'venta'].includes(t)) return 'retiro';

  // Aperturas (manual/auto) → apertura
  if (['apertura', 'apertura_auto', 'apertura_manual', 'aperturaauto'].includes(t)) return 'apertura';

  // Cierres (manual/auto) → cierre
  if (['cierre', 'cierre_auto', 'cierre_manual'].includes(t)) return 'cierre';

  return null;
}

export function labelFor(tipo: MovimientoTipo): string {
  switch (tipo) {
    case 'abono': return 'Abono';
    case 'gasto_admin': return 'Gasto (admin)';
    case 'gasto_cobrador': return 'Gasto (cobrador)';
    case 'ingreso': return 'Ingreso';
    case 'retiro': return 'Retiro';
    case 'apertura': return 'Apertura';
    case 'cierre': return 'Cierre';
  }
}

export function iconFor(tipo: MovimientoTipo): { name: string } {
  // MaterialCommunityIcons
  switch (tipo) {
    case 'abono': return { name: 'check-circle' };
    case 'gasto_admin': return { name: 'receipt' };
    case 'gasto_cobrador': return { name: 'account-cash' };
    case 'ingreso': return { name: 'arrow-down-circle' };
    case 'retiro': return { name: 'arrow-up-circle' };
    case 'apertura': return { name: 'lock-open-variant' };
    case 'cierre': return { name: 'lock' };
  }
}

export function toneFor(tipo: MovimientoTipo): string {
  switch (tipo) {
    case 'abono': return '#2E7D32';
    case 'ingreso': return '#2E7D32';
    case 'retiro': return '#C62828';
    case 'gasto_admin': return '#6D4C41';
    case 'gasto_cobrador': return '#546E7A';
    case 'apertura': return '#1565C0';
    case 'cierre': return '#37474F';
  }
}
