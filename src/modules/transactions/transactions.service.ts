import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import type { CategorySuggestionDto } from '../categories/learning-rules.schemas.js';
import {
  recordCategoryLearning,
  suggestCategoryForDescription,
} from '../categories/learning-rules.service.js';
import type { CardCeilingAlertDto } from '../credit-cards/credit-cards.schemas.js';
import { computeCardAlertForTransaction } from '../credit-cards/credit-cards.service.js';
import type { ReserveSplitSuggestionDto } from '../reserve/reserve.schemas.js';
import { buildReserveSplitSuggestionForIncome } from '../reserve/reserve.service.js';
import { parseQuickAddText, type ParsedQuickAdd } from './quick-add-parser.js';
import type {
  CreateTransactionInput,
  ListTransactionsFilters,
  QuickAddInput,
  TransactionDto,
  TransactionsSummaryDto,
  UpdateTransactionInput,
} from './transactions.schemas.js';

const TRANSACTION_INCLUDE = {
  conta: { select: { id: true, nome: true } },
  contaDestino: { select: { id: true, nome: true } },
  cartao: { select: { id: true, nome: true } },
  categoria: { select: { id: true, nome: true } },
} satisfies Prisma.TransacaoInclude;

type TransactionWithRelations = Prisma.TransacaoGetPayload<{
  include: typeof TRANSACTION_INCLUDE;
}>;

function formatTransaction(tx: TransactionWithRelations): TransactionDto {
  return {
    id: tx.id,
    tipo: tx.tipo,
    valor: decimalToNumber(tx.valor),
    descricao: tx.descricao,
    dataCompetencia: tx.dataCompetencia.toISOString().slice(0, 10),
    status: tx.status,
    contaId: tx.contaId,
    contaNome: tx.conta?.nome ?? null,
    contaDestinoId: tx.contaDestinoId,
    contaDestinoNome: tx.contaDestino?.nome ?? null,
    cartaoId: tx.cartaoId,
    cartaoNome: tx.cartao?.nome ?? null,
    categoriaId: tx.categoriaId,
    categoriaNome: tx.categoria?.nome ?? null,
    criadoEm: tx.criadoEm.toISOString(),
  };
}

function parseDateStrict(isoDate?: string): Date {
  const dateString = isoDate ?? new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${dateString}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateString) {
    throw new AppError('Data de competência inválida.', 400, 'INVALID_DATE');
  }

  return parsed;
}

function getMonthDateRange(month: string): { gte: Date; lt: Date } {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNumber = Number(monthStr);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(monthNumber) ||
    monthNumber < 1 ||
    monthNumber > 12
  ) {
    throw new AppError('Mês de filtro inválido.', 400, 'INVALID_MONTH');
  }

  const gte = new Date(Date.UTC(year, monthNumber - 1, 1));
  const lt = new Date(Date.UTC(year, monthNumber, 1));
  return { gte, lt };
}

function isCategoryCompatible(
  transactionType: 'REC' | 'DESP',
  categoryType: 'RECEITA' | 'DESPESA',
): boolean {
  return (
    (transactionType === 'REC' && categoryType === 'RECEITA') ||
    (transactionType === 'DESP' && categoryType === 'DESPESA')
  );
}

async function resolveAccountForTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  requestedAccountId?: string | null,
) {
  if (requestedAccountId) {
    const account = await tx.conta.findFirst({
      where: { id: requestedAccountId, usuarioId: userId },
    });
    if (!account) {
      throw new AppError('Conta não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (!account.ativa) {
      throw new AppError('A conta selecionada está inativa.', 400, 'INACTIVE_ACCOUNT');
    }
    if (account.tipo === 'COFRE') {
      throw new AppError(
        'Contas do tipo Cofre só podem ser movimentadas via aportes ou resgates da Reserva.',
        400,
        'VAULT_DIRECT_TRANSACTION_BLOCKED',
      );
    }
    return account;
  }

  const defaultAccount = await tx.conta.findFirst({
    where: { usuarioId: userId, ehContaPadrao: true, ativa: true, tipo: { not: 'COFRE' } },
  });

  if (!defaultAccount) {
    throw new AppError(
      'Nenhuma conta padrão ativa encontrada para o usuário.',
      400,
      'DEFAULT_ACCOUNT_NOT_FOUND',
    );
  }

  return defaultAccount;
}

async function resolveAndValidateCategory(
  tx: Prisma.TransactionClient,
  userId: string,
  categoryId: string,
  transactionType: 'REC' | 'DESP',
) {
  const category = await tx.categoria.findFirst({
    where: { id: categoryId, usuarioId: userId },
  });

  if (!category) {
    throw new AppError('Categoria não encontrada.', 404, 'CATEGORY_NOT_FOUND');
  }

  if (!isCategoryCompatible(transactionType, category.tipo)) {
    throw new AppError(
      'Categoria incompatível com o tipo de lançamento (Entrou/Saiu).',
      400,
      'CATEGORY_TYPE_MISMATCH',
    );
  }

  return category;
}

async function resolveCardForTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  cartaoId: string,
) {
  const card = await tx.cartaoCredito.findFirst({
    where: { id: cartaoId, usuarioId: userId },
    select: { id: true },
  });

  if (!card) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  return card;
}

