import { getMonthRange } from '../recurrences/recurrences.utils.js';
import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';

export type InvestmentTriggerStatus = 'BLOQUEADO' | 'LIBERADO';

export interface ReserveMovementPoint {
  month: string;
  tipo: 'APORTE' | 'RESGATE';
  valor: number;
}

export interface ReserveThermometerResult {
  valorMetaCalculado: number;
  saldoAcumulado: number;
  valorFaltante: number;
  percentualConcluido: number;
  mesesSegurancaCobertos: number;
  mesesAlvo: number;
  mediaAportesMensal: number;
  mesesJanelaMedia: number;
  mesesRestantesEstimados: number | null;
  mesEstimadoConclusao: string | null;
  metaConcluida: boolean;
  statusGatilho: InvestmentTriggerStatus;
}

export interface WithdrawalImpactSimulation {
  valorResgate: number;
  saldoAntes: number;
  saldoDepois: number;
  percentualAntes: number;
  percentualDepois: number;
  mesesCobertosAntes: number;
  mesesCobertosDepois: number;
  mesesPerdidos: number;
  statusGatilhoAntes: InvestmentTriggerStatus;
  statusGatilhoDepois: InvestmentTriggerStatus;
  perdeuGatilhoInvestimentos: boolean;
}

export interface MonthlyReservePriorityResult {
  abaixoDaMeta: boolean;
  prioridadeTopoAtiva: boolean;
  acaoPendenteMes: boolean;
  receitasMes: number;
  pctPaguePrimeiro: number;
  metaAporteMes: number;
  aportesLiquidosMes: number;
  valorPendenteMes: number;
}

