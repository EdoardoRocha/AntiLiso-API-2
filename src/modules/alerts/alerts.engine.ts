import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';

export type AlertType = 'VENC' | 'ORCAM' | 'RESUMO';
export type AlertChannel = 'PUSH' | 'EMAIL' | 'WHATS';

export interface GeneratedAlertCandidate {
  tipoAlerta: AlertType;
  dedupPrefix: string;
  mensagem: string;
}

export interface DueSoonBillInput {
  id: string;
  kind: 'CONTA_FIXA_OU_DESP' | 'FATURA_CARTAO';
  descricao: string;
  valor: number;
  dueDateIso: string;
}

export interface CategoryBudgetInput {
  categoriaId: string;
  categoriaNome: string;
  orcamentoMensal: number;
  gastoMes: number;
}

export interface WeeklyTransactionPoint {
  tipo: 'REC' | 'DESP';
  valor: number;
  categoriaNome: string | null;
}

export interface WeeklyDigestResult {
  isoWeek: string;
  periodStart: string;
  periodEnd: string;
  receitas7d: number;
  despesas7d: number;
  saldoSemana: number;
  maiorCategoriaSemana: { nome: string; valor: number } | null;
  quantoPossoGastarHoje: number;
  contasVencendo48hCount: number;
}

const DAY_MS = 86_400_000;

export function clampAlertMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 255) {
    return collapsed;
  }
  return `${collapsed.slice(0, 252)}...`;
}

export function formatBrlInline(value: number): string {
  const rounded = roundCurrency(Math.abs(value));
  const [intPart, decPart] = rounded.toFixed(2).split('.');
  const formattedInt = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}R$ ${formattedInt},${decPart ?? '00'}`;
}

export function formatDateBrInline(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function isoDateToUtcMs(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getTime();
}

export function computeIsoWeekId(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function evaluateDueSoonCandidates(
  referenceDateIso: string,
  items: ReadonlyArray<DueSoonBillInput>,
): GeneratedAlertCandidate[] {
  const refMs = isoDateToUtcMs(referenceDateIso);
  const candidates: GeneratedAlertCandidate[] = [];

  for (const item of items) {
    if (item.valor <= 0) {
      continue;
    }

    const diffDays = Math.round((isoDateToUtcMs(item.dueDateIso) - refMs) / DAY_MS);
    if (diffDays < 0 || diffDays > 2) {
      continue;
    }

    const whenLabel =
      diffDays === 0 ? 'vence hoje' : diffDays === 1 ? 'vence amanhã' : 'vence em 48h';
    const shortId = item.id.slice(0, 8);
    const dedupPrefix = `[VENC ${item.dueDateIso} #${shortId}]`;
    const prefixLabel = item.kind === 'FATURA_CARTAO' ? 'Fatura' : 'Conta';
    const cleanDesc = item.descricao.replace(/\s+/g, ' ').trim();

    const mensagem = clampAlertMessage(
      `${dedupPrefix} ${prefixLabel} "${cleanDesc}" (${formatBrlInline(item.valor)}) ${whenLabel} (${formatDateBrInline(item.dueDateIso)}).`,
    );

    candidates.push({
      tipoAlerta: 'VENC',
      dedupPrefix,
      mensagem,
    });
  }

  return candidates;
}

