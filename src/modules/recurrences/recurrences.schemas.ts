import { z } from 'zod';
import { moneyPositiveSchema } from '../../shared/utils/money.js';

export const recurrenceIdParamSchema = z.object({
  id: z.string().uuid('ID da recorrência inválido'),
});

export const monthStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Mês deve estar no formato YYYY-MM');

export const listRecurrencesQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const createRecurrenceBodySchema = z
  .object({
    descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(150),
    valorEstimado: moneyPositiveSchema,
    diaVencimento: z.number().int().min(1, 'Dia mínimo é 1').max(31, 'Dia máximo é 31'),
    categoriaId: z.string().uuid('Categoria inválida'),
    contaId: z.string().uuid('Conta inválida').nullable().optional(),
    cartaoId: z.string().uuid('Cartão inválido').nullable().optional(),
    ativa: z.boolean().default(true),
  })
  .refine((data) => !(data.contaId && data.cartaoId), {
    message: 'Informe conta ou cartão, nunca ambos',
    path: ['cartaoId'],
  });

export const updateRecurrenceBodySchema = z
  .object({
    descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(150).optional(),
    valorEstimado: moneyPositiveSchema.optional(),
    diaVencimento: z.number().int().min(1).max(31).optional(),
    categoriaId: z.string().uuid('Categoria inválida').optional(),
    contaId: z.string().uuid('Conta inválida').optional(),
    cartaoId: z.string().uuid('Cartão inválido').optional(),
    ativa: z.boolean().optional(),
  })
  .refine((data) => !(data.contaId && data.cartaoId), {
    message: 'Informe conta ou cartão, nunca ambos',
    path: ['cartaoId'],
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const generateRecurrencesBodySchema = z.object({
  month: monthStringSchema.optional(),
});

export const checklistQuerySchema = z.object({
  month: monthStringSchema.optional(),
});

export interface RecurrenceDto {
  id: string;
  descricao: string;
  valorEstimado: number;
  diaVencimento: number;
  ativa: boolean;
  categoriaId: string;
  categoriaNome: string;
  categoriaTipo: 'RECEITA' | 'DESPESA';
  ehEssencial: boolean;
  contaId: string | null;
  contaNome: string | null;
  cartaoId: string | null;
  cartaoNome: string | null;
}

export interface ChecklistItemDto {
  id: string;
  recorrenciaId: string;
  descricao: string;
  tipo: 'REC' | 'DESP';
  valor: number;
  valorEstimado: number;
  dataCompetencia: string;
  diaVencimento: number;
  status: 'PAGO' | 'PENDENTE';
  contaId: string | null;
  contaNome: string | null;
  cartaoId: string | null;
  cartaoNome: string | null;
  categoriaId: string | null;
  categoriaNome: string | null;
  ehEssencial: boolean;
}

export interface ChecklistSummaryDto {
  totalFixasDespesas: number;
  totalPagoDespesas: number;
  totalPendenteDespesas: number;
  totalFixasReceitas: number;
  countTotal: number;
  countPagas: number;
  countPendentes: number;
}

export interface MonthlyChecklistResponseDto {
  month: string;
  items: ChecklistItemDto[];
  summary: ChecklistSummaryDto;
}

export interface GenerateRecurrencesResponseDto {
  month: string;
  generatedCount: number;
  existingCount: number;
}

export type CreateRecurrenceInput = z.infer<typeof createRecurrenceBodySchema>;
export type UpdateRecurrenceInput = z.infer<typeof updateRecurrenceBodySchema>;
