import { AppError } from '../../shared/errors/app-error.js';

export function getCurrentMonthIso(): string {
  return new Date().toISOString().slice(0, 7);
}

export function getMonthRange(month: string): {
  year: number;
  monthNumber: number;
  gte: Date;
  lt: Date;
} {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new AppError('Mês inválido. Use o formato YYYY-MM.', 400, 'INVALID_MONTH');
  }

  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNumber = Number(monthStr);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(monthNumber) ||
    monthNumber < 1 ||
    monthNumber > 12
  ) {
    throw new AppError('Mês inválido.', 400, 'INVALID_MONTH');
  }

  const gte = new Date(Date.UTC(year, monthNumber - 1, 1));
  const lt = new Date(Date.UTC(year, monthNumber, 1));

  return { year, monthNumber, gte, lt };
}

export function resolveCompetenceDateForMonth(month: string, diaVencimento: number): Date {
  const { year, monthNumber } = getMonthRange(month);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const clampedDay = Math.min(Math.max(1, Math.trunc(diaVencimento)), daysInMonth);
  return new Date(Date.UTC(year, monthNumber - 1, clampedDay));
}

export function buildRecurrenceHashDedup(recorrenciaId: string, month: string): string {
  return `rec:${recorrenciaId}:${month}`;
}
