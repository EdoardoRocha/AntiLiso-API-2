import { z } from 'zod';

const MAX_MONEY = 9_999_999_999.99;

function hasAtMostTwoDecimals(value: number): boolean {
  return Number.isFinite(value) && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

export const moneyPositiveSchema = z
  .number()
  .finite()
  .gt(0, 'Valor deve ser maior que zero')
  .max(MAX_MONEY)
  .refine(hasAtMostTwoDecimals, 'Valor deve ter no máximo 2 casas decimais');

export const moneyNonNegativeSchema = z
  .number()
  .finite()
  .min(0, 'Valor não pode ser negativo')
  .max(MAX_MONEY)
  .refine(hasAtMostTwoDecimals, 'Valor deve ter no máximo 2 casas decimais');

export const moneySignedSchema = z
  .number()
  .finite()
  .min(-MAX_MONEY)
  .max(MAX_MONEY)
  .refine(hasAtMostTwoDecimals, 'Valor deve ter no máximo 2 casas decimais');

export const percentSchema = z
  .number()
  .finite()
  .min(0, 'Percentual mínimo é 0')
  .max(100, 'Percentual máximo é 100')
  .refine(hasAtMostTwoDecimals, 'Percentual deve ter no máximo 2 casas decimais');

export function toDecimalString(value: number): string {
  return value.toFixed(2);
}

export function decimalToNumber(
  value: { toFixed(digits?: number): string } | number | string,
): number {
  return Number(Number(value).toFixed(2));
}