export async function createTransaction(
  userId: string,
  input: CreateTransactionInput,
): Promise<{
  transaction: TransactionDto;
  idempotent: boolean;
  cardAlert: CardCeilingAlertDto | null;
  reserveSplitSuggestion: ReserveSplitSuggestionDto | null;
}> {
  if (input.contaId && input.cartaoId) {
    throw new AppError('Informe conta ou cartão, nunca ambos.', 400, 'INVALID_TARGET');
  }

  const hashDedup = input.clientRequestId ? `client:${input.clientRequestId}` : null;
  const dataCompetencia = parseDateStrict(input.dataCompetencia);
  const valorDecimal = toDecimalString(input.valor);
  const isCardPurchase = Boolean(input.cartaoId);

  if (isCardPurchase && input.tipo !== 'DESP') {
    throw new AppError(
      'Cartão de crédito aceita apenas lançamentos de saída.',
      400,
      'CARD_ONLY_SUPPORTS_EXPENSE',
    );
  }

  const effectiveStatus: 'PAGO' | 'PENDENTE' = isCardPurchase
    ? 'PENDENTE'
    : (input.status ?? 'PAGO');

  let txResult: { transaction: TransactionDto; idempotent: boolean };

  try {
    txResult = await prisma.$transaction(async (tx) => {
      if (hashDedup) {
        const existing = await tx.transacao.findFirst({
          where: { usuarioId: userId, hashDedup },
          include: TRANSACTION_INCLUDE,
        });
        if (existing) {
          return {
            transaction: formatTransaction(existing),
            idempotent: true,
          };
        }
      }

      if (input.categoriaId) {
        await resolveAndValidateCategory(tx, userId, input.categoriaId, input.tipo);
      }

      if (input.cartaoId) {
        const card = await resolveCardForTransaction(tx, userId, input.cartaoId);

        const created = await tx.transacao.create({
          data: {
            usuarioId: userId,
            contaId: null,
            contaDestinoId: null,
            cartaoId: card.id,
            categoriaId: input.categoriaId ?? null,
            tipo: input.tipo,
            valor: valorDecimal,
            descricao: input.descricao,
            dataCompetencia,
            status: 'PENDENTE',
            hashDedup,
          },
          include: TRANSACTION_INCLUDE,
        });

        if (input.categoriaId) {
          await recordCategoryLearning(tx, userId, input.descricao, input.categoriaId);
        }

        return {
          transaction: formatTransaction(created),
          idempotent: false,
        };
      }

      const account = await resolveAccountForTransaction(tx, userId, input.contaId);

      const created = await tx.transacao.create({
        data: {
          usuarioId: userId,
          contaId: account.id,
          contaDestinoId: null,
          cartaoId: null,
          categoriaId: input.categoriaId ?? null,
          tipo: input.tipo,
          valor: valorDecimal,
          descricao: input.descricao,
          dataCompetencia,
          status: effectiveStatus,
          hashDedup,
        },
        include: TRANSACTION_INCLUDE,
      });

      if (effectiveStatus === 'PAGO') {
        await tx.conta.update({
          where: { id: account.id },
          data: {
            saldoAtual:
              input.tipo === 'REC' ? { increment: valorDecimal } : { decrement: valorDecimal },
          },
        });
      }

      if (input.categoriaId) {
        await recordCategoryLearning(tx, userId, input.descricao, input.categoriaId);
      }

      return {
        transaction: formatTransaction(created),
        idempotent: false,
      };
    });
  } catch (error) {
    if (
      hashDedup &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.transacao.findFirst({
        where: { usuarioId: userId, hashDedup },
        include: TRANSACTION_INCLUDE,
      });

      if (existing) {
        return {
          transaction: formatTransaction(existing),
          idempotent: true,
          cardAlert: null,
          reserveSplitSuggestion: null,
        };
      }
    }

    throw error;
  }

  if (!txResult.idempotent && txResult.transaction.cartaoId) {
    const cardAlert = await computeCardAlertForTransaction(
      userId,
      txResult.transaction.cartaoId,
      txResult.transaction.dataCompetencia,
    );
    return {
      ...txResult,
      cardAlert,
      reserveSplitSuggestion: null,
    };
  }

  if (!txResult.idempotent && txResult.transaction.tipo === 'REC' && txResult.transaction.contaId) {
    const reserveSplitSuggestion = await buildReserveSplitSuggestionForIncome(
      userId,
      txResult.transaction.valor,
      txResult.transaction.contaId,
    );
    return {
      ...txResult,
      cardAlert: null,
      reserveSplitSuggestion,
    };
  }

  return {
    ...txResult,
    cardAlert: null,
    reserveSplitSuggestion: null,
  };
}

