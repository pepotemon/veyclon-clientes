// utils/movimientoHelper.ts
export type MovimientoTipo =
  | 'apertura'
  | 'cierre'
  | 'abono'           // incluye alias: pago
  | 'ingreso'         // alias: entrada, deposito
  | 'retiro'          // alias: withdrawal
  | 'gasto_admin'     // alias: gastoAdmin
  | 'gasto_cobrador'  // alias: gasto, gastoCobrador
  | 'prestamo';       // alias: venta, préstamo

const NORMALIZADORES: Record<string, MovimientoTipo> = {
  // canónicos
  apertura: 'apertura',
  cierre: 'cierre',
  abono: 'abono',
  ingreso: 'ingreso',
  retiro: 'retiro',
  gasto_admin: 'gasto_admin',
  gasto_cobrador: 'gasto_cobrador',
  prestamo: 'prestamo',

  // alias comunes / legacy
  pago: 'abono',
  pagos: 'abono',
  'pago-abono': 'abono',

  entrada: 'ingreso',
  deposito: 'ingreso',
  depósito: 'ingreso',

  withdrawal: 'retiro',

  gasto: 'gasto_cobrador',
  gastocobrador: 'gasto_cobrador',
  'gasto-cobrador': 'gasto_cobrador',

  gastoadmin: 'gasto_admin',
  'gasto-admin': 'gasto_admin',
  gastoAdmin: 'gasto_admin' as any, // por si llega camel

  venta: 'prestamo',
  ventas: 'prestamo',
  préstamo: 'prestamo',
  prestamo_: 'prestamo',
  loan: 'prestamo',
};

function cleanKey(v: any): string {
  if (!v) return '';
  const s = String(v)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // quita acentos
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-]+/g, '-')
    .replace(/[^a-z_ -]/g, '');
  // normalizaciones puntuales
  return s === 'prestamo' || s === 'prstamo' ? 'prestamo' : s;
}

/** Devuelve el tipo canónico o null si es desconocido. */
export function canonicalTipo(t: any): MovimientoTipo | null {
  const k = cleanKey(t);
  if (!k) return null;
  if (k in NORMALIZADORES) return NORMALIZADORES[k];
  // algunos patrones rápidos
  if (k.startsWith('gasto') && k.includes('admin')) return 'gasto_admin';
  if (k.startsWith('gasto')) return 'gasto_cobrador';
  return null;
}

/** Ícono sugerido para filas (MaterialCommunityIcons) */
export function iconFor(t: MovimientoTipo): { name: string } {
  switch (t) {
    case 'apertura': return { name: 'lock-open-variant' };
    case 'cierre': return { name: 'lock' };
    case 'abono': return { name: 'check-circle-outline' };
    case 'ingreso': return { name: 'arrow-down-bold-circle-outline' };
    case 'retiro': return { name: 'arrow-up-bold-circle-outline' };
    case 'gasto_admin': return { name: 'office-building-cog-outline' };
    case 'gasto_cobrador': return { name: 'account-cash-outline' };
    case 'prestamo': return { name: 'cash-multiple' };
    default: return { name: 'checkbox-blank-circle-outline' };
  }
}

/** Etiqueta corta para chips/filas */
export function labelFor(t: MovimientoTipo): string {
  switch (t) {
    case 'apertura': return 'Apertura';
    case 'cierre': return 'Cierre';
    case 'abono': return 'Cobrado';
    case 'ingreso': return 'Ingreso';
    case 'retiro': return 'Retiro';
    case 'gasto_admin': return 'Gasto admin';
    case 'gasto_cobrador': return 'Gasto cobrador';
    case 'prestamo': return 'Préstamo';
    default: return 'Movimiento';
  }
}

/** Color “tono” sugerido (hex) */
export function toneFor(t: MovimientoTipo): string {
  switch (t) {
    case 'abono': return '#2e7d32';
    case 'ingreso': return '#1565C0';
    case 'retiro': return '#C62828';
    case 'gasto_admin': return '#EF6C00';
    case 'gasto_cobrador': return '#6A1B9A';
    case 'apertura': return '#00897B';
    case 'cierre': return '#37474F';
    case 'prestamo': return '#283593';
    default: return '#455A64';
  }
}
