import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { generateMonthlyRecurrences } from '../recurrences/recurrences.service.js';
import { parseReferenceDateStrict, roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';
import {
  evaluateCeilingAlert,
  evaluateInvoiceStatus,
  getInvoiceCycleWindow,
  resolveOpenInvoiceMonth,
} from './credit-cards.engine.js';
import type {
  CardCeilingAlertDto,
  CreateCreditCardInput,
  CreditCardInvoiceDto,
  CreditCardSummaryDto,
  PayInvoiceInput,
  PayInvoiceResponseDto,
  UpdateCreditCardInput,
} from './credit-cards.schemas.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

async function validateOwnedPaymentAccount(
  db: DbClient,
  userId: string,
  accountId: string,
): Promise<{ id: string; nome: string; tipo: string }> {
  const account = await db.conta.findFirst({
    where: { id: accountId, usuarioId: userId },
    select: { id: true, nome: true, tipo: true, ativa: true },
  });

  if (!account) {
    throw new AppError('Conta de pagamento não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
  }

  if (!account.ativa) {
    throw new AppError(
      'A conta de pagamento selecionada está inativa.',
      400,
      'INVALID_PAYMENT_ACCOUNT',
    );
  }

  if (account.tipo === 'COFRE') {
    throw new AppError(
      'Contas do tipo Cofre não podem pagar faturas diretamente.',
      400,
      'INVALID_PAYMENT_ACCOUNT',
    );
  }

  return account;
}

async function ensureRecurrencesForMonth(userId: string, month: string): Promise<void> {
  await generateMonthlyRecurrences(userId, month);
}

async function getCardPendingUsedLimit(
  db: DbClient,
  userId: string,
  cardId: string,
): Promise<number> {
  const agg = await db.transacao.aggregate({
    where: {
      usuarioId: userId,
      cartaoId: cardId,
      tipo: 'DESP',
      status: 'PENDENTE',
    },
    _sum: { valor: true },
  });

  return agg._sum.valor ? decimalToNumber(agg._sum.valor) : 0;
}

async function buildCardSummary(
  userId: string,
  card: {
    id: string;
    nome: string;
    contaPagamentoId: string;
    limiteTotal: Prisma.Decimal;
    tetoMensalAlerta: Prisma.Decimal;
    diaFechamento: number;
    diaVencimento: number;
    contaPagamento: { id: string; nome: string };
  },
  referenceDateIso: string,
): Promise<CreditCardSummaryDto> {
  const faturaAbertaMonth = resolveOpenInvoiceMonth(referenceDateIso, card.diaFechamento);
  const window = getInvoiceCycleWindow(faturaAbertaMonth, card.diaFechamento, card.diaVencimento);

  const [limiteUtilizado, openInvoiceAgg] = await Promise.all([
    getCardPendingUsedLimit(prisma, userId, card.id),
    prisma.transacao.aggregate({
      where: {
        usuarioId: userId,
        cartaoId: card.id,
        tipo: 'DESP',
        dataCompetencia: {
          gte: window.periodStartGte,
          lt: window.periodEndLt,
        },
      },
      _sum: { valor: true },
    }),
  ]);

  const limiteTotal = decimalToNumber(card.limiteTotal);
  const tetoMensalAlerta = decimalToNumber(card.tetoMensalAlerta);
  const totalFaturaAberta = openInvoiceAgg._sum.valor
    ? decimalToNumber(openInvoiceAgg._sum.valor)
    : 0;
  const ceiling = evaluateCeilingAlert(totalFaturaAberta, tetoMensalAlerta);

  return {
    id: card.id,
    nome: card.nome,
    contaPagamentoId: card.contaPagamentoId,
    contaPagamentoNome: card.contaPagamento.nome,
    limiteTotal,
    limiteUtilizado,
    limiteDisponivel: roundCurrency(limiteTotal - limiteUtilizado),
    tetoMensalAlerta,
    diaFechamento: card.diaFechamento,
    diaVencimento: card.diaVencimento,
    faturaAbertaMonth,
    fechamentoFaturaAberta: window.closingDateIso,
    vencimentoFaturaAberta: window.dueDateIso,
    totalFaturaAberta,
    percentualTeto: ceiling.percentualTeto,
    alertaTetoAtivo: ceiling.alertaTetoAtivo,
    alertaTetoStatus: ceiling.alertaTetoStatus,
  };
}

export async function listCreditCards(
  userId: string,
  dateInput?: string,
): Promise<CreditCardSummaryDto[]> {
  const reference = parseReferenceDateStrict(dateInput);

  const cards = await prisma.cartaoCredito.findMany({
    where: { usuarioId: userId },
    include: {
      contaPagamento: { select: { id: true, nome: true } },
    },
    orderBy: [{ nome: 'asc' }],
  });

  if (cards.length === 0) {
    return [];
  }

  await ensureRecurrencesForMonth(userId, reference.month);

  return Promise.all(cards.map((card) => buildCardSummary(userId, card, reference.referenceDate)));
}

export async function createCreditCard(
  userId: string,
  input: CreateCreditCardInput,
): Promise<CreditCardSummaryDto> {
  await validateOwnedPaymentAccount(prisma, userId, input.contaPagamentoId);

  if (input.tetoMensalAlerta > input.limiteTotal) {
    throw new AppError(
      'O teto mensal de alerta não pode exceder o limite total.',
      400,
      'INVALID_CEILING_ALERT',
    );
  }

  const created = await prisma.cartaoCredito.create({
    data: {
      usuarioId: userId,
      contaPagamentoId: input.contaPagamentoId,
      nome: input.nome,
      limiteTotal: toDecimalString(input.limiteTotal),
      tetoMensalAlerta: toDecimalString(input.tetoMensalAlerta),
      diaFechamento: input.diaFechamento,
      diaVencimento: input.diaVencimento,
    },
    include: {
      contaPagamento: { select: { id: true, nome: true } },
    },
  });

  const reference = parseReferenceDateStrict();
  return buildCardSummary(userId, created, reference.referenceDate);
}

export async function updateCreditCard(
  userId: string,
  cardId: string,
  input: UpdateCreditCardInput,
): Promise<CreditCardSummaryDto> {
  const existing = await prisma.cartaoCredito.findFirst({
    where: { id: cardId, usuarioId: userId },
  });

  if (!existing) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  if (input.contaPagamentoId !== undefined) {
    await validateOwnedPaymentAccount(prisma, userId, input.contaPagamentoId);
  }

  const nextLimite =
    input.limiteTotal !== undefined ? input.limiteTotal : decimalToNumber(existing.limiteTotal);
  const nextTeto =
    input.tetoMensalAlerta !== undefined
      ? input.tetoMensalAlerta
      : decimalToNumber(existing.tetoMensalAlerta);

  if (nextTeto > nextLimite) {
    throw new AppError(
      'O teto mensal de alerta não pode exceder o limite total.',
      400,
      'INVALID_CEILING_ALERT',
    );
  }

  const updated = await prisma.cartaoCredito.update({
    where: { id: existing.id },
    data: {
      ...(input.nome !== undefined ? { nome: input.nome } : {}),
      ...(input.contaPagamentoId !== undefined ? { contaPagamentoId: input.contaPagamentoId } : {}),
      ...(input.limiteTotal !== undefined
        ? { limiteTotal: toDecimalString(input.limiteTotal) }
        : {}),
      ...(input.tetoMensalAlerta !== undefined
        ? { tetoMensalAlerta: toDecimalString(input.tetoMensalAlerta) }
        : {}),
      ...(input.diaFechamento !== undefined ? { diaFechamento: input.diaFechamento } : {}),
      ...(input.diaVencimento !== undefined ? { diaVencimento: input.diaVencimento } : {}),
    },
    include: {
      contaPagamento: { select: { id: true, nome: true } },
    },
  });

  const reference = parseReferenceDateStrict();
  return buildCardSummary(userId, updated, reference.referenceDate);
}

export async function deleteCreditCard(userId: string, cardId: string): Promise<void> {
  const existing = await prisma.cartaoCredito.findFirst({
    where: { id: cardId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  const [txCount, recCount] = await Promise.all([
    prisma.transacao.count({ where: { usuarioId: userId, cartaoId: existing.id } }),
    prisma.recorrencia.count({ where: { usuarioId: userId, cartaoId: existing.id } }),
  ]);

  if (txCount > 0 || recCount > 0) {
    throw new AppError(
      'Este cartão possui compras ou assinaturas vinculadas e não pode ser excluído.',
      409,
      'CARD_IN_USE',
    );
  }

  await prisma.cartaoCredito.delete({
    where: { id: existing.id },
  });
}

export async function getCreditCardInvoice(
  userId: string,
  cardId: string,
  monthInput?: string,
  dateInput?: string,
): Promise<CreditCardInvoiceDto> {
  const reference = parseReferenceDateStrict(dateInput);

  const card = await prisma.cartaoCredito.findFirst({
    where: { id: cardId, usuarioId: userId },
    include: {
      contaPagamento: { select: { id: true, nome: true } },
    },
  });

  if (!card) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  const effectiveMonth =
    monthInput ?? resolveOpenInvoiceMonth(reference.referenceDate, card.diaFechamento);
  const window = getInvoiceCycleWindow(effectiveMonth, card.diaFechamento, card.diaVencimento);

  await ensureRecurrencesForMonth(userId, effectiveMonth);

  const [rows, limiteUtilizado] = await Promise.all([
    prisma.transacao.findMany({
      where: {
        usuarioId: userId,
        cartaoId: card.id,
        tipo: 'DESP',
        dataCompetencia: {
          gte: window.periodStartGte,
          lt: window.periodEndLt,
        },
      },
      include: {
        categoria: { select: { id: true, nome: true } },
      },
      orderBy: [{ dataCompetencia: 'desc' }, { criadoEm: 'desc' }],
    }),
    getCardPendingUsedLimit(prisma, userId, card.id),
  ]);

  let totalPendente = 0;
  let totalPago = 0;

  const items = rows.map((row) => {
    const valor = decimalToNumber(row.valor);
    if (row.status === 'PENDENTE') {
      totalPendente += valor;
    } else {
      totalPago += valor;
    }

    return {
      id: row.id,
      descricao: row.descricao,
      valor,
      dataCompetencia: row.dataCompetencia.toISOString().slice(0, 10),
      status: row.status,
      categoriaId: row.categoriaId,
      categoriaNome: row.categoria?.nome ?? null,
      recorrenciaId: row.recorrenciaId,
    };
  });

  const roundedPendente = roundCurrency(totalPendente);
  const roundedPago = roundCurrency(totalPago);
  const totalFatura = roundCurrency(roundedPendente + roundedPago);

  const limiteTotal = decimalToNumber(card.limiteTotal);
  const tetoMensalAlerta = decimalToNumber(card.tetoMensalAlerta);
  const ceiling = evaluateCeilingAlert(totalFatura, tetoMensalAlerta);
  const statusFatura = evaluateInvoiceStatus({
    totalFatura,
    totalPendente: roundedPendente,
    closingDateIso: window.closingDateIso,
    dueDateIso: window.dueDateIso,
    referenceDateIso: reference.referenceDate,
  });

  return {
    cardId: card.id,
    cardNome: card.nome,
    contaPagamentoId: card.contaPagamentoId,
    contaPagamentoNome: card.contaPagamento.nome,
    month: effectiveMonth,
    periodStart: window.periodStartIso,
    closingDate: window.closingDateIso,
    dueDate: window.dueDateIso,
    statusFatura,
    limiteTotal,
    limiteUtilizado,
    limiteDisponivel: roundCurrency(limiteTotal - limiteUtilizado),
    tetoMensalAlerta,
    totalFatura,
    totalPendente: roundedPendente,
    totalPago: roundedPago,
    percentualTeto: ceiling.percentualTeto,
    alertaTetoAtivo: ceiling.alertaTetoAtivo,
    alertaTetoStatus: ceiling.alertaTetoStatus,
    items,
  };
}

export async function payCreditCardInvoice(
  userId: string,
  cardId: string,
  month: string,
  input: PayInvoiceInput,
): Promise<PayInvoiceResponseDto> {
  const paymentRef = parseReferenceDateStrict(input.dataPagamento);

  const cardPreview = await prisma.cartaoCredito.findFirst({
    where: { id: cardId, usuarioId: userId },
    select: { id: true, diaFechamento: true, diaVencimento: true },
  });

  if (!cardPreview) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  const window = getInvoiceCycleWindow(month, cardPreview.diaFechamento, cardPreview.diaVencimento);

  await ensureRecurrencesForMonth(userId, month);

  return prisma.$transaction(async (tx) => {
    const card = await tx.cartaoCredito.findFirst({
      where: { id: cardId, usuarioId: userId },
    });

    if (!card) {
      throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
    }

    const paymentAccountId = input.contaPagamentoId ?? card.contaPagamentoId;
    const paymentAccount = await validateOwnedPaymentAccount(tx, userId, paymentAccountId);

    const pendingRows = await tx.transacao.findMany({
      where: {
        usuarioId: userId,
        cartaoId: card.id,
        tipo: 'DESP',
        status: 'PENDENTE',
        dataCompetencia: {
          gte: window.periodStartGte,
          lt: window.periodEndLt,
        },
      },
      select: { id: true, valor: true },
    });

    if (pendingRows.length === 0) {
      throw new AppError(
        'Não há lançamentos pendentes para pagar nesta fatura.',
        400,
        'INVOICE_NOTHING_TO_PAY',
      );
    }

    const totalPagoNow = roundCurrency(
      pendingRows.reduce((sum, item) => sum + decimalToNumber(item.valor), 0),
    );
    const totalDecimal = toDecimalString(totalPagoNow);

    await tx.transacao.updateMany({
      where: {
        id: { in: pendingRows.map((item) => item.id) },
      },
      data: {
        status: 'PAGO',
      },
    });

    await tx.conta.update({
      where: { id: paymentAccount.id },
      data: {
        saldoAtual: { decrement: totalDecimal },
      },
    });

    const compactMonth = month.replace('-', '');
    const transfer = await tx.transacao.create({
      data: {
        usuarioId: userId,
        contaId: paymentAccount.id,
        contaDestinoId: null,
        cartaoId: null,
        categoriaId: null,
        recorrenciaId: null,
        tipo: 'TRANSF',
        valor: totalDecimal,
        descricao: `Pagamento fatura ${card.nome} (${month})`.slice(0, 200),
        dataCompetencia: new Date(`${paymentRef.referenceDate}T00:00:00.000Z`),
        status: 'PAGO',
        hashDedup: `fatura-pag:${compactMonth}:${randomUUID()}`,
      },
      select: { id: true },
    });

    return {
      month,
      cardId: card.id,
      contaPagamentoId: paymentAccount.id,
      valorPago: totalPagoNow,
      settledCount: pendingRows.length,
      transferTransactionId: transfer.id,
    };
  });
}

export async function computeCardAlertForTransaction(
  userId: string,
  cartaoId: string,
  referenceDateIso: string,
): Promise<CardCeilingAlertDto | null> {
  const card = await prisma.cartaoCredito.findFirst({
    where: { id: cartaoId, usuarioId: userId },
    select: {
      id: true,
      nome: true,
      diaFechamento: true,
      diaVencimento: true,
      tetoMensalAlerta: true,
    },
  });

  if (!card) {
    return null;
  }

  const tetoMensalAlerta = decimalToNumber(card.tetoMensalAlerta);
  if (tetoMensalAlerta <= 0) {
    return null;
  }

  const month = resolveOpenInvoiceMonth(referenceDateIso, card.diaFechamento);
  const window = getInvoiceCycleWindow(month, card.diaFechamento, card.diaVencimento);

  const agg = await prisma.transacao.aggregate({
    where: {
      usuarioId: userId,
      cartaoId: card.id,
      tipo: 'DESP',
      dataCompetencia: {
        gte: window.periodStartGte,
        lt: window.periodEndLt,
      },
    },
    _sum: { valor: true },
  });

  const totalFatura = agg._sum.valor ? decimalToNumber(agg._sum.valor) : 0;
  const ceiling = evaluateCeilingAlert(totalFatura, tetoMensalAlerta);

  if (ceiling.alertaTetoStatus !== 'PROXIMO' && ceiling.alertaTetoStatus !== 'ATINGIDO') {
    return null;
  }

  return {
    cardId: card.id,
    cardNome: card.nome,
    month,
    totalFatura,
    tetoMensalAlerta,
    percentualTeto: ceiling.percentualTeto,
    status: ceiling.alertaTetoStatus,
  };
}
