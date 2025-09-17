import { collection, doc, getCountFromServer, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';

export async function refrescarDisponibilidadCliente(clienteId: string) {
  const prestamosCol = collection(db, 'clientes', clienteId, 'prestamos');
  const agg = await getCountFromServer(prestamosCol);
  const quedan = agg.data().count;

  const idxRef = doc(db, 'clientesDisponibles', clienteId);
  await setDoc(
    idxRef,
    {
      id: clienteId,
      disponible: quedan === 0,
      actualizadoEn: serverTimestamp(),
    },
    { merge: true }
  );
}
