// utils/userLookup.ts
import { db } from '../firebase/firebaseConfig';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';

export type UsuarioDoc = {
  id: string;
  usuario?: string;   // username
  correo?: string;    // email
  password?: string;  // si existiera plano (no recomendado)
  pass?: string;      // compat antigua
  nombre?: string;
  rol?: string;
  // ...otros campos
};

function normLogin(input: string): { usuarioKey: string; correoKey: string } {
  const raw = String(input || '').trim();
  return {
    usuarioKey: raw,           // no lo forzamos a lower por compat de usernames
    correoKey: raw.toLowerCase(), // correos en lower
  };
}

/**
 * Busca primero por usuario ==, si no hay match, intenta por correo ==.
 * Devuelve el primer documento que haga match o null si no existe.
 */
export async function findUserByLogin(login: string): Promise<UsuarioDoc | null> {
  const { usuarioKey, correoKey } = normLogin(login);
  const col = collection(db, 'usuarios');

  // 1) usuario ==
  {
    const q1 = query(col, where('usuario', '==', usuarioKey), limit(1));
    const s1 = await getDocs(q1);
    if (!s1.empty) {
      const d = s1.docs[0];
      return { id: d.id, ...(d.data() as any) };
    }
  }

  // 2) correo ==
  {
    const q2 = query(col, where('correo', '==', correoKey), limit(1));
    const s2 = await getDocs(q2);
    if (!s2.empty) {
      const d = s2.docs[0];
      return { id: d.id, ...(d.data() as any) };
    }
  }

  return null;
}

/** Comparador simple de contraseña (solo por compat). */
export function passwordMatches(input: string, u: UsuarioDoc): boolean {
  const incoming = String(input || '');
  const stored = (u.password ?? u.pass ?? '') as string;
  // ⚠️ Esto es compat. Ideal: usar hash + compare con bcrypt/argon2 en servidor.
  return !!stored && stored === incoming;
}