export async function quickAddTransaction(
  userId: string,
  input: QuickAddInput,
): Promise<{
  transaction: TransactionDto;
  idempotent: boolean;
  cardAlert: CardCeilingAlertDto | null;
  reserveSplitSuggestion: ReserveSplitSuggestionDto | null;
  parsed: ParsedQuickAdd;
  suggestedCategory: CategorySuggestionDto | null;
}> {
  const parsed = parseQuickAddText(input.texto);
  const finalTipo = input.tipo ?? parsed.tipo;

  let targetCartaoId = input.cartaoId ?? null;
  if (
    !input.contaId &&
    !targetCartaoId &&
    finalTipo === 'DESP' &&
    (parsed.metodoDetectado === 'credito' || parsed.metodoDetectado === 'cartao')
  ) {
    const firstCard = await prisma.cartaoCredito.findFirst({
      where: { usuarioId: userId },
      orderBy: [{ nome: 'asc' }],
      select: { id: true },
    });
    if (firstCard) {
      targetCartaoId = firstCard.id;
    }
  }

  let matchedCategoryId = input.categoriaId ?? null;
  let suggestedCategory: CategorySuggestionDto | null = null;

  if (!matchedCategoryId) {
    suggestedCategory = await suggestCategoryForDescription(userId, input.texto, finalTipo);
    matchedCategoryId = suggestedCategory?.categoriaId ?? null;
  }

  const created = await createTransaction(userId, {
    tipo: finalTipo,
    valor: parsed.valor,
    descricao: parsed.descricao,
    contaId: targetCartaoId ? null : (input.contaId ?? null),
    cartaoId: targetCartaoId,
    categoriaId: matchedCategoryId,
    dataCompetencia: input.dataCompetencia,
    status: input.status,
    clientRequestId: input.clientRequestId,
  });

  return {
    ...created,
    parsed: {
      ...parsed,
      tipo: finalTipo,
    },
    suggestedCategory,
  };
}

