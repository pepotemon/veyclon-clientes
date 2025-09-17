import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

const dispRef = (clienteId: string) => db.collection('clientesDisponibles').doc(clienteId);
const clienteRef = (clienteId: string) => db.collection('clientes').doc(clienteId);

/** Asegura documento en el índice y “siembra” datos básicos para listar rápido. */
async function ensureIndiceCliente(clienteId: string) {
  const [cSnap, dSnap] = await Promise.all([
    clienteRef(clienteId).get(),
    dispRef(clienteId).get(),
  ]);

  const base: Record<string, any> = { id: clienteId };
  if (cSnap.exists) {
    const c = cSnap.data() || {};
    base.nombre = c.nombre ?? '';
    base.alias = c.alias ?? '';
    base.barrio = c.barrio ?? '';
    base.telefono1 = c.telefono1 ?? '';
    base.creadoPor = c.creadoPor ?? '';
  }

  if (!dSnap.exists) {
    await dispRef(clienteId).set(
      {
        ...base,
        activePrestamosCount: 0,
        disponible: true,
        creadoEn: FieldValue.serverTimestamp(),
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else if (Object.keys(base).length > 1) {
    // refresca datos visibles si cambiaron en el cliente
    await dispRef(clienteId).set(
      {
        ...base,
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
}

/** Normaliza disponible según activePrestamosCount en una transacción. */
async function normalizeDisponibilidad(clienteId: string) {
  await db.runTransaction(async (tx) => {
    const d = await tx.get(dispRef(clienteId));
    const count = Math.max(0, Number(d.get('activePrestamosCount') ?? 0));
    tx.set(
      d.ref,
      {
        activePrestamosCount: count,
        disponible: count <= 0,
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

/** Cuando se CREA un préstamo activo: ++count y marcar NO disponible. */
export const onPrestamoCreated = onDocumentCreated(
  'clientes/{clienteId}/prestamos/{prestamoId}',
  async (event) => {
    const clienteId = String(event.params.clienteId || '');
    if (!clienteId) return;

    await ensureIndiceCliente(clienteId);
    await dispRef(clienteId).set(
      {
        activePrestamosCount: FieldValue.increment(1),
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await normalizeDisponibilidad(clienteId);
  }
);

/** Cuando se BORRA un préstamo activo: --count y, si llega a 0, marcar disponible. */
export const onPrestamoDeleted = onDocumentDeleted(
  'clientes/{clienteId}/prestamos/{prestamoId}',
  async (event) => {
    const clienteId = String(event.params.clienteId || '');
    if (!clienteId) return;

    await ensureIndiceCliente(clienteId);
    await dispRef(clienteId).set(
      {
        activePrestamosCount: FieldValue.increment(-1),
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await normalizeDisponibilidad(clienteId);
  }
);
