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
    if (c.tenantId !== undefined) base.tenantId = c.tenantId ?? null; // ✔ tenant
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
    // refresca datos visibles si cambiaron en el cliente (no pisamos creadoEn)
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
        actualizadoEn: FieldValue.serverTimestamp(), // ✅ typo corregido
      },
      { merge: true }
    );
  });
}

/**
 * Cuando se CREA un préstamo activo:
 *  - ++count y marcar NO disponible (vía normalize)
 *  - crear movimiento en cajaDiaria (id: loan_{prestamoId}) — idempotente
 */
export const onPrestamoCreated = onDocumentCreated(
  'clientes/{clienteId}/prestamos/{prestamoId}',
  async (event) => {
    const clienteId = String(event.params.clienteId || '');
    const prestamoId = String(event.params.prestamoId || '');
    if (!clienteId || !prestamoId) return;

    // Lee el préstamo para poblar la caja
    const pSnap = await db.doc(`clientes/${clienteId}/prestamos/${prestamoId}`).get();
    const p: any = pSnap.exists ? (pSnap.data() || {}) : {};

    // 1) índice + contador
    await ensureIndiceCliente(clienteId);
    await dispRef(clienteId).set(
      {
        activePrestamosCount: FieldValue.increment(1),
        actualizadoEn: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await normalizeDisponibilidad(clienteId);

    // 2) cajaDiaria — idempotente
    try {
      const cajaId = `loan_${prestamoId}`;
      const cajaRef = db.doc(`cajaDiaria/${cajaId}`);
      const cajaSnap = await cajaRef.get();
      if (!cajaSnap.exists) {
        // monto = efectivo entregado
        const monto =
          Number(p.valorNeto ?? p.monto ?? p.montoTotal ?? p.totalPrestamo ?? 0) || 0;
        const admin = p.creadoPor ?? p.admin ?? 'system';
        const operationalDate = p.createdDate ?? p.operationalDate ?? p.fechaInicio ?? null;
        const tz = p.tz ?? null;
        const clienteNombre = p.concepto || p.clienteNombre || 'Cliente';

        await cajaRef.set({
          tipo: 'prestamo', // ← VentasNuevas filtra por esto
          admin,
          clienteId,
          prestamoId,
          clienteNombre,
          monto: Number(monto.toFixed(2)),
          tz,
          operationalDate, // YYYY-MM-DD
          createdAt: FieldValue.serverTimestamp(),
          createdAtMs: Date.now(),
          source: 'cf:onPrestamoCreated',
          // scoping
          tenantId: p.tenantId ?? null,
          rutaId: p.rutaId ?? null,
          meta: {
            modalidad: p.modalidad ?? null,
            interesPct: p.interes ?? null,
          },
        });
      }
    } catch (e) {
      console.warn('[onPrestamoCreated] fallo al crear cajaDiaria:', e);
    }
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

// ⬇️ Procesa abono en backend (idempotente y ligero)
export const onAbonoCreated = onDocumentCreated(
  // { region: 'southamerica-east1', timeoutSeconds: 30 }, // opcional
  'clientes/{clienteId}/prestamos/{prestamoId}/abonos/{abonoId}',
  async (event) => {
    const { clienteId, prestamoId, abonoId } = event.params as any;
    if (!clienteId || !prestamoId || !abonoId) return;

    const abono = event.data?.data() || {};
    const prestamoRef = db.doc(`clientes/${clienteId}/prestamos/${prestamoId}`);
    const cajaRef = db.doc(`cajaDiaria/pay_${abonoId}`);

    // ========= PASO 1: actualizar préstamo + caja (idempotente) =========
    await db.runTransaction(async (tx) => {
      // 1) leer préstamo
      const pSnap = await tx.get(prestamoRef);
      if (!pSnap.exists) {
        console.warn('[onAbonoCreated] préstamo no existe', { clienteId, prestamoId, abonoId });
        return;
      }
      const p: any = pSnap.data() || {};

      // 2) cálculos mínimos (restante, cuotas)
      const restanteActual =
        Number(p.restante ?? p.totalPrestamo ?? p.montoTotal ?? 0) || 0;
      const valorCuota = Number(p.valorCuota || 0);
      const monto = Number(abono.monto || 0);

      const cuotasTotales =
        Number(p.cuotasTotales || p.cuotas || 0) ||
        (valorCuota > 0
          ? Math.ceil(Number(p.totalPrestamo || p.montoTotal || 0) / valorCuota)
          : 0);

      const nuevoRestante = Math.max(0, +(restanteActual - monto).toFixed(2));
      const prevCuotasPagadas = Number(p.cuotasPagadas || 0);
      const deltaCuotas = valorCuota > 0 ? Math.floor(monto / valorCuota) : 0;
      const nuevasCuotasPagadas =
        cuotasTotales > 0
          ? Math.min(prevCuotasPagadas + deltaCuotas, cuotasTotales)
          : prevCuotasPagadas + deltaCuotas;

      // 3) cajaDiaria idempotente
      const cajaSnap = await tx.get(cajaRef);
      if (!cajaSnap.exists) {
        tx.set(cajaRef, {
          tipo: 'abono',
          admin: abono.registradoPor,
          clienteId,
          prestamoId,
          clienteNombre: p.concepto || 'Cliente',
          monto: Number(monto.toFixed(2)),
          tz: abono.tz ?? p.tz ?? null,
          operationalDate: abono.operationalDate ?? p.createdDate ?? null,
          createdAt: FieldValue.serverTimestamp(),
          createdAtMs: Date.now(),
          source: abono.source || 'app',
          tenantId: abono.tenantId ?? p.tenantId ?? null,
          rutaId: abono.rutaId ?? p.rutaId ?? null,
          meta: { abonoRefId: abonoId },
        });
      }

      // 4) actualizar préstamo
      tx.update(prestamoRef, {
        restante: nuevoRestante,
        cuotasPagadas: nuevasCuotasPagadas,
        lastAbonoAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    // ========= PASO 2: (complementario) atraso + cierre si saldo 0 =========
    try {
      const p2 = await prestamoRef.get();
      if (!p2.exists) return;
      const prestamo = p2.data() as any;

      await prestamoRef.set(
        { ultimaReconciliacion: FieldValue.serverTimestamp() },
        { merge: true }
      );

      const restanteFinal = Number(prestamo?.restante || 0);
      if (restanteFinal === 0) {
        await db.runTransaction(async (tx) => {
          const liveSnap = await tx.get(prestamoRef);
          if (!liveSnap.exists) return;
          const live = liveSnap.data() as any;

          const historialCol = db.collection(`clientes/${clienteId}/historialPrestamos`);
          const existing = await historialCol.where('meta.prestamoId', '==', prestamoId).limit(1).get();
          if (!existing.empty) {
            tx.delete(prestamoRef);
            return;
          }

          const histRef = historialCol.doc();
          tx.set(histRef, {
            ...live,
            restante: 0,
            diasAtraso: 0,
            faltas: [],
            finalizadoEn: FieldValue.serverTimestamp(),
            finalizadoPor: abono.registradoPor ?? 'system',
            meta: { prestamoId, cerradoPorCF: true },
          });
          tx.delete(prestamoRef);
        });
      }
    } catch (e) {
      console.warn('[onAbonoCreated:PASO2] fallo pos-tx:', e);
    }
  }
);