export async function listTransactions(
  userId: string,
  filters: ListTransactionsFilters,
): Promise<{ transactions: TransactionDto[]; summary: TransactionsSummaryDto }> {
  const where: Prisma.TransacaoWhereInput = {
    usuarioId: userId,
    ...(filters.month ? { dataCompetencia: getMonthDateRange(filters.month) } : {}),
    ...(filters.tipo ? { tipo: filters.tipo } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.contaId
      ? { OR: [{ contaId: filters.contaId }, { contaDestinoId: filters.contaId }] }
      : {}),
    ...(filters.cartaoId ? { cartaoId: filters.cartaoId } : {}),
    ...(filters.categoriaId ? { categoriaId: filters.categoriaId } : {}),
    ...(filters.search
      ? { descricao: { contains: filters.search, mode: 'insensitive' as const } }
      : {}),
  };

  const [rows, groupedTotals, totalCount] = await Promise.all([
    prisma.transacao.findMany({
      where,
      include: TRANSACTION_INCLUDE,
      orderBy: [{ dataCompetencia: 'desc' }, { criadoEm: 'desc' }],
      take: filters.limit,
    }),
    prisma.transacao.groupBy({
      by: ['tipo'],
      where,
      _sum: { valor: true },
    }),
    prisma.transacao.count({ where }),
  ]);

  let totalReceitas = 0;
  let totalDespesas = 0;

  for (const group of groupedTotals) {
    if (group.tipo === 'REC' && group._sum.valor) {
      totalReceitas = decimalToNumber(group._sum.valor);
    } else if (group.tipo === 'DESP' && group._sum.valor) {
      totalDespesas = decimalToNumber(group._sum.valor);
    }
  }

  return {
    transactions: rows.map(formatTransaction),
    summary: {
      totalReceitas,
      totalDespesas,
      saldoPeriodo: Number((totalReceitas - totalDespesas).toFixed(2)),
      totalCount,
    },
  };
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: UpdateTransactionInput,
): Promise<TransactionDto> {
  const parsedDate =
    input.dataCompetencia !== undefined ? parseDateStrict(input.dataCompetencia) : undefined;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.transacao.findFirst({
      where: { id: transactionId, usuarioId: userId },
    });

    if (!existing) {
      throw new AppError('Transação não encontrada.', 404, 'TRANSACTION_NOT_FOUND');
    }

    if (existing.tipo === 'TRANSF') {
      throw new AppError(
        'Transferências internas não podem ser editadas por esta rota.',
        400,
        'TRANSFER_EDIT_NOT_ALLOWED',
      );
    }

    if (existing.cartaoId !== null && existing.status === 'PAGO') {
      throw new AppError(
        'Lançamento de cartão já quitado na fatura não pode ser alterado.',
        400,
        'CARD_TRANSACTION_ALREADY_SETTLED',
      );
    }

    const nextTipo: 'REC' | 'DESP' = input.tipo ?? existing.tipo;
    const isCardTx = existing.cartaoId !== null;
    const nextCategoriaId =
      input.categoriaId !== undefined ? input.categoriaId : existing.categoriaId;

    if (isCardTx) {
      if (nextTipo !== 'DESP') {
        throw new AppError(
          'Cartão de crédito aceita apenas lançamentos de saída.',
          400,
          'CARD_ONLY_SUPPORTS_EXPENSE',
        );
      }

      if (input.contaId !== undefined) {
        throw new AppError(
          'Não é possível mover lançamento de cartão diretamente para uma conta líquida.',
          400,
          'CARD_TO_ACCOUNT_CHANGE_NOT_ALLOWED',
        );
      }

      if (input.status === 'PAGO') {
        throw new AppError(
          'Lançamentos no cartão são quitados apenas pelo pagamento da fatura.',
          400,
          'CARD_MANUAL_SETTLE_NOT_ALLOWED',
        );
      }

      if (input.cartaoId !== undefined && input.cartaoId !== existing.cartaoId) {
        await resolveCardForTransaction(tx, userId, input.cartaoId);
      }

      if (nextCategoriaId) {
        await resolveAndValidateCategory(tx, userId, nextCategoriaId, nextTipo);
      }

      const updated = await tx.transacao.update({
        where: { id: existing.id },
        data: {
          ...(input.valor !== undefined ? { valor: toDecimalString(input.valor) } : {}),
          ...(input.descricao !== undefined ? { descricao: input.descricao } : {}),
          ...(input.cartaoId !== undefined ? { cartaoId: input.cartaoId } : {}),
          ...(input.categoriaId !== undefined ? { categoriaId: input.categoriaId } : {}),
          ...(parsedDate !== undefined ? { dataCompetencia: parsedDate } : {}),
        },
        include: TRANSACTION_INCLUDE,
      });

      if (
        (input.categoriaId !== undefined || input.descricao !== undefined) &&
        updated.categoriaId
      ) {
        await recordCategoryLearning(tx, userId, updated.descricao, updated.categoriaId);
      }

      return formatTransaction(updated);
    }

    if (input.cartaoId !== undefined) {
      throw new AppError(
        'Não é possível mover lançamento de conta diretamente para um cartão de crédito.',
        400,
        'ACCOUNT_TO_CARD_CHANGE_NOT_ALLOWED',
      );
    }

    const nextContaId = input.contaId ?? existing.contaId;

    if (!nextContaId) {
      throw new AppError(
        'Transação sem conta líquida associada não pode ser alterada nesta etapa.',
        400,
        'MISSING_ACCOUNT_ON_TRANSACTION',
      );
    }

    if (input.contaId !== undefined && input.contaId !== existing.contaId) {
      await resolveAccountForTransaction(tx, userId, input.contaId);
    }

    if (nextCategoriaId) {
      await resolveAndValidateCategory(tx, userId, nextCategoriaId, nextTipo);
    }

    if (existing.status === 'PAGO' && existing.contaId) {
      await tx.conta.update({
        where: { id: existing.contaId },
        data: {
          saldoAtual:
            existing.tipo === 'REC' ? { decrement: existing.valor } : { increment: existing.valor },
        },
      });
    }

    const updated = await tx.transacao.update({
      where: { id: existing.id },
      data: {
        ...(input.tipo !== undefined ? { tipo: input.tipo } : {}),
        ...(input.valor !== undefined ? { valor: toDecimalString(input.valor) } : {}),
        ...(input.descricao !== undefined ? { descricao: input.descricao } : {}),
        ...(input.contaId !== undefined ? { contaId: input.contaId } : {}),
        ...(input.categoriaId !== undefined ? { categoriaId: input.categoriaId } : {}),
        ...(parsedDate !== undefined ? { dataCompetencia: parsedDate } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      include: TRANSACTION_INCLUDE,
    });

    if (updated.status === 'PAGO' && updated.contaId) {
      await tx.conta.update({
        where: { id: updated.contaId },
        data: {
          saldoAtual:
            updated.tipo === 'REC' ? { increment: updated.valor } : { decrement: updated.valor },
        },
      });
    }

    if ((input.categoriaId !== undefined || input.descricao !== undefined) && updated.categoriaId) {
      await recordCategoryLearning(tx, userId, updated.descricao, updated.categoriaId);
    }

    return formatTransaction(updated);
  });
}

