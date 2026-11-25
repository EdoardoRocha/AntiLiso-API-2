import { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import type {
  ChecklistItemDto,
  CreateRecurrenceInput,
  GenerateRecurrencesResponseDto,
  MonthlyChecklistResponseDto,
  RecurrenceDto,
  UpdateRecurrenceInput,
} from './recurrences.schemas.js';
import {
  buildRecurrenceHashDedup,
  getCurrentMonthIso,
  getMonthRange,
  resolveCompetenceDateForMonth,
} from './recurrences.utils.js';

const RECURRENCE_INCLUDE = {
  categoria: { select: { id: true, nome: true, tipo: true, ehEssencial: true } },
  conta: { select: { id: true, nome: true, tipo: true } },
  cartao: { select: { id: true, nome: true } },
} satisfies Prisma.RecorrenciaInclude;

type RecurrenceWithRelations = Prisma.RecorrenciaGetPayload<{
  include: typeof RECURRENCE_INCLUDE;
}>;

function formatRecurrence(rec: RecurrenceWithRelations): RecurrenceDto {
  return {
    id: rec.id,
    descricao: rec.descricao,
    valorEstimado: decimalToNumber(rec.valorEstimado),
    diaVencimento: rec.diaVencimento,
    ativa: rec.ativa,
    categoriaId: rec.categoriaId,
    categoriaNome: rec.categoria.nome,
    categoriaTipo: rec.categoria.tipo,
    ehEssencial: rec.categoria.ehEssencial,
    contaId: rec.contaId,
    contaNome: rec.conta?.nome ?? null,
    cartaoId: rec.cartaoId,
    cartaoNome: rec.cartao?.nome ?? null,
  };
}

async function validateOwnedCategory(userId: string, categoriaId: string) {
  const category = await prisma.categoria.findFirst({
    where: { id: categoriaId, usuarioId: userId },
    select: { id: true, tipo: true },
  });

  if (!category) {
    throw new AppError('Categoria não encontrada.', 404, 'CATEGORY_NOT_FOUND');
  }

  return category;
}

async function resolveOwnedCard(userId: string, cartaoId: string) {
  const card = await prisma.cartaoCredito.findFirst({
    where: { id: cartaoId, usuarioId: userId },
    select: { id: true },
  });

  if (!card) {
    throw new AppError('Cartão de crédito não encontrado.', 404, 'CARD_NOT_FOUND');
  }

  return card;
}

async function resolveOwnedActiveAccount(userId: string, requestedContaId?: string | null) {
  if (requestedContaId) {
    const account = await prisma.conta.findFirst({
      where: { id: requestedContaId, usuarioId: userId },
      select: { id: true, ativa: true },
    });

    if (!account) {
      throw new AppError('Conta não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    }
    if (!account.ativa) {
      throw new AppError('A conta selecionada está inativa.', 400, 'INACTIVE_ACCOUNT');
    }

    return account;
  }

  const defaultAccount = await prisma.conta.findFirst({
    where: { usuarioId: userId, ehContaPadrao: true, ativa: true },
    select: { id: true },
  });

  if (!defaultAccount) {
    throw new AppError(
      'Nenhuma conta padrão ativa encontrada para vincular à recorrência.',
      400,
      'DEFAULT_ACCOUNT_NOT_FOUND',
    );
  }

  return defaultAccount;
}

export async function listRecurrences(
  userId: string,
  includeInactive: boolean,
): Promise<RecurrenceDto[]> {
  const rows = await prisma.recorrencia.findMany({
    where: {
      usuarioId: userId,
      ...(includeInactive ? {} : { ativa: true }),
    },
    include: RECURRENCE_INCLUDE,
    orderBy: [{ ativa: 'desc' }, { diaVencimento: 'asc' }, { descricao: 'asc' }],
  });

  return rows.map(formatRecurrence);
}

export async function createRecurrence(
  userId: string,
  input: CreateRecurrenceInput,
): Promise<RecurrenceDto> {
  const category = await validateOwnedCategory(userId, input.categoriaId);

  let contaId: string | null = null;
  let cartaoId: string | null = null;

  if (input.cartaoId) {
    if (category.tipo !== 'DESPESA') {
      throw new AppError(
        'Recorrências em cartão de crédito aceitam apenas categorias de despesa.',
        400,
        'CARD_ONLY_SUPPORTS_EXPENSE',
      );
    }
    const card = await resolveOwnedCard(userId, input.cartaoId);
    cartaoId = card.id;
  } else {
    const account = await resolveOwnedActiveAccount(userId, input.contaId);
    contaId = account.id;
  }

  const created = await prisma.recorrencia.create({
    data: {
      usuarioId: userId,
      categoriaId: input.categoriaId,
      contaId,
      cartaoId,
      descricao: input.descricao,
      valorEstimado: toDecimalString(input.valorEstimado),
      diaVencimento: input.diaVencimento,
      ativa: input.ativa,
    },
    include: RECURRENCE_INCLUDE,
  });

  return formatRecurrence(created);
}

export async function updateRecurrence(
  userId: string,
  recurrenceId: string,
  input: UpdateRecurrenceInput,
): Promise<RecurrenceDto> {
  const existing = await prisma.recorrencia.findFirst({
    where: { id: recurrenceId, usuarioId: userId },
    include: {
      categoria: { select: { tipo: true } },
    },
  });

  if (!existing) {
    throw new AppError('Recorrência não encontrada.', 404, 'RECURRENCE_NOT_FOUND');
  }

  let nextCategoryTipo = existing.categoria.tipo;
  if (input.categoriaId !== undefined) {
    const cat = await validateOwnedCategory(userId, input.categoriaId);
    nextCategoryTipo = cat.tipo;
  }

  let nextContaId = existing.contaId;
  let nextCartaoId = existing.cartaoId;

  if (input.cartaoId !== undefined) {
    await resolveOwnedCard(userId, input.cartaoId);
    nextCartaoId = input.cartaoId;
    nextContaId = null;
  } else if (input.contaId !== undefined) {
    await resolveOwnedActiveAccount(userId, input.contaId);
    nextContaId = input.contaId;
    nextCartaoId = null;
  }

  if (nextCartaoId && nextCategoryTipo !== 'DESPESA') {
    throw new AppError(
      'Recorrências em cartão de crédito aceitam apenas categorias de despesa.',
      400,
      'CARD_ONLY_SUPPORTS_EXPENSE',
    );
  }

  const updated = await prisma.recorrencia.update({
    where: { id: existing.id },
    data: {
      ...(input.descricao !== undefined ? { descricao: input.descricao } : {}),
      ...(input.valorEstimado !== undefined
        ? { valorEstimado: toDecimalString(input.valorEstimado) }
        : {}),
      ...(input.diaVencimento !== undefined ? { diaVencimento: input.diaVencimento } : {}),
      ...(input.categoriaId !== undefined ? { categoriaId: input.categoriaId } : {}),
      ...(input.contaId !== undefined || input.cartaoId !== undefined
        ? { contaId: nextContaId, cartaoId: nextCartaoId }
        : {}),
      ...(input.ativa !== undefined ? { ativa: input.ativa } : {}),
    },
    include: RECURRENCE_INCLUDE,
  });

  return formatRecurrence(updated);
}

export async function deleteRecurrence(userId: string, recurrenceId: string): Promise<void> {
  const existing = await prisma.recorrencia.findFirst({
    where: { id: recurrenceId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Recorrência não encontrada.', 404, 'RECURRENCE_NOT_FOUND');
  }

  await prisma.recorrencia.delete({
    where: { id: existing.id },
  });
}

export async function generateMonthlyRecurrences(
  userId: string,
  monthInput?: string,
): Promise<GenerateRecurrencesResponseDto> {
  const month = monthInput ?? getCurrentMonthIso();
  const range = getMonthRange(month);

  const activeRecurrences = await prisma.recorrencia.findMany({
    where: {
      usuarioId: userId,
      ativa: true,
      OR: [{ contaId: { not: null } }, { cartaoId: { not: null } }],
    },
    include: {
      categoria: { select: { tipo: true } },
    },
  });

  if (activeRecurrences.length === 0) {
    return { month, generatedCount: 0, existingCount: 0 };
  }

  const recurrenceIds = activeRecurrences.map((r) => r.id);
  const hashes = activeRecurrences.map((r) => buildRecurrenceHashDedup(r.id, month));

  const existingTransactions = await prisma.transacao.findMany({
    where: {
      usuarioId: userId,
      OR: [
        {
          recorrenciaId: { in: recurrenceIds },
          dataCompetencia: { gte: range.gte, lt: range.lt },
        },
        {
          hashDedup: { in: hashes },
        },
      ],
    },
    select: {
      recorrenciaId: true,
      hashDedup: true,
    },
  });

  const existingRecIds = new Set(
    existingTransactions.map((t) => t.recorrenciaId).filter((id): id is string => Boolean(id)),
  );
  const existingHashes = new Set(
    existingTransactions.map((t) => t.hashDedup).filter((h): h is string => Boolean(h)),
  );

  const toCreate = activeRecurrences
    .filter((rec) => {
      const hash = buildRecurrenceHashDedup(rec.id, month);
      return !existingRecIds.has(rec.id) && !existingHashes.has(hash);
    })
    .map((rec) => ({
      usuarioId: userId,
      contaId: rec.contaId,
      contaDestinoId: null,
      cartaoId: rec.cartaoId,
      categoriaId: rec.categoriaId,
      recorrenciaId: rec.id,
      tipo: (rec.categoria.tipo === 'RECEITA' ? 'REC' : 'DESP') as 'REC' | 'DESP',
      valor: rec.valorEstimado,
      descricao: rec.descricao,
      dataCompetencia: resolveCompetenceDateForMonth(month, rec.diaVencimento),
      status: 'PENDENTE' as const,
      hashDedup: buildRecurrenceHashDedup(rec.id, month),
    }));

  if (toCreate.length === 0) {
    return {
      month,
      generatedCount: 0,
      existingCount: activeRecurrences.length,
    };
  }

  const created = await prisma.transacao.createMany({
    data: toCreate,
    skipDuplicates: true,
  });

  return {
    month,
    generatedCount: created.count,
    existingCount: activeRecurrences.length - created.count,
  };
}

export async function getMonthlyChecklist(
  userId: string,
  monthInput?: string,
): Promise<MonthlyChecklistResponseDto> {
  const month = monthInput ?? getCurrentMonthIso();
  const range = getMonthRange(month);

  await generateMonthlyRecurrences(userId, month);

  const rows = await prisma.transacao.findMany({
    where: {
      usuarioId: userId,
      recorrenciaId: { not: null },
      dataCompetencia: { gte: range.gte, lt: range.lt },
      tipo: { in: ['REC', 'DESP'] },
    },
    include: {
      categoria: { select: { id: true, nome: true, ehEssencial: true } },
      conta: { select: { id: true, nome: true } },
      cartao: { select: { id: true, nome: true } },
      recorrencia: { select: { id: true, diaVencimento: true, valorEstimado: true } },
    },
    orderBy: [{ dataCompetencia: 'asc' }, { descricao: 'asc' }],
  });

  const items: ChecklistItemDto[] = rows.map((row) => ({
    id: row.id,
    recorrenciaId: row.recorrenciaId!,
    descricao: row.descricao,
    tipo: row.tipo === 'REC' ? 'REC' : 'DESP',
    valor: decimalToNumber(row.valor),
    valorEstimado: row.recorrencia
      ? decimalToNumber(row.recorrencia.valorEstimado)
      : decimalToNumber(row.valor),
    dataCompetencia: row.dataCompetencia.toISOString().slice(0, 10),
    diaVencimento:
      row.recorrencia?.diaVencimento ?? Number(row.dataCompetencia.toISOString().slice(8, 10)),
    status: row.status,
    contaId: row.contaId,
    contaNome: row.conta?.nome ?? null,
    cartaoId: row.cartaoId,
    cartaoNome: row.cartao?.nome ?? null,
    categoriaId: row.categoriaId,
    categoriaNome: row.categoria?.nome ?? null,
    ehEssencial: row.categoria?.ehEssencial ?? false,
  }));

  let totalFixasDespesas = 0;
  let totalPagoDespesas = 0;
  let totalPendenteDespesas = 0;
  let totalFixasReceitas = 0;
  let countPagas = 0;
  let countPendentes = 0;

  for (const item of items) {
    if (item.tipo === 'DESP') {
      totalFixasDespesas += item.valor;
      if (item.status === 'PAGO') {
        totalPagoDespesas += item.valor;
      } else {
        totalPendenteDespesas += item.valor;
      }
    } else {
      totalFixasReceitas += item.valor;
    }

    if (item.status === 'PAGO') {
      countPagas += 1;
    } else {
      countPendentes += 1;
    }
  }

  return {
    month,
    items,
    summary: {
      totalFixasDespesas: Number(totalFixasDespesas.toFixed(2)),
      totalPagoDespesas: Number(totalPagoDespesas.toFixed(2)),
      totalPendenteDespesas: Number(totalPendenteDespesas.toFixed(2)),
      totalFixasReceitas: Number(totalFixasReceitas.toFixed(2)),
      countTotal: items.length,
      countPagas,
      countPendentes,
    },
  };
}
