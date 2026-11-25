import { AppError } from '../../shared/errors/app-error.js';

export type SafeToSpendStatus = 'SAUDAVEL' | 'ATENCAO' | 'ESGOTADO' | 'SEM_RECEITA';

export interface ParsedReferenceDate {
  referenceDate: string;
  month: string;
  year: number;
  monthNumber: number;
  day: number;
  daysInMonth: number;
  diasRestantes: number;
  gte: Date;
  lt: Date;
}

export interface SafeToSpendCalculationInput {
  receitasPagas: number;
  receitasPendentes: number;
  contasFixasPagas: number;
  contasFixasPendentes: number;
  gastosVariaveisRealizados: number;
  pctPaguePrimeiro: number;
  aportesReservaMes: number;
  resgatesReservaMes: number;
  reference: ParsedReferenceDate;
}

export interface SafeToSpendCalculationResult {
  referenceDate: string;
  month: string;
  daysInMonth: number;
  diasRestantes: number;
  status: SafeToSpendStatus;
  quantoPossoGastarHoje: number;
  saldoLivreMes: number;
  saldoDiarioReal: number;
  breakdown: {
    receitasMes: number;
    receitasPagas: number;
    receitasPendentes: number;
    contasFixasTotal: number;
    contasFixasPagas: number;
    contasFixasPendentes: number;
    pctPaguePrimeiro: number;
    metaReservaPlanejada: number;
    aportesReservaMes: number;
    resgatesReservaMes: number;
    aportesLiquidosReservaMes: number;
    reservaComprometidaMes: number;
    gastosVariaveisRealizados: number;
    totalComprometidoMes: number;
  };
  partition: {
    fixas: { valor: number; percentualReceita: number };
    reserva: { valor: number; percentualReceita: number };
    variaveis: { valor: number; percentualReceita: number };
    livre: { valor: number; percentualReceita: number };
  };
}

const HEALTH_ATTENTION_RATIO_THRESHOLD = 0.15;

export function roundCurrency(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function parseReferenceDateStrict(dateInput?: string): ParsedReferenceDate {
  const dateString = dateInput ?? new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new AppError(
      'Data de referência inválida. Use o formato YYYY-MM-DD.',
      400,
      'INVALID_REFERENCE_DATE',
    );
  }

  const parsed = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateString) {
    throw new AppError('Data de referência inválida no calendário.', 400, 'INVALID_REFERENCE_DATE');
  }

  const year = parsed.getUTCFullYear();
  const monthNumber = parsed.getUTCMonth() + 1;
  const day = parsed.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const diasRestantes = Math.max(1, daysInMonth - day + 1);

  return {
    referenceDate: dateString,
    month: dateString.slice(0, 7),
    year,
    monthNumber,
    day,
    daysInMonth,
    diasRestantes,
    gte: new Date(Date.UTC(year, monthNumber - 1, 1)),
    lt: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

function calculatePercentOfIncome(valor: number, receitasMes: number): number {
  if (receitasMes <= 0 || valor <= 0) {
    return 0;
  }
  return roundCurrency((valor / receitasMes) * 100);
}

export function calculateSafeToSpend(
  input: SafeToSpendCalculationInput,
): SafeToSpendCalculationResult {
  const receitasPagas = roundCurrency(Math.max(0, input.receitasPagas));
  const receitasPendentes = roundCurrency(Math.max(0, input.receitasPendentes));
  const receitasMes = roundCurrency(receitasPagas + receitasPendentes);

  const contasFixasPagas = roundCurrency(Math.max(0, input.contasFixasPagas));
  const contasFixasPendentes = roundCurrency(Math.max(0, input.contasFixasPendentes));
  const contasFixasTotal = roundCurrency(contasFixasPagas + contasFixasPendentes);

  const gastosVariaveisRealizados = roundCurrency(Math.max(0, input.gastosVariaveisRealizados));

  const pctPaguePrimeiro = roundCurrency(Math.min(100, Math.max(0, input.pctPaguePrimeiro)));
  const metaReservaPlanejada = roundCurrency(receitasMes * (pctPaguePrimeiro / 100));

  const aportesReservaMes = roundCurrency(Math.max(0, input.aportesReservaMes));
  const resgatesReservaMes = roundCurrency(Math.max(0, input.resgatesReservaMes));
  const aportesLiquidosReservaMes = roundCurrency(aportesReservaMes - resgatesReservaMes);

  // Garante a proteção mínima planejada sem duplicar o que já foi transferido ao cofre,
  // mas reconhece aportes líquidos extras realizados acima da meta planejada do mês.
  const reservaComprometidaMes = roundCurrency(
    Math.max(metaReservaPlanejada, Math.max(0, aportesLiquidosReservaMes)),
  );

  const totalComprometidoMes = roundCurrency(
    contasFixasTotal + reservaComprometidaMes + gastosVariaveisRealizados,
  );
  const saldoLivreMes = roundCurrency(receitasMes - totalComprometidoMes);

  const { diasRestantes } = input.reference;
  const saldoDiarioReal = roundCurrency(saldoLivreMes / diasRestantes);

  let status: SafeToSpendStatus;
  let quantoPossoGastarHoje = 0;

  if (receitasMes <= 0) {
    status = 'SEM_RECEITA';
    quantoPossoGastarHoje = 0;
  } else if (saldoLivreMes <= 0) {
    // Estouro no ciclo zera o limite diário sem carregar saldo negativo punitivo para o próximo mês.
    status = 'ESGOTADO';
    quantoPossoGastarHoje = 0;
  } else {
    quantoPossoGastarHoje = saldoDiarioReal;
    status =
      saldoLivreMes / receitasMes <= HEALTH_ATTENTION_RATIO_THRESHOLD ? 'ATENCAO' : 'SAUDAVEL';
  }

  const livrePositivo = roundCurrency(Math.max(0, saldoLivreMes));

  return {
    referenceDate: input.reference.referenceDate,
    month: input.reference.month,
    daysInMonth: input.reference.daysInMonth,
    diasRestantes,
    status,
    quantoPossoGastarHoje,
    saldoLivreMes,
    saldoDiarioReal,
    breakdown: {
      receitasMes,
      receitasPagas,
      receitasPendentes,
      contasFixasTotal,
      contasFixasPagas,
      contasFixasPendentes,
      pctPaguePrimeiro,
      metaReservaPlanejada,
      aportesReservaMes,
      resgatesReservaMes,
      aportesLiquidosReservaMes,
      reservaComprometidaMes,
      gastosVariaveisRealizados,
      totalComprometidoMes,
    },
    partition: {
      fixas: {
        valor: contasFixasTotal,
        percentualReceita: calculatePercentOfIncome(contasFixasTotal, receitasMes),
      },
      reserva: {
        valor: reservaComprometidaMes,
        percentualReceita: calculatePercentOfIncome(reservaComprometidaMes, receitasMes),
      },
      variaveis: {
        valor: gastosVariaveisRealizados,
        percentualReceita: calculatePercentOfIncome(gastosVariaveisRealizados, receitasMes),
      },
      livre: {
        valor: livrePositivo,
        percentualReceita: calculatePercentOfIncome(livrePositivo, receitasMes),
      },
    },
  };
}