export async function deleteTransaction(userId: string, transactionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.transacao.findFirst({
      where: { id: transactionId, usuarioId: userId },
    });

    if (!existing) {
      throw new AppError('Transação não encontrada.', 404, 'TRANSACTION_NOT_FOUND');
    }

    if (existing.cartaoId !== null && existing.status === 'PAGO') {
      throw new AppError(
        'Lançamento de cartão já quitado na fatura não pode ser excluído.',
        400,
        'CARD_TRANSACTION_ALREADY_SETTLED',
      );
    }

    if (existing.hashDedup?.startsWith('fatura-pag:')) {
      throw new AppError(
        'O registro de pagamento de fatura não pode ser excluído diretamente.',
        400,
        'INVOICE_PAYMENT_DELETE_BLOCKED',
      );
    }

    const linkedReserveCount = existing.hashDedup?.startsWith('reserva-')
      ? 1
      : await tx.movimentoReserva.count({ where: { transacaoOrigemId: existing.id } });

    if (linkedReserveCount > 0) {
      throw new AppError(
        'Movimentações da Reserva de Emergência são auditáveis e não podem ser excluídas diretamente.',
        400,
        'RESERVE_MOVEMENT_DELETE_BLOCKED',
      );
    }

    if (existing.status === 'PAGO') {
      if (existing.tipo === 'REC' && existing.contaId) {
        await tx.conta.update({
          where: { id: existing.contaId },
          data: { saldoAtual: { decrement: existing.valor } },
        });
      } else if (existing.tipo === 'DESP' && existing.contaId) {
        await tx.conta.update({
          where: { id: existing.contaId },
          data: { saldoAtual: { increment: existing.valor } },
        });
      } else if (existing.tipo === 'TRANSF' && existing.contaId) {
        await tx.conta.update({
          where: { id: existing.contaId },
          data: { saldoAtual: { increment: existing.valor } },
        });
        if (existing.contaDestinoId) {
          await tx.conta.update({
            where: { id: existing.contaDestinoId },
            data: { saldoAtual: { decrement: existing.valor } },
          });
        }
      }
    }

    await tx.transacao.delete({
      where: { id: existing.id },
    });
  });
}
