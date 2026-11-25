import { z } from 'zod';
import { moneyPositiveSchema } from '../../shared/utils/money.js';

export const transactionIdParamSchema = z.object({
  id: z.string().uuid('ID da transação inválido'),
});

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const createTransactionBodySchema = z
  .object({
    tipo: z.enum(['REC', 'DESP']),
    valor: moneyPositiveSchema,
    descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(200),
    contaId: z.string().uuid('Conta inválida').nullable().optional(),
    cartaoId: z.string().uuid('Cartão inválido').nullable().optional(),
    categoriaId: z.string().uuid('Categoria inválida').nullable().optional(),
    dataCompetencia: dateOnlySchema.optional(),
    status: z.enum(['PAGO', 'PENDENTE']).optional(),
    clientRequestId: z.string().uuid('clientRequestId deve ser UUID válido').optional(),
  })
  .refine((data) => !(data.contaId && data.cartaoId), {
    message: 'Informe conta ou cartão, nunca ambos',
    path: ['cartaoId'],
  });

export const quickAddBodySchema = z
  .object({
    texto: z.string().trim().min(1, 'Informe o texto do lançamento').max(240),
    tipo: z.enum(['REC', 'DESP']).optional(),
    contaId: z.string().uuid('Conta inválida').nullable().optional(),
    cartaoId: z.string().uuid('Cartão inválido').nullable().optional(),
    categoriaId: z.string().uuid('Categoria inválida').nullable().optional(),
    dataCompetencia: dateOnlySchema.optional(),
    status: z.enum(['PAGO', 'PENDENTE']).optional(),
    clientRequestId: z.string().uuid('clientRequestId deve ser UUID válido').optional(),
  })
  .refine((data) => !(data.contaId && data.cartaoId), {
    message: 'Informe conta ou cartão, nunca ambos',
    path: ['cartaoId'],
  });

export const listTransactionsQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Mês deve estar no formato YYYY-MM')
    .optional(),
  tipo: z.enum(['REC', 'DESP', 'TRANSF']).optional(),
  status: z.enum(['PAGO', 'PENDENTE']).optional(),
  contaId: z.string().uuid().optional(),
  cartaoId: z.string().uuid().optional(),
  categoriaId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateTransactionBodySchema = z
  .object({
    tipo: z.enum(['REC', 'DESP']).optional(),
    valor: moneyPositiveSchema.optional(),
    descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(200).optional(),
    contaId: z.string().uuid('Conta inválida').optional(),
    cartaoId: z.string().uuid('Cartão inválido').optional(),
    categoriaId: z.string().uuid('Categoria inválida').nullable().optional(),
    dataCompetencia: dateOnlySchema.optional(),
    status: z.enum(['PAGO', 'PENDENTE']).optional(),
  })
  .refine((data) => !(data.contaId && data.cartaoId), {
    message: 'Informe conta ou cartão, nunca ambos',
    path: ['cartaoId'],
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export interface TransactionDto {
  id: string;
  tipo: 'REC' | 'DESP' | 'TRANSF';
  valor: number;
  descricao: string;
  dataCompetencia: string;
  status: 'PAGO' | 'PENDENTE';
  contaId: string | null;
  contaNome: string | null;
  contaDestinoId: string | null;
  contaDestinoNome: string | null;
  cartaoId: string | null;
  cartaoNome: string | null;
  categoriaId: string | null;
  categoriaNome: string | null;
  criadoEm: string;
}

export interface TransactionsSummaryDto {
  totalReceitas: number;
  totalDespesas: number;
  saldoPeriodo: number;
  totalCount: number;
}

export type CreateTransactionInput = z.infer<typeof createTransactionBodySchema>;
export type QuickAddInput = z.infer<typeof quickAddBodySchema>;
export type ListTransactionsFilters = z.infer<typeof listTransactionsQuerySchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionBodySchema>;
