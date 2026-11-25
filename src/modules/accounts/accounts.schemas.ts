import { z } from 'zod';
import { moneyPositiveSchema, moneySignedSchema } from '../../shared/utils/money.js';

export const accountIdParamSchema = z.object({
  id: z.string().uuid('ID da conta inválido'),
});

export const listAccountsQuerySchema = z.object({
  includeInactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const createAccountBodySchema = z.object({
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(80),
  tipo: z.enum(['CORRENTE', 'CARTEIRA', 'COFRE']),
  saldoAtual: moneySignedSchema.default(0),
  ehContaPadrao: z.boolean().default(false),
});

export const updateAccountBodySchema = z
  .object({
    nome: z.string().trim().min(1, 'Nome é obrigatório').max(80).optional(),
    ehContaPadrao: z.boolean().optional(),
    ativa: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const createTransferBodySchema = z.object({
  contaOrigemId: z.string().uuid('Conta de origem inválida'),
  contaDestinoId: z.string().uuid('Conta de destino inválida'),
  valor: moneyPositiveSchema,
  descricao: z.string().trim().min(1).max(200).default('Transferência entre contas'),
  dataCompetencia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD')
    .optional(),
});

export const accountDtoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  tipo: z.enum(['CORRENTE', 'CARTEIRA', 'COFRE']),
  saldoAtual: z.number(),
  ehContaPadrao: z.boolean(),
  ativa: z.boolean(),
  ehCofreReserva: z.boolean(),
});

export const transferDtoSchema = z.object({
  id: z.string().uuid(),
  tipo: z.literal('TRANSF'),
  contaId: z.string().uuid(),
  contaDestinoId: z.string().uuid(),
  valor: z.number(),
  descricao: z.string(),
  dataCompetencia: z.string(),
  status: z.enum(['PAGO', 'PENDENTE']),
});

export type CreateAccountInput = z.infer<typeof createAccountBodySchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountBodySchema>;
export type CreateTransferInput = z.infer<typeof createTransferBodySchema>;
export type AccountDto = z.infer<typeof accountDtoSchema>;
export type TransferDto = z.infer<typeof transferDtoSchema>;