export function evaluateBudgetCandidates(
  month: string,
  items: ReadonlyArray<CategoryBudgetInput>,
): GeneratedAlertCandidate[] {
  const candidates: GeneratedAlertCandidate[] = [];

  for (const item of items) {
    if (item.orcamentoMensal <= 0) {
      continue;
    }

    const pct = roundCurrency((item.gastoMes / item.orcamentoMensal) * 100);
    if (pct < 80) {
      continue;
    }

    const catShortId = item.categoriaId.slice(0, 8);
    const cleanName = item.categoriaNome.replace(/\s+/g, ' ').trim();

    if (pct >= 100) {
      const dedupPrefix = `[ORCAM 100% ${month} #${catShortId}]`;
      candidates.push({
        tipoAlerta: 'ORCAM',
        dedupPrefix,
        mensagem: clampAlertMessage(
          `${dedupPrefix} Orçamento estourado em "${cleanName}": ${formatBrlInline(item.gastoMes)} de ${formatBrlInline(item.orcamentoMensal)} (${pct.toFixed(0)}%).`,
        ),
      });
    } else {
      const dedupPrefix = `[ORCAM 80% ${month} #${catShortId}]`;
      candidates.push({
        tipoAlerta: 'ORCAM',
        dedupPrefix,
        mensagem: clampAlertMessage(
          `${dedupPrefix} Consumo acima de 80% em "${cleanName}": ${formatBrlInline(item.gastoMes)} de ${formatBrlInline(item.orcamentoMensal)} (${pct.toFixed(0)}%).`,
        ),
      });
    }
  }

  return candidates;
}

export function buildWeeklyDigest(input: {
  referenceDateIso: string;
  transactions7d: ReadonlyArray<WeeklyTransactionPoint>;
  quantoPossoGastarHoje: number;
  contasVencendo48hCount: number;
}): { digest: WeeklyDigestResult; candidate: GeneratedAlertCandidate } {
  const refMs = isoDateToUtcMs(input.referenceDateIso);
  const periodStart = new Date(refMs - 6 * DAY_MS).toISOString().slice(0, 10);
  const isoWeek = computeIsoWeekId(input.referenceDateIso);

  let receitas7d = 0;
  let despesas7d = 0;
  const byCategory = new Map<string, number>();

  for (const tx of input.transactions7d) {
    if (tx.tipo === 'REC') {
      receitas7d = roundCurrency(receitas7d + Math.max(0, tx.valor));
    } else {
      despesas7d = roundCurrency(despesas7d + Math.max(0, tx.valor));
      if (tx.categoriaNome) {
        byCategory.set(
          tx.categoriaNome,
          roundCurrency((byCategory.get(tx.categoriaNome) ?? 0) + Math.max(0, tx.valor)),
        );
      }
    }
  }

  let maiorCategoriaSemana: { nome: string; valor: number } | null = null;
  for (const [nome, valor] of byCategory.entries()) {
    if (!maiorCategoriaSemana || valor > maiorCategoriaSemana.valor) {
      maiorCategoriaSemana = { nome, valor };
    }
  }

  const saldoSemana = roundCurrency(receitas7d - despesas7d);
  const quantoPossoGastarHoje = roundCurrency(input.quantoPossoGastarHoje);

  const digest: WeeklyDigestResult = {
    isoWeek,
    periodStart,
    periodEnd: input.referenceDateIso,
    receitas7d,
    despesas7d,
    saldoSemana,
    maiorCategoriaSemana,
    quantoPossoGastarHoje,
    contasVencendo48hCount: input.contasVencendo48hCount,
  };

  const dedupPrefix = `[RESUMO ${isoWeek}]`;
  const topCatText = maiorCategoriaSemana
    ? ` | Maior gasto: ${maiorCategoriaSemana.nome} (${formatBrlInline(maiorCategoriaSemana.valor)})`
    : '';
  const dueText =
    input.contasVencendo48hCount > 0 ? ` | ${input.contasVencendo48hCount} conta(s) em 48h` : '';

  const mensagem = clampAlertMessage(
    `${dedupPrefix} Resumo 7d: Entrou ${formatBrlInline(receitas7d)}, Saiu ${formatBrlInline(despesas7d)}${topCatText} | Livre hoje: ${formatBrlInline(quantoPossoGastarHoje)}${dueText}.`,
  );

  return {
    digest,
    candidate: {
      tipoAlerta: 'RESUMO',
      dedupPrefix,
      mensagem,
    },
  };
}
