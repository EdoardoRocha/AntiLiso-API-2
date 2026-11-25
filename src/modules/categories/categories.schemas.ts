import { z } from 'zod';
import { moneyNonNegativeSchema } from '../../shared/utils/money.js';

export const categoryIdParamSchema = z.object({
  id: z.string().uuid('ID da categoria inválido'),
});

export const listCategoriesQuerySchema = z.object({
  tipo: z.enum(['RECEITA', 'DESPESA']).optional(),
  ehEssencial: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const createCategoryBodySchema = z.object({
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(60),
  tipo: z.enum(['RECEITA', 'DESPESA']),
  ehEssencial: z.boolean().default(false),
  orcamentoMensal: moneyNonNegativeSchema.nullable().optional(),
});

export const updateCategoryBodySchema = z
  .object({
    nome: z.string().trim().min(1, 'Nome é obrigatório').max(60).optional(),
    ehEssencial: z.boolean().optional(),
    orcamentoMensal: moneyNonNegativeSchema.nullable().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const categoryDtoSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  tipo: z.enum(['RECEITA', 'DESPESA']),
  ehEssencial: z.boolean(),
  orcamentoMensal: z.number().nullable(),
});

export type ListCategoriesFilters = z.infer<typeof listCategoriesQuerySchema>;
export type CreateCategoryInput = z.infer<typeof createCategoryBodySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryBodySchema>;
export type CategoryDto = z.infer<typeof categoryDtoSchema>;
