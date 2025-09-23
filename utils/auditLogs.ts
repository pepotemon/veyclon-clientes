// utils/auditLogs.ts
import { addDoc, collection, serverTimestamp, DocumentReference, doc } from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';

// Mantiene todas tus acciones existentes + variantes de caja
type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'add_abono' | 'no_pago' | 'create_cliente' | 'create_prestamo'
  | 'outbox_enqueue' | 'outbox_flush'
  | 'abono_outbox' | 'no_pago_outbox'
  // 👇 NUEVAS para resolver tipos usados en outbox.ts
  | 'venta_outbox' | 'mov_outbox'
  // 👇 NUEVAS para caja
  | 'caja_apertura' | 'caja_apertura_auto'
  | 'caja_ingreso'  | 'caja_retiro'
  | 'caja_gasto_admin' | 'caja_gasto'
  | 'caja_cierre_manual' | 'caja_cierre_auto'
  | 'caja_estado_update';

type Opts = {
  userId: string;
  action: AuditAction;
  ref?: DocumentReference;   // uno de los dos
  docPath?: string;          // uno de los dos
  before?: any;
  after?: any;
};

/** ================= Sanitización Firestore =================
 * Reemplaza undefined -> null
 * Normaliza NaN/Infinity -> null
 * Respeta objetos especiales (Timestamp, DocumentReference, Date, etc.)
 */

function isPlainObject(value: any): value is Record<string, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function normalizeScalar(value: any) {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null; // NaN/±Infinity
  return value;
}

function sanitizeFirestoreData<T>(input: T): T {
  const v = normalizeScalar(input);

  if (v === null || typeof v !== 'object') return v as T;

  if (Array.isArray(v)) {
    return v.map((item) => sanitizeFirestoreData(item)) as unknown as T;
  }

  if (isPlainObject(v)) {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      const normalized = normalizeScalar(val);
      if (normalized === null) {
        out[k] = null;
      } else if (Array.isArray(normalized) || isPlainObject(normalized)) {
        out[k] = sanitizeFirestoreData(normalized);
      } else {
        out[k] = normalized;
      }
    }
    return out as T;
  }

  // No tocar objetos especiales (Date, Timestamp, DocumentReference, etc.)
  return v as T;
}

/** ================= Logger ================= */
export async function logAudit({ userId, action, ref, docPath, before, after }: Opts) {
  const resolvedRef = ref ?? (docPath ? doc(db, docPath) : undefined);
  if (!resolvedRef) {
    console.warn('[auditLogs] falta ref o docPath');
    return;
  }
  try {
    const safeBefore = sanitizeFirestoreData(before ?? null);
    const safeAfter  = sanitizeFirestoreData(after ?? null);

    await addDoc(collection(db, 'auditLogs'), {
      userId,
      action,
      docPath: resolvedRef.path,
      before: safeBefore,
      after: safeAfter,
      ts: serverTimestamp(),
    });
  } catch (e) {
    console.warn('[auditLogs] fallo registrando auditoría:', e);
  }
}

export function pick<T extends object>(obj: T | undefined | null, keys: (keyof T)[]): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
