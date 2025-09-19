// utils/whatsTemplates.ts
export function formatBRL(n: number) {
  return `R$ ${Number(n || 0).toFixed(2)}`;
}

export type TemplateVars = {
  NOME?: string;
  VALOR_COTA?: number;
};

export type TemplatePT = {
  key: string;
  label: string;
  body: string;
};

export function fillTemplatePT(tpl: TemplatePT, vars: TemplateVars): string {
  const safe = {
    NOME: (vars.NOME ?? 'cliente').trim() || 'cliente',
    VALOR_COTA: vars.VALOR_COTA,
  };

  let out = tpl.body;

  out = out.replace(/\{\{\s*NOME\s*\}\}/g, String(safe.NOME));
  out = out.replace(/\{\{\s*VALOR_COTA\s*\}\}/g, () =>
    safe.VALOR_COTA != null ? formatBRL(Number(safe.VALOR_COTA)) : ''
  );

  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/g, '').replace(/\s{2,}/g, ' ').trimEnd())
    .filter((l) => l.trim().length > 0)
    .join('\n');
}

export const TEMPLATES_PT = {
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
} as const;

export function buildTemplatePreviewFromData(
  key: keyof typeof TEMPLATES_PT,
  p: { concepto?: string; valorCuota?: number; tz?: string },
) {
  return fillTemplatePT(TEMPLATES_PT[key], {
    NOME: (p.concepto ?? '').trim() || 'cliente',
    VALOR_COTA: Number.isFinite(Number(p.valorCuota)) ? Number(p.valorCuota) : undefined,
  });
}
