/**
 * Audit Logs (refactor P2)
 * - Buffer en memoria + flush en lote (writeBatch) con retardo 500–1000ms.
 * - logAudit es "fire-and-forget": retorna inmediatamente; la UI no espera el write.
 * - Backoff simple si el flush falla; nunca bloquea la app.
 */

import {
  addDoc, // (fallback)
  collection,
  serverTimestamp,
  DocumentReference,
  doc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';

// Mantiene todas tus acciones existentes + variantes de caja
export type AuditAction =
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
  | 'caja_apertura_manual'
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

/** =============== Buffer y flush en lote =============== */

type AuditDocShape = {
  userId: string;
  action: AuditAction;
  docPath: string;
  before: any;
  after: any;
  ts: ReturnType<typeof serverTimestamp>;
};

const LOGS_COLLECTION = 'auditLogs';
const FLUSH_DELAY_MS = 700;         // 500–1000ms recomendado
const BATCH_CHUNK_MAX = 450;        // margen bajo el límite de 500
const HARD_FLUSH_THRESHOLD = 80;    // si el buffer supera esto, intentamos flush pronto
const MAX_BACKOFF_MS = 10_000;

let buffer: AuditDocShape[] = [];
let flushTimer: any = null;
let flushing = false;
let backoffMs = 0;

/** Programa un flush "suave" (acumulando logs cercanos en el tiempo). */
function scheduleFlush() {
  if (flushing) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAuditBufferNow();
  }, FLUSH_DELAY_MS);
}

/** Fuerza un flush si el buffer se está creciendo demasiado. */
function scheduleFlushSoon() {
  if (flushing) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAuditBufferNow();
  }, Math.min(200, FLUSH_DELAY_MS)); // pequeño retardo para coalesce
}

/** Flush en lote; si falla, re-intenta con backoff sin bloquear la UI. */
export async function flushAuditBufferNow(): Promise<void> {
  if (flushing) return;
  if (buffer.length === 0) return;
  flushing = true;

  // Tomamos snapshot local y vaciamos el buffer (para permitir nuevos logs)
  const pending = buffer;
  buffer = [];

  try {
    // Escribimos en lotes de hasta BATCH_CHUNK_MAX
    let i = 0;
    while (i < pending.length) {
      const slice = pending.slice(i, i + BATCH_CHUNK_MAX);
      i += slice.length;

      const batch = writeBatch(db);
      const colRef = collection(db, LOGS_COLLECTION);
      for (const entry of slice) {
        const ref = doc(colRef); // ID autogenerado
        batch.set(ref, entry);
      }
      await batch.commit();
    }

    // éxito → reset backoff
    backoffMs = 0;
  } catch (err) {
    // Falla → devolvemos los logs al buffer y programamos reintento
    buffer = pending.concat(buffer);
    backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : 1000;

    // fallback (opcional): intenta un addDoc suelto si el batch falló; mejor reintentar en lote
    setTimeout(() => {
      scheduleFlush();
    }, backoffMs);
  } finally {
    flushing = false;
  }
}

/** ================= Logger público =================
 * Fire-and-forget: retorna rápido; el flush se hace en background.
 * Mantiene compat: la función sigue siendo async y resolvemos inmediato.
 */
export async function logAudit({ userId, action, ref, docPath, before, after }: Opts): Promise<void> {
  const resolvedRef = ref ?? (docPath ? doc(db, docPath) : undefined);
  if (!resolvedRef) {
    // No arrojamos error para no bloquear
    console.warn('[auditLogs] falta ref o docPath');
    return;
  }

  try {
    const safeBefore = sanitizeFirestoreData(before ?? null);
    const safeAfter = sanitizeFirestoreData(after ?? null);

    // Empujamos al buffer con ts=serverTimestamp (evaluado en el servidor al flush)
    buffer.push({
      userId,
      action,
      docPath: resolvedRef.path,
      before: safeBefore,
      after: safeAfter,
      ts: serverTimestamp(),
    });

    // Si el buffer crece mucho, intentamos flush pronto
    if (buffer.length >= HARD_FLUSH_THRESHOLD) {
      scheduleFlushSoon();
    } else {
      scheduleFlush();
    }
  } catch (e) {
    // Último recurso: intentar addDoc suelto, pero sin bloquear
    try {
      await addDoc(collection(db, LOGS_COLLECTION), {
        userId,
        action,
        docPath: resolvedRef.path,
        before: sanitizeFirestoreData(before ?? null),
        after: sanitizeFirestoreData(after ?? null),
        ts: serverTimestamp(),
      });
    } catch (ee) {
      console.warn('[auditLogs] fallo registrando auditoría (fallback):', ee);
    }
  }
}

/** Útil para llamadas manuales (p.ej., al salir de la app o después de una acción grande) */
export async function flushAuditsNow(): Promise<void> {
  await flushAuditBufferNow();
}

/** Utilidad existente */
export function pick<T extends object>(obj: T | undefined | null, keys: (keyof T)[]): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
