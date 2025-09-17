// utils/whatsTemplates.ts
import { todayInTZ, pickTZ } from '../utils/timezone';

export function formatBRL(n: number) {
  return `R$ ${Number(n || 0).toFixed(2)}`;
}

// ===== TIPOS DEL MOTOR DE TEMPLATES =====
export type TemplateVars = {
  NOME?: string;
  VALOR_COTA?: number; // opcional: si llega, se muestra; si no, se omite
  // ⚠️ Ya no usamos DATA ni SALDO en las plantillas simplificadas
  DATA?: string;
  SALDO?: number;
};

export type TemplatePT = {
  key: string;
  label: string;
  body: string; // puede contener {{NOME}} y opcionalmente {{VALOR_COTA}}
};

// Reemplaza placeholders y formatea BRL donde aplique
export function fillTemplatePT(tpl: TemplatePT, vars: TemplateVars): string {
  const safe = {
    NOME: (vars.NOME ?? 'cliente').trim() || 'cliente',
    VALOR_COTA: vars.VALOR_COTA,
  };

  let out = tpl.body;

  out = out.replace(/\{\{\s*NOME\s*\}\}/g, String(safe.NOME));

  // VALOR_COTA: si no viene, elimina el marcador y espacios sobrantes
  out = out.replace(/\{\{\s*VALOR_COTA\s*\}\}/g, () =>
    safe.VALOR_COTA != null ? formatBRL(Number(safe.VALOR_COTA)) : ''
  );

  // Limpieza: quita dobles espacios y líneas vacías residuales
  out = out
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/\s{2,}/g, ' ').trimEnd())
    .filter((l) => l.trim().length > 0)
    .join('\n');

  return out;
}

// ===== SOLO RECORDATORIO/COBRANÇA (de mais suave a mais forte) =====
export const TEMPLATES_PT: Record<
  | 'LEMBRETE_SIMPLES'
  | 'COBRANCA_SUAVE'
  | 'COBRANCA_MEDIA'
  | 'COBRANCA_DIRETA'
  | 'COBRANCA_FIRME',
  | 
  TemplatePT
> = {
  LEMBRETE_SIMPLES: {
    key: 'LEMBRETE_SIMPLES',
    label: 'Lembrete (simples)',
    body: `Olá, *{{NOME}}*! 👋
Estou passando para lembrar do pagamento de hoje. Pode me avisar quando for possível?`,
  },

  COBRANCA_SUAVE: {
    key: 'COBRANCA_SUAVE',
    label: 'Cobrança (gentil)',
    body: `Olá, *{{NOME}}*.
Sigo aguardando o pagamento de hoje. Consegue me confirmar um horário, por favor?`,
  },

  COBRANCA_MEDIA: {
    key: 'COBRANCA_MEDIA',
    label: 'Cobrança (moderada)',
    body: `Olá, *{{NOME}}*.
Precisamos regularizar o pagamento de hoje. Pode enviar ou informar quando consigo passar?`,
  },

  COBRANCA_DIRETA: {
    key: 'COBRANCA_DIRETA',
    label: 'Cobrança (direta)',
    body: `Olá, *{{NOME}}*.
O pagamento de hoje está pendente. Preciso da sua confirmação ainda hoje.`,
  },

  COBRANCA_FIRME: {
    key: 'COBRANCA_FIRME',
    label: 'Cobrança (firme)',
    body: `Olá, *{{NOME}}*.
O pagamento de hoje ainda não foi realizado. Por favor, confirme o horário para acertarmos.`,
  },



};

// Helper para construir un preview desde datos del app (NOME + opcional VALOR_COTA)
export function buildTemplatePreviewFromData(
  key: keyof typeof TEMPLATES_PT,
  p: { concepto?: string; valorCuota?: number; tz?: string },
) {
  // mantenemos tz/hoy por compatibilidad, aunque ya no se usa aquí
  pickTZ(p.tz);
  todayInTZ(p.tz || 'America/Sao_Paulo');

  return fillTemplatePT(TEMPLATES_PT[key], {
    NOME: (p.concepto ?? '').trim() || 'cliente',
    VALOR_COTA: Number.isFinite(Number(p.valorCuota)) ? Number(p.valorCuota) : undefined,
  });
}
