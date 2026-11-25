import { z } from 'zod';
import { moneyPositiveSchema } from '../../shared/utils/money.js';
import type { CardCeilingAlertDto } from '../credit-cards/credit-cards.schemas.js';
import type { ImportFormat, ImportTargetType } from './imports.engine.js';

export const importTargetTypeSchema = z.enum(['CONTA', 'CARTAO']);
export const importFormatSchema = z.enum(['OFX', 'CSV']);
export const importPreviewStatusSchema = z.enum([
  'NOVO',
  'DUPLICADO_HASH',
  'POSSIVEL_DUPLICATA_MANUAL',
  'IGNORADO_CREDITO_CARTAO',
  'IGNORADO_VALOR_ZERO',
]);

export type ImportPreviewStatus = z.infer<typeof importPreviewStatusSchema>;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const previewImportBodySchema = z
  .object({
    fileName: z.string().trim().min(1, 'Nome do arquivo é obrigatório.').max(255),
    content: z
      .string()
      .min(1, 'Conteúdo do arquivo está vazio.')
      .max(1_500_000, 'Arquivo excede o limite máximo permitido (1,5 MB de texto).'),
    format: importFormatSchema.optional(),
    targetType: importTargetTypeSchema,
    contaId: z.string().uuid('Conta inválida.').nullable().optional(),
    cartaoId: z.string().uuid('Cartão inválido.').nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.targetType === 'CONTA' && (!val.contaId || val.cartaoId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Informe contaId (e não cartaoId) quando o destino for CONTA.',
        path: ['contaId'],
      });
    }
    if (val.targetType === 'CARTAO' && (!val.cartaoId || val.contaId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Informe cartaoId (e não contaId) quando o destino for CARTAO.',
        path: ['cartaoId'],
      });
    }
  });

export const commitImportItemSchema = z.object({
  dataCompetencia: dateSchema,
  descricao: z.string().trim().min(1, 'Descrição é obrigatória.').max(255),
  valor: moneyPositiveSchema,
  tipo: z.enum(['REC', 'DESP']),
  categoriaId: z.string().uuid('Categoria inválida.').nullable().optional(),
  hashDedup: z
    .string()
    .trim()
    .min(8, 'hashDedup inválido.')
    .max(64, 'hashDedup não pode exceder 64 caracteres.'),
});

export const commitImportBodySchema = z
  .object({
    targetType: importTargetTypeSchema,
    contaId: z.string().uuid('Conta inválida.').nullable().optional(),
    cartaoId: z.string().uuid('Cartão inválido.').nullable().optional(),
    items: z
      .array(commitImportItemSchema)
      .min(1, 'Selecione ao menos 1 lançamento para importar.')
      .max(1000, 'Limite máximo de 1.000 lançamentos por importação.'),
  })
  .superRefine((val, ctx) => {
    if (val.targetType === 'CONTA' && (!val.contaId || val.cartaoId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Informe contaId (e não cartaoId) quando o destino for CONTA.',
        path: ['contaId'],
      });
    }
    if (val.targetType === 'CARTAO') {
      if (!val.cartaoId || val.contaId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Informe cartaoId (e não contaId) quando o destino for CARTAO.',
          path: ['cartaoId'],
        });
      }
      val.items.forEach((item, index) => {
        if (item.tipo === 'REC') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Cartões de crédito aceitam apenas despesas (DESP).',
            path: ['items', index, 'tipo'],
          });
        }
      });
    }
  });

export type PreviewImportInput = z.infer<typeof previewImportBodySchema>;
export type CommitImportInput = z.infer<typeof commitImportBodySchema>;
export type CommitImportItemInput = z.infer<typeof commitImportItemSchema>;

export interface ImportPreviewItemDto {
  rowIndex: number;
  lineNumber: number;
  status: ImportPreviewStatus;
  selectedByDefault: boolean;
  canImport: boolean;
  statusReason: string | null;
  dataCompetencia: string;
  descricao: string;
  valor: number;
  tipo: 'REC' | 'DESP';
  hashDedup: string | null;
  categoriaSugeridaId: string | null;
  categoriaSugeridaNome: string | null;
  suggestionSource: 'RULE' | 'CATEGORY_NAME' | null;
  matchedManualTransaction: {
    id: string;
    descricao: string;
    dataCompetencia: string;
    valor: number;
  } | null;
}

export interface PreviewImportResponseDto {
  format: ImportFormat;
  targetType: ImportTargetType;
  targetId: string;
  targetNome: string;
  summary: {
    totalRows: number;
    readyCount: number;
    exactDuplicateCount: number;
    fuzzyDuplicateCount: number;
    ignoredCount: number;
    estimatedReceitas: number;
    estimatedDespesas: number;
    estimatedNetImpact: number;
  };
  items: ImportPreviewItemDto[];
}

export interface CommitImportResponseDto {
  targetType: ImportTargetType;
  targetId: string;
  importedCount: number;
  skippedDuplicateCount: number;
  totalReceitasImportadas: number;
  totalDespesasImportadas: number;
  netBalanceDelta: number;
  cardAlert: CardCeilingAlertDto | null;
}
