import { z } from 'zod';

export const suggestCategoryQuerySchema = z.object({
  descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(240),
  tipo: z.enum(['REC', 'DESP']).default('DESP'),
});

export const createLearningRuleBodySchema = z.object({
  termoChave: z.string().trim().min(2, 'Termo deve ter ao menos 2 caracteres').max(80),
  categoriaId: z.string().uuid('Categoria inválida'),
});

export const ruleIdParamSchema = z.object({
  id: z.string().uuid('ID da regra inválido'),
});

export interface LearningRuleDto {
  id: string;
  termoChave: string;
  hitsConfianca: number;
  categoriaId: string;
  categoriaNome: string;
  categoriaTipo: 'RECEITA' | 'DESPESA';
}

export interface CategorySuggestionDto {
  categoriaId: string;
  categoriaNome: string;
  source: 'RULE' | 'CATEGORY_NAME';
  termoChave: string | null;
  hitsConfianca: number | null;
}

export type CreateLearningRuleInput = z.infer<typeof createLearningRuleBodySchema>;
