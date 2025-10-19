// utils/authCtx.ts
import { getFullSession } from './session';

export type AuthCtx = {
  admin: string;
  uid: string;
  tenantId: string | null;
  role: 'collector' | 'admin' | 'superadmin' | null;
  rutaId: string | null;
  nombre?: string | null;
  ciudad?: string | null;
};

export async function getAuthCtx(): Promise<AuthCtx | null> {
  const s = await getFullSession();
  if (!s) return null;
  return {
    admin: s.admin,
    uid: s.uid,
    tenantId: s.tenantId ?? null,
    role: s.role ?? null,
    rutaId: s.rutaId ?? null,
    nombre: s.nombre ?? null,
    ciudad: s.ciudad ?? null,
  };
}
