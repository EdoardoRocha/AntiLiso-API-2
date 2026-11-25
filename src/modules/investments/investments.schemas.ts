import { z } from 'zod';
import {
  moneyNonNegativeSchema,
  moneyPositiveSchema,
  percentSchema,
} from '../../shared/utils/money.js';
import type {
  AssetClass,
  CompoundSimulationResult,
  ConsolidatedClassSummary,
  RebalancePlanResult,
} from './investments.engine.js';

export const assetClassSchema = z.enum(['RF', 'FII', 'ACOES', 'INT', 'CRIPTO']);

function hasAtMostSixDecimals(value: number): boolean {
  return (
    Number.isFinite(value) && Math.abs(Math.round(value * 1_000_000) - value * 1_000_000) < 1e-6
  );
}

export const quantityNonNegativeSchema = z
  .number()
  .finite()
  .min(0, 'Quantidade não pode ser negativa')
  .max(99_999_999.999999, 'Quantidade excede o limite permitido')
  .refine(hasAtMostSixDecimals, 'Quantidade deve ter no máximo 6 casas decimais');

export const assetIdParamSchema = z.object({
  id: z.string().uuid('ID do ativo inválido.'),
});

export const investmentsOverviewQuerySchema = z.object({
  valorAporte: z.coerce.number().positive().max(9_999_999_999.99).optional(),
});

export const putAllocationsBodySchema = z
  .object({
    allocations: z
      .array(
        z.object({
          classeAtivo: assetClassSchema,
          percentualIdeal: percentSchema,
        }),
      )
      .length(5, 'Informe exatamente as 5 classes de ativos (RF, FII, ACOES, INT, CRIPTO).'),
  })
  .superRefine((val, ctx) => {
    const unique = new Set(val.allocations.map((a) => a.classeAtivo));
    if (unique.size !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Cada classe de ativo deve aparecer exatamente uma vez.',
        path: ['allocations'],
      });
    }

    const sum =
      Math.round(val.allocations.reduce((acc, item) => acc + item.percentualIdeal, 0) * 100) / 100;
    if (Math.abs(sum - 100) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A soma dos percentuais ideais deve ser exatamente 100% (atual: ${sum.toFixed(2)}%).`,
        path: ['allocations'],
      });
    }
  });

export const createAssetBodySchema = z.object({
  classeAtivo: assetClassSchema,
  tickerOuNome: z.string().trim().min(1, 'Ticker ou nome é obrigatório.').max(60),
  quantidade: quantityNonNegativeSchema,
  valorInvestido: moneyNonNegativeSchema,
  saldoAtualMercado: moneyNonNegativeSchema,
});

export const updateAssetBodySchema = z
  .object({
    classeAtivo: assetClassSchema.optional(),
    tickerOuNome: z.string().trim().min(1, 'Ticker ou nome é obrigatório.').max(60).optional(),
    quantidade: quantityNonNegativeSchema.optional(),
    valorInvestido: moneyNonNegativeSchema.optional(),
    saldoAtualMercado: moneyNonNegativeSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização.',
  });

export const addAssetContributionBodySchema = z.object({
  valorAporte: moneyPositiveSchema,
  quantidadeAdicional: quantityNonNegativeSchema.default(0),
  saldoMercadoAdicional: moneyPositiveSchema.optional(),
});

export const rebalanceBodySchema = z.object({
  valorAporte: moneyPositiveSchema,
});

export const simulateCompoundBodySchema = z.object({
  saldoInicial: moneyNonNegativeSchema,
  aporteMensal: moneyNonNegativeSchema,
  taxaAnualRealPct: z
    .number()
    .finite()
    .min(0, 'Taxa mínima é 0% ao ano')
    .max(100, 'Taxa máxima é 100% ao ano'),
  metaPatrimonio: moneyPositiveSchema.nullable().optional(),
});

export type PutAllocationsInput = z.infer<typeof putAllocationsBodySchema>;
export type CreateAssetInput = z.infer<typeof createAssetBodySchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetBodySchema>;
export type AddAssetContributionInput = z.infer<typeof addAssetContributionBodySchema>;
export type RebalanceInput = z.infer<typeof rebalanceBodySchema>;
export type SimulateCompoundInput = z.infer<typeof simulateCompoundBodySchema>;

export interface InvestmentTriggerStateDto {
  statusGatilho: 'BLOQUEADO' | 'LIBERADO';
  modoEducativoAtivo: boolean;
  gatilhoInvestPct: number;
  valorMetaReserva: number;
  saldoReservaAtual: number;
  percentualReservaAtual: number;
  valorGatilhoRequerido: number;
  faltaParaDesbloquear: number;
}

export interface InvestmentsOverviewDto {
  trigger: InvestmentTriggerStateDto;
  valorInvestidoCarteira: number;
  patrimonioCarteira: number;
  lucroPrejuizoCarteira: number;
  rentabilidadeCarteiraPct: number;
  saldoContasLiquidas: number;
  saldoReservaEmergencia: number;
  patrimonioTotalGlobal: number;
  classes: ConsolidatedClassSummary[];
  rebalanceSugerido: RebalancePlanResult | null;
}

export interface PortfolioAssetResponseDto {
  asset: {
    id: string;
    alocacaoId: string;
    classeAtivo: AssetClass;
    tickerOuNome: string;
    quantidade: number;
    valorInvestido: number;
    saldoAtualMercado: number;
  };
  overview: InvestmentsOverviewDto;
}

export type CompoundSimulationDto = CompoundSimulationResult;
export type RebalancePlanDto = RebalancePlanResult;
