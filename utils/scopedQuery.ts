// utils/scopedQuery.ts
import { Query, query, where } from 'firebase/firestore';
import type { AuthCtx } from './authCtx';

export function scopeByTenant<T extends Query>(q: T, ctx: AuthCtx | null): T {
  if (ctx?.tenantId) return query(q, where('tenantId', '==', ctx.tenantId)) as T;
  return q;
}

export function scopeByRutaIfCollector<T extends Query>(q: T, ctx: AuthCtx | null): T {
  if (ctx?.role === 'collector' && ctx.rutaId) {
    return query(q, where('rutaId', '==', ctx.rutaId)) as T;
  }
  return q;
}
