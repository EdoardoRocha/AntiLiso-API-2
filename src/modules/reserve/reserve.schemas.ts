import { z } from 'zod';
import {
  moneyNonNegativeSchema,
  moneyPositiveSchema,
  percentSchema,
} from '../../shared/utils/money.js';
import type {
  InvestmentTriggerStatus,
  MonthlyReservePriorityResult,
  ReserveThermometerResult,
  WithdrawalImpactSimulation,
} from './reserve.engine.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const reserveOverviewQuerySchema = z.object({
  date: dateSchema.optional(),
});

export const updateReserveConfigBodySchema = z
  .object({
    custoVidaMensal: moneyNonNegativeSchema.optional(),
    mesesReservaAlvo: z
      .number()
      .int()
      .min(3, 'Mínimo de 3 meses')
      .max(12, 'Máximo de 12 meses')
      .optional(),
    pctPaguePrimeiro: percentSchema.optional(),
    gatilhoInvestPct: percentSchema.optional(),
    travaResgateAtiva: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const createReserveDepositBodySchema = z.object({
  contaOrigemId: z.string().uuid('Conta de origem inválida').optional(),
  valor: moneyPositiveSchema,
  descricao: z.string().trim().min(1).max(180).optional(),
  dataMovimento: dateSchema.optional(),
});

export const createReserveWithdrawalBodySchema = z.object({
  contaDestinoId: z.string().uuid('Conta de destino inválida').optional(),
  valor: moneyPositiveSchema,
  justificativaResgate: z
    .string()
    .trim()
    .min(15, 'A justificativa auditável deve ter no mínimo 15 caracteres')
    .max(500),
  confirmacaoDuasEtapas: z.boolean().refine((value): value is true => value === true, {
    message: 'Confirme as duas etapas da trava psicológica antes de resgatar',
  }),
  dataMovimento: dateSchema.optional(),
});

export interface ReserveCalculatorSuggestionDto {
  fixasEssenciaisAtivas: number;
  gastosEssenciaisMesAtual: number;
  orcamentoCategoriasEssenciais: number;
  custoEssencialSugerido: number;
}

export interface ReserveMovementDto {
  id: string;
  tipo: 'APORTE' | 'RESGATE';
  valor: number;
  justificativaResgate: string | null;
  dataMovimento: string;
  transacaoOrigemId: string | null;
}

export interface ReserveOverviewDto {
  reservaId: string;
  contaCofreId: string;
  contaCofreNome: string;
  referenceDate: string;
  month: string;
  custoVidaMensal: number;
  mesesReservaAlvo: number;
  pctPaguePrimeiro: number;
  gatilhoInvestPct: number;
  valorMetaCalculado: number;
  saldoAcumulado: number;
  travaResgateAtiva: boolean;
  statusGatilho: InvestmentTriggerStatus;
  calculatorSuggestion: ReserveCalculatorSuggestionDto;
  thermometer: ReserveThermometerResult;
  monthlyPriority: MonthlyReservePriorityResult;
  movements: ReserveMovementDto[];
}

export interface ReserveSplitSuggestionDto {
  pctPaguePrimeiro: number;
  valorReceita: number;
  valorSugerido: number;
  contaOrigemId: string;
  valorMetaCalculado: number;
  saldoAcumulado: number;
  faltaParaMeta: number;
  metaConcluida: boolean;
}

export interface ReserveMutationResponseDto {
  movement: ReserveMovementDto;
  overview: ReserveOverviewDto;
}

export interface ReserveWithdrawalResponseDto extends ReserveMutationResponseDto {
  impact: WithdrawalImpactSimulation;
}

export type UpdateReserveConfigInput = z.infer<typeof updateReserveConfigBodySchema>;
export type CreateReserveDepositInput = z.infer<typeof createReserveDepositBodySchema>;
export type CreateReserveWithdrawalInput = z.infer<typeof createReserveWithdrawalBodySchema>;
