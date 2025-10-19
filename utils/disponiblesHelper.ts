// utils/refrescarDisponibilidad.ts
import {
  collection, doc, getCountFromServer, setDoc, serverTimestamp, query, where,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';

/**
 * Versión LEGACY (drop-in replacement)
 * - disponible = true si NO hay préstamos activos con restante > 0
 * - escribe en 'clientesDisponibles/{clienteId}'
 */
export async function refrescarDisponibilidadCliente(clienteId: string) {
  // Solo prestamos ACTIVO con deuda
  const prestamosQ = query(
    collection(db, 'clientes', clienteId, 'prestamos'),
    where('status', '==', 'activo'),
    where('restante', '>', 0)
  );
  const agg = await getCountFromServer(prestamosQ);
  const quedan = agg.data().count;

  const idxRef = doc(db, 'clientesDisponibles', clienteId);
  await setDoc(
    idxRef,
    {
      id: clienteId,
      disponible: quedan === 0,
      actualizadoEn: serverTimestamp(),
      // campos extra opcionales por si en el futuro quieres filtrar
      statusCountActivoConDeuda: quedan,
    },
    { merge: true }
  );
}

/**
 * Versión con SCOPING (recomendada si tienes multi-tenant/rutas)
 * - DocId = `${tenantId}_${clienteId}` para evitar colisiones
 * - Guarda tenantId/rutaId/admin para filtros en EnrutarClientes
 *
 * Ejemplo de uso:
 *   await refrescarDisponibilidadClienteScoped(clienteId, {
 *     tenantId: sess.tenantId, rutaId: sess.rutaId, admin: adminId
 *   })
 */
export async function refrescarDisponibilidadClienteScoped(
  clienteId: string,
  ctx: { tenantId?: string | null; rutaId?: string | null; admin?: string | null }
) {
  // Solo prestamos ACTIVO con deuda
  const prestamosQ = query(
    collection(db, 'clientes', clienteId, 'prestamos'),
    where('status', '==', 'activo'),
    where('restante', '>', 0)
  );
  const agg = await getCountFromServer(prestamosQ);
  const quedan = agg.data().count;

  const { tenantId = null, rutaId = null, admin = null } = ctx || {};
  const docId = tenantId ? `${tenantId}_${clienteId}` : clienteId;

  const idxRef = doc(db, 'clientesDisponibles', docId);
  await setDoc(
    idxRef,
    {
      id: clienteId,
      docKey: docId,
      disponible: quedan === 0,
      actualizadoEn: serverTimestamp(),
      // scoping
      tenantId,
      rutaId,
      admin,
      // métricas útiles
      statusCountActivoConDeuda: quedan,
    },
    { merge: true }
  );
}