function shiftMonthIso(month: string, deltaMonths: number): string {
  const { year, monthNumber } = getMonthRange(month);
  return new Date(Date.UTC(year, monthNumber - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

function monthsBetweenInclusive(startMonth: string, endMonth: string): number {
  const start = getMonthRange(startMonth);
  const end = getMonthRange(endMonth);
  return (end.year - start.year) * 12 + (end.monthNumber - start.monthNumber) + 1;
}

export function calculateIdealReserveTarget(
  custoVidaMensal: number,
  mesesReservaAlvo: number,
): number {
  const safeCost = Math.max(0, custoVidaMensal);
  const safeMonths = Math.max(0, Math.trunc(mesesReservaAlvo));
  return roundCurrency(safeCost * safeMonths);
}

export function calculateSplitAmount(valorReceita: number, pctPaguePrimeiro: number): number {
  const safeIncome = Math.max(0, valorReceita);
  const safePct = Math.min(100, Math.max(0, pctPaguePrimeiro));
  return roundCurrency(safeIncome * (safePct / 100));
}

export function evaluateInvestmentTriggerStatus(
  saldoAcumulado: number,
  valorMetaCalculado: number,
  gatilhoInvestPct: number,
): InvestmentTriggerStatus {
  if (valorMetaCalculado <= 0) {
    return 'BLOQUEADO';
  }
  const requiredAmount = roundCurrency(
    valorMetaCalculado * (Math.min(100, Math.max(0, gatilhoInvestPct)) / 100),
  );
  return roundCurrency(Math.max(0, saldoAcumulado)) >= requiredAmount ? 'LIBERADO' : 'BLOQUEADO';
}

export function calculateReserveThermometer(input: {
  saldoAcumulado: number;
  valorMetaCalculado: number;
  custoVidaMensal: number;
  mesesReservaAlvo: number;
  gatilhoInvestPct: number;
  referenceMonth: string;
  recentMovements: ReadonlyArray<ReserveMovementPoint>;
}): ReserveThermometerResult {
  const saldoAcumulado = roundCurrency(Math.max(0, input.saldoAcumulado));
  const valorMetaCalculado = roundCurrency(Math.max(0, input.valorMetaCalculado));
  const custoVidaMensal = roundCurrency(Math.max(0, input.custoVidaMensal));

  const sixMonthsAgo = shiftMonthIso(input.referenceMonth, -5);
  const windowMovements = input.recentMovements.filter(
    (item) => item.month >= sixMonthsAgo && item.month <= input.referenceMonth,
  );

  let mesesJanelaMedia = 0;
  let mediaAportesMensal = 0;

  if (windowMovements.length > 0) {
    let earliestMonth = windowMovements[0]!.month;
    let netSum = 0;

    for (const mov of windowMovements) {
      if (mov.month < earliestMonth) {
        earliestMonth = mov.month;
      }
      netSum += mov.tipo === 'APORTE' ? mov.valor : -mov.valor;
    }

    mesesJanelaMedia = Math.min(
      6,
      Math.max(1, monthsBetweenInclusive(earliestMonth, input.referenceMonth)),
    );
    mediaAportesMensal = roundCurrency(roundCurrency(netSum) / mesesJanelaMedia);
  }

  const valorFaltante = roundCurrency(Math.max(0, valorMetaCalculado - saldoAcumulado));
  const percentualConcluido =
    valorMetaCalculado > 0 ? roundCurrency((saldoAcumulado / valorMetaCalculado) * 100) : 0;
  const mesesSegurancaCobertos =
    custoVidaMensal > 0 ? roundCurrency(saldoAcumulado / custoVidaMensal) : 0;

  const statusGatilho = evaluateInvestmentTriggerStatus(
    saldoAcumulado,
    valorMetaCalculado,
    input.gatilhoInvestPct,
  );

  let metaConcluida = false;
  let mesesRestantesEstimados: number | null = null;
  let mesEstimadoConclusao: string | null = null;

  if (valorMetaCalculado > 0 && valorFaltante === 0) {
    metaConcluida = true;
    mesesRestantesEstimados = 0;
    mesEstimadoConclusao = input.referenceMonth;
  } else if (valorMetaCalculado > 0 && mediaAportesMensal > 0) {
    mesesRestantesEstimados = Math.ceil(valorFaltante / mediaAportesMensal);
    mesEstimadoConclusao = shiftMonthIso(input.referenceMonth, mesesRestantesEstimados);
  }

  return {
    valorMetaCalculado,
    saldoAcumulado,
    valorFaltante,
    percentualConcluido,
    mesesSegurancaCobertos,
    mesesAlvo: input.mesesReservaAlvo,
    mediaAportesMensal,
    mesesJanelaMedia,
    mesesRestantesEstimados,
    mesEstimadoConclusao,
    metaConcluida,
    statusGatilho,
  };
}

export function simulateWithdrawalImpact(input: {
  valorResgate: number;
  saldoAcumuladoAtual: number;
  valorMetaCalculado: number;
  custoVidaMensal: number;
  gatilhoInvestPct: number;
}): WithdrawalImpactSimulation {
  const valorResgate = roundCurrency(Math.max(0, input.valorResgate));
  const saldoAntes = roundCurrency(Math.max(0, input.saldoAcumuladoAtual));
  const saldoDepois = roundCurrency(Math.max(0, saldoAntes - valorResgate));
  const meta = roundCurrency(Math.max(0, input.valorMetaCalculado));
  const custo = roundCurrency(Math.max(0, input.custoVidaMensal));

  const percentualAntes = meta > 0 ? roundCurrency((saldoAntes / meta) * 100) : 0;
  const percentualDepois = meta > 0 ? roundCurrency((saldoDepois / meta) * 100) : 0;

  const mesesCobertosAntes = custo > 0 ? roundCurrency(saldoAntes / custo) : 0;
  const mesesCobertosDepois = custo > 0 ? roundCurrency(saldoDepois / custo) : 0;
  const mesesPerdidos = roundCurrency(Math.max(0, mesesCobertosAntes - mesesCobertosDepois));

  const statusGatilhoAntes = evaluateInvestmentTriggerStatus(
    saldoAntes,
    meta,
    input.gatilhoInvestPct,
  );
  const statusGatilhoDepois = evaluateInvestmentTriggerStatus(
    saldoDepois,
    meta,
    input.gatilhoInvestPct,
  );

  return {
    valorResgate,
    saldoAntes,
    saldoDepois,
    percentualAntes,
    percentualDepois,
    mesesCobertosAntes,
    mesesCobertosDepois,
    mesesPerdidos,
    statusGatilhoAntes,
    statusGatilhoDepois,
    perdeuGatilhoInvestimentos:
      statusGatilhoAntes === 'LIBERADO' && statusGatilhoDepois === 'BLOQUEADO',
  };
}

export function evaluateMonthlyReservePriority(input: {
  saldoAcumulado: number;
  valorMetaCalculado: number;
  receitasMes: number;
  pctPaguePrimeiro: number;
  aportesMes: number;
  resgatesMes: number;
}): MonthlyReservePriorityResult {
  const receitasMes = roundCurrency(Math.max(0, input.receitasMes));
  const pctPaguePrimeiro = roundCurrency(Math.min(100, Math.max(0, input.pctPaguePrimeiro)));
  const metaAporteMes = calculateSplitAmount(receitasMes, pctPaguePrimeiro);
  const aportesLiquidosMes = roundCurrency(
    Math.max(0, roundCurrency(input.aportesMes) - roundCurrency(input.resgatesMes)),
  );
  const valorPendenteMes = roundCurrency(Math.max(0, metaAporteMes - aportesLiquidosMes));
  const abaixoDaMeta =
    input.valorMetaCalculado > 0 &&
    roundCurrency(input.saldoAcumulado) < roundCurrency(input.valorMetaCalculado);

  return {
    abaixoDaMeta,
    prioridadeTopoAtiva: abaixoDaMeta,
    acaoPendenteMes: abaixoDaMeta && valorPendenteMes > 0,
    receitasMes,
    pctPaguePrimeiro,
    metaAporteMes,
    aportesLiquidosMes,
    valorPendenteMes,
  };
}
