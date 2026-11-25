import { z } from 'zod';
import { moneyNonNegativeSchema, moneyPositiveSchema } from '../../shared/utils/money.js';
import type { CeilingAlertStatus, InvoiceStatus } from './credit-cards.engine.js';

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Mês deve estar no formato YYYY-MM');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD');

export const cardIdParamSchema = z.object({
  id: z.string().uuid('ID do cartão inválido'),
});

export const payInvoiceParamsSchema = z.object({
  id: z.string().uuid('ID do cartão inválido'),
  month: monthSchema,
});

export const listCreditCardsQuerySchema = z.object({
  date: dateSchema.optional(),
});

export const invoiceQuerySchema = z.object({
  month: monthSchema.optional(),
  date: dateSchema.optional(),
});

export const createCreditCardBodySchema = z
  .object({
    nome: z.string().trim().min(1, 'Nome do cartão é obrigatório').max(80),
    contaPagamentoId: z.string().uuid('Conta de pagamento inválida'),
    limiteTotal: moneyPositiveSchema,
    tetoMensalAlerta: moneyNonNegativeSchema,
    diaFechamento: z.number().int().min(1, 'Dia mínimo é 1').max(31, 'Dia máximo é 31'),
    diaVencimento: z.number().int().min(1, 'Dia mínimo é 1').max(31, 'Dia máximo é 31'),
  })
  .refine((data) => data.tetoMensalAlerta <= data.limiteTotal, {
    message: 'O teto mensal de alerta não pode exceder o limite total',
    path: ['tetoMensalAlerta'],
  });

export const updateCreditCardBodySchema = z
  .object({
    nome: z.string().trim().min(1, 'Nome do cartão é obrigatório').max(80).optional(),
    contaPagamentoId: z.string().uuid('Conta de pagamento inválida').optional(),
    limiteTotal: moneyPositiveSchema.optional(),
    tetoMensalAlerta: moneyNonNegativeSchema.optional(),
    diaFechamento: z.number().int().min(1, 'Dia mínimo é 1').max(31, 'Dia máximo é 31').optional(),
    diaVencimento: z.number().int().min(1, 'Dia mínimo é 1').max(31, 'Dia máximo é 31').optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Informe ao menos um campo para atualização',
  });

export const payInvoiceBodySchema = z.object({
  contaPagamentoId: z.string().uuid('Conta de pagamento inválida').optional(),
  dataPagamento: dateSchema.optional(),
});

export interface CreditCardSummaryDto {
  id: string;
  nome: string;
  contaPagamentoId: string;
  contaPagamentoNome: string;
  limiteTotal: number;
  limiteUtilizado: number;
  limiteDisponivel: number;
  tetoMensalAlerta: number;
  diaFechamento: number;
  diaVencimento: number;
  faturaAbertaMonth: string;
  fechamentoFaturaAberta: string;
  vencimentoFaturaAberta: string;
  totalFaturaAberta: number;
  percentualTeto: number;
  alertaTetoAtivo: boolean;
  alertaTetoStatus: CeilingAlertStatus;
}

export interface CreditCardInvoiceItemDto {
  id: string;
  descricao: string;
  valor: number;
  dataCompetencia: string;
  status: 'PAGO' | 'PENDENTE';
  categoriaId: string | null;
  categoriaNome: string | null;
  recorrenciaId: string | null;
}

export interface CreditCardInvoiceDto {
  cardId: string;
  cardNome: string;
  contaPagamentoId: string;
  contaPagamentoNome: string;
  month: string;
  periodStart: string;
  closingDate: string;
  dueDate: string;
  statusFatura: InvoiceStatus;
  limiteTotal: number;
  limiteUtilizado: number;
  limiteDisponivel: number;
  tetoMensalAlerta: number;
  totalFatura: number;
  totalPendente: number;
  totalPago: number;
  percentualTeto: number;
  alertaTetoAtivo: boolean;
  alertaTetoStatus: CeilingAlertStatus;
  items: CreditCardInvoiceItemDto[];
}

export interface PayInvoiceResponseDto {
  month: string;
  cardId: string;
  contaPagamentoId: string;
  valorPago: number;
  settledCount: number;
  transferTransactionId: string;
}

export interface CardCeilingAlertDto {
  cardId: string;
  cardNome: string;
  month: string;
  totalFatura: number;
  tetoMensalAlerta: number;
  percentualTeto: number;
  status: 'PROXIMO' | 'ATINGIDO';
}

export type CreateCreditCardInput = z.infer<typeof createCreditCardBodySchema>;
export type UpdateCreditCardInput = z.infer<typeof updateCreditCardBodySchema>;
export type PayInvoiceInput = z.infer<typeof payInvoiceBodySchema>;
