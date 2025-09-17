// utils/movimientoHelper.ts
export type MovimientoTipo =
  | 'abono'
  | 'gasto_admin'
  | 'gasto_cobrador'
  | 'ingreso'
  | 'retiro'
  | 'apertura'
  | 'cierre';

// Mapea lo viejo a lo canónico (compatibilidad hacia atrás)
export function canonicalTipo(raw: any): MovimientoTipo | null {
  const t = String(raw || '').trim();
  switch (t) {
    case 'abono':
    case 'pago':
      return 'abono';
    case 'gastoAdmin':
    case 'gasto_admin':
      return 'gasto_admin';
    case 'gastoCobrador':
    case 'gasto_cobrador':
      return 'gasto_cobrador';
    case 'ingreso':
      return 'ingreso';
    case 'retiro':
      return 'retiro';
    case 'apertura':
    case 'aperturaAuto':
      return 'apertura';
    case 'cierre':
      return 'cierre';
    default:
      return null;
  }
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
  // Nombres de MaterialCommunityIcons
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
