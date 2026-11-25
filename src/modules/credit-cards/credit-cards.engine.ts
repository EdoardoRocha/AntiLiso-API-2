import { AppError } from '../../shared/errors/app-error.js';
import { getMonthRange } from '../recurrences/recurrences.utils.js';
import { parseReferenceDateStrict, roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';

export type CeilingAlertStatus = 'OK' | 'PROXIMO' | 'ATINGIDO' | 'SEM_TETO';
export type InvoiceStatus = 'VAZIA' | 'ABERTA' | 'FECHADA' | 'VENCIDA' | 'PAGA';

export interface InvoiceCycleWindow {
  month: string;
  periodStartGte: Date;
  periodEndLt: Date;
  periodStartIso: string;
  closingDateIso: string;
  dueDateIso: string;
}

export interface CeilingAlertEvaluation {
  percentualTeto: number;
  alertaTetoAtivo: boolean;
  alertaTetoStatus: CeilingAlertStatus;
}

const DAY_MS = 86_400_000;
const CEILING_WARNING_RATIO = 0.8;

export function clampDayInMonth(year: number, monthNumber: number, day: number): number {
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Math.min(Math.max(1, Math.trunc(day)), daysInMonth);
}

function shiftMonthIso(month: string, deltaMonths: number): string {
  const { year, monthNumber } = getMonthRange(month);
  return new Date(Date.UTC(year, monthNumber - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

function assertValidBillingDay(day: number, label: string): void {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new AppError(`${label} deve ser entre 1 e 31.`, 400, 'INVALID_BILLING_DAY');
  }
}

export function getInvoiceCycleWindow(
  month: string,
  diaFechamento: number,
  diaVencimento: number,
): InvoiceCycleWindow {
  assertValidBillingDay(diaFechamento, 'Dia de fechamento');
  assertValidBillingDay(diaVencimento, 'Dia de vencimento');

  const curr = getMonthRange(month);
  const prevMonth = shiftMonthIso(month, -1);
  const prev = getMonthRange(prevMonth);

  const closingDay = clampDayInMonth(curr.year, curr.monthNumber, diaFechamento);
  const prevClosingDay = clampDayInMonth(prev.year, prev.monthNumber, diaFechamento);

  const closingDate = new Date(Date.UTC(curr.year, curr.monthNumber - 1, closingDay));
  const prevClosingDate = new Date(Date.UTC(prev.year, prev.monthNumber - 1, prevClosingDay));

  const periodStartGte = new Date(prevClosingDate.getTime() + DAY_MS);
  const periodEndLt = new Date(closingDate.getTime() + DAY_MS);

  const dueMonthStr = diaVencimento > diaFechamento ? month : shiftMonthIso(month, 1);
  const dueRange = getMonthRange(dueMonthStr);
  const dueDay = clampDayInMonth(dueRange.year, dueRange.monthNumber, diaVencimento);
  const dueDate = new Date(Date.UTC(dueRange.year, dueRange.monthNumber - 1, dueDay));

  return {
    month,
    periodStartGte,
    periodEndLt,
    periodStartIso: periodStartGte.toISOString().slice(0, 10),
    closingDateIso: closingDate.toISOString().slice(0, 10),
    dueDateIso: dueDate.toISOString().slice(0, 10),
  };
}

export function resolveOpenInvoiceMonth(referenceDateIso: string, diaFechamento: number): string {
  assertValidBillingDay(diaFechamento, 'Dia de fechamento');
  const parsed = parseReferenceDateStrict(referenceDateIso);
  const currMonth = parsed.month;
  const curr = getMonthRange(currMonth);
  const closingDay = clampDayInMonth(curr.year, curr.monthNumber, diaFechamento);
  const closingDateIso = new Date(Date.UTC(curr.year, curr.monthNumber - 1, closingDay))
    .toISOString()
    .slice(0, 10);

  return parsed.referenceDate <= closingDateIso ? currMonth : shiftMonthIso(currMonth, 1);
}

export function evaluateInvoiceStatus(input: {
  totalFatura: number;
  totalPendente: number;
  closingDateIso: string;
  dueDateIso: string;
  referenceDateIso: string;
}): InvoiceStatus {
  if (input.totalFatura <= 0) {
    return 'VAZIA';
  }
  if (input.totalPendente <= 0) {
    return 'PAGA';
  }
  if (input.referenceDateIso > input.dueDateIso) {
    return 'VENCIDA';
  }
  if (input.referenceDateIso > input.closingDateIso) {
    return 'FECHADA';
  }
  return 'ABERTA';
}

export function evaluateCeilingAlert(
  totalFatura: number,
  tetoMensalAlerta: number,
): CeilingAlertEvaluation {
  const safeTotal = roundCurrency(Math.max(0, totalFatura));
  const safeTeto = roundCurrency(Math.max(0, tetoMensalAlerta));

  if (safeTeto <= 0) {
    return {
      percentualTeto: 0,
      alertaTetoAtivo: false,
      alertaTetoStatus: 'SEM_TETO',
    };
  }

  const percentualTeto = roundCurrency((safeTotal / safeTeto) * 100);

  if (safeTotal >= safeTeto) {
    return {
      percentualTeto,
      alertaTetoAtivo: true,
      alertaTetoStatus: 'ATINGIDO',
    };
  }

  if (safeTotal >= roundCurrency(safeTeto * CEILING_WARNING_RATIO)) {
    return {
      percentualTeto,
      alertaTetoAtivo: false,
      alertaTetoStatus: 'PROXIMO',
    };
  }

  return {
    percentualTeto,
    alertaTetoAtivo: false,
    alertaTetoStatus: 'OK',
  };
}
