import type { AlertaNotificacao } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber } from '../../shared/utils/money.js';
import { getInvoiceCycleWindow } from '../credit-cards/credit-cards.engine.js';
import { generateMonthlyRecurrences } from '../recurrences/recurrences.service.js';
import { getMonthRange } from '../recurrences/recurrences.utils.js';
import { parseReferenceDateStrict, roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';
import { getSafeToSpend } from '../safe-to-spend/safe-to-spend.service.js';
import {
  buildWeeklyDigest,
  evaluateBudgetCandidates,
  evaluateDueSoonCandidates,
  type AlertChannel,
  type AlertType,
  type DueSoonBillInput,
  type GeneratedAlertCandidate,
  type WeeklyDigestResult,
} from './alerts.engine.js';
import type {
  AlertDto,
  AlertsListResponseDto,
  ListAlertsQuery,
  SyncAlertsResponseDto,
} from './alerts.schemas.js';

const DAY_MS = 86_400_000;

function shiftMonthIso(month: string, deltaMonths: number): string {
  const { year, monthNumber } = getMonthRange(month);
  return new Date(Date.UTC(year, monthNumber - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

function formatAlert(row: AlertaNotificacao): AlertDto {
  return {
    id: row.id,
    tipoAlerta: row.tipoAlerta,
    mensagem: row.mensagem,
    canal: row.canal,
    lido: row.lido,
    enviadoEm: row.enviadoEm.toISOString(),
  };
}

async function computeProactiveSnapshot(
  userId: string,
  dateInput?: string,
): Promise<{
  candidates: GeneratedAlertCandidate[];
  weeklyDigest: WeeklyDigestResult;
}> {
  const reference = parseReferenceDateStrict(dateInput);
  const refStart = new Date(`${reference.referenceDate}T00:00:00.000Z`);
  const windowEnd = new Date(refStart.getTime() + 2 * DAY_MS);
  const windowEndIso = windowEnd.toISOString().slice(0, 10);
  const windowEndMonth = windowEndIso.slice(0, 7);
  const weekStart = new Date(refStart.getTime() - 6 * DAY_MS);

  await generateMonthlyRecurrences(userId, reference.month);
  if (windowEndMonth !== reference.month) {
    await generateMonthlyRecurrences(userId, windowEndMonth);
  }

  const [pendingLiquidExpenses, cards, budgetedCategories, monthExpenses, tx7d, safeToSpend] =
    await Promise.all([
      prisma.transacao.findMany({
        where: {
          usuarioId: userId,
          contaId: { not: null },
          tipo: 'DESP',
          status: 'PENDENTE',
          dataCompetencia: {
            gte: refStart,
            lte: windowEnd,
          },
        },
        select: {
          id: true,
          descricao: true,
          valor: true,
          dataCompetencia: true,
        },
      }),
      prisma.cartaoCredito.findMany({
        where: { usuarioId: userId },
        select: {
          id: true,
          nome: true,
          diaFechamento: true,
          diaVencimento: true,
        },
      }),
      prisma.categoria.findMany({
        where: {
          usuarioId: userId,
          tipo: 'DESPESA',
          orcamentoMensal: { gt: 0 },
        },
        select: {
          id: true,
          nome: true,
          orcamentoMensal: true,
        },
      }),
      prisma.transacao.findMany({
        where: {
          usuarioId: userId,
          tipo: 'DESP',
          categoriaId: { not: null },
          dataCompetencia: {
            gte: reference.gte,
            lt: reference.lt,
          },
        },
        select: {
          categoriaId: true,
          valor: true,
        },
      }),
      prisma.transacao.findMany({
        where: {
          usuarioId: userId,
          tipo: { in: ['REC', 'DESP'] },
          dataCompetencia: {
            gte: weekStart,
            lte: refStart,
          },
        },
        select: {
          tipo: true,
          valor: true,
          categoria: { select: { nome: true } },
        },
      }),
      getSafeToSpend(userId, reference.referenceDate),
    ]);

  const dueSoonInputs: DueSoonBillInput[] = pendingLiquidExpenses.map((tx) => ({
    id: tx.id,
    kind: 'CONTA_FIXA_OU_DESP',
    descricao: tx.descricao,
    valor: decimalToNumber(tx.valor),
    dueDateIso: tx.dataCompetencia.toISOString().slice(0, 10),
  }));

  const candidateInvoiceMonths = Array.from(
    new Set([shiftMonthIso(reference.month, -1), reference.month, windowEndMonth]),
  );

  for (const card of cards) {
    for (const invMonth of candidateInvoiceMonths) {
      const cycle = getInvoiceCycleWindow(invMonth, card.diaFechamento, card.diaVencimento);
      if (cycle.dueDateIso >= reference.referenceDate && cycle.dueDateIso <= windowEndIso) {
        const agg = await prisma.transacao.aggregate({
          where: {
            usuarioId: userId,
            cartaoId: card.id,
            tipo: 'DESP',
            status: 'PENDENTE',
            dataCompetencia: {
              gte: cycle.periodStartGte,
              lt: cycle.periodEndLt,
            },
          },
          _sum: { valor: true },
        });
        const pendingTotal = agg._sum.valor ? decimalToNumber(agg._sum.valor) : 0;
        if (pendingTotal > 0) {
          dueSoonInputs.push({
            id: `${card.id}-${cycle.month}`,
            kind: 'FATURA_CARTAO',
            descricao: `${card.nome} (${cycle.month})`,
            valor: pendingTotal,
            dueDateIso: cycle.dueDateIso,
          });
        }
      }
    }
  }

  const dueSoonCandidates = evaluateDueSoonCandidates(reference.referenceDate, dueSoonInputs);

  const spentByCategoryId = new Map<string, number>();
  for (const tx of monthExpenses) {
    if (!tx.categoriaId) {
      continue;
    }
    spentByCategoryId.set(
      tx.categoriaId,
      roundCurrency((spentByCategoryId.get(tx.categoriaId) ?? 0) + decimalToNumber(tx.valor)),
    );
  }

  const budgetCandidates = evaluateBudgetCandidates(
    reference.month,
    budgetedCategories.map((cat) => ({
      categoriaId: cat.id,
      categoriaNome: cat.nome,
      orcamentoMensal: cat.orcamentoMensal ? decimalToNumber(cat.orcamentoMensal) : 0,
      gastoMes: spentByCategoryId.get(cat.id) ?? 0,
    })),
  );

  const { digest: weeklyDigest, candidate: weeklyCandidate } = buildWeeklyDigest({
    referenceDateIso: reference.referenceDate,
    transactions7d: tx7d
      .filter(
        (t): t is typeof t & { tipo: 'REC' | 'DESP' } => t.tipo === 'REC' || t.tipo === 'DESP',
      )
      .map((t) => ({
        tipo: t.tipo,
        valor: decimalToNumber(t.valor),
        categoriaNome: t.categoria?.nome ?? null,
      })),
    quantoPossoGastarHoje: safeToSpend.quantoPossoGastarHoje,
    contasVencendo48hCount: dueSoonCandidates.length,
  });

  return {
    candidates: [...dueSoonCandidates, ...budgetCandidates, weeklyCandidate],
    weeklyDigest,
  };
}

export async function syncProactiveAlerts(
  userId: string,
  options?: { date?: string; canal?: AlertChannel },
): Promise<SyncAlertsResponseDto> {
  const canal = options?.canal ?? 'PUSH';
  const { candidates, weeklyDigest } = await computeProactiveSnapshot(userId, options?.date);

  let createdCount = 0;
  if (candidates.length > 0) {
    const existingMessages = await prisma.alertaNotificacao.findMany({
      where: { usuarioId: userId },
      select: { mensagem: true },
    });

    const toCreate = candidates.filter(
      (candidate) =>
        !existingMessages.some((existing) => existing.mensagem.startsWith(candidate.dedupPrefix)),
    );

    if (toCreate.length > 0) {
      const inserted = await prisma.alertaNotificacao.createMany({
        data: toCreate.map((candidate) => ({
          usuarioId: userId,
          tipoAlerta: candidate.tipoAlerta,
          mensagem: candidate.mensagem,
          canal,
          lido: false,
        })),
      });
      createdCount = inserted.count;
    }
  }

  const unreadCount = await prisma.alertaNotificacao.count({
    where: { usuarioId: userId, lido: false },
  });

  return {
    createdCount,
    unreadCount,
    weeklyDigest,
  };
}

export async function listAlerts(
  userId: string,
  query: ListAlertsQuery,
): Promise<AlertsListResponseDto> {
  let createdCount = 0;
  let weeklyDigest: WeeklyDigestResult;

  if (query.autoSync === 'false') {
    const snapshot = await computeProactiveSnapshot(userId, query.date);
    weeklyDigest = snapshot.weeklyDigest;
  } else {
    const syncResult = await syncProactiveAlerts(userId, { date: query.date, canal: 'PUSH' });
    createdCount = syncResult.createdCount;
    weeklyDigest = syncResult.weeklyDigest;
  }

  const unreadOnly = query.unreadOnly === 'true';
  const [alerts, unreadCount] = await Promise.all([
    prisma.alertaNotificacao.findMany({
      where: {
        usuarioId: userId,
        ...(unreadOnly ? { lido: false } : {}),
        ...(query.tipo ? { tipoAlerta: query.tipo as AlertType } : {}),
      },
      orderBy: [{ lido: 'asc' }, { enviadoEm: 'desc' }],
      take: 100,
    }),
    prisma.alertaNotificacao.count({
      where: { usuarioId: userId, lido: false },
    }),
  ]);

  return {
    unreadCount,
    createdCount,
    weeklyDigest,
    alerts: alerts.map(formatAlert),
  };
}

export async function markAlertRead(
  userId: string,
  alertId: string,
  lido: boolean,
): Promise<AlertDto> {
  const existing = await prisma.alertaNotificacao.findFirst({
    where: { id: alertId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Alerta não encontrado.', 404, 'ALERT_NOT_FOUND');
  }

  const updated = await prisma.alertaNotificacao.update({
    where: { id: existing.id },
    data: { lido },
  });

  return formatAlert(updated);
}

export async function markAllAlertsRead(userId: string): Promise<{ updatedCount: number }> {
  const result = await prisma.alertaNotificacao.updateMany({
    where: { usuarioId: userId, lido: false },
    data: { lido: true },
  });

  return { updatedCount: result.count };
}

export async function deleteAlert(userId: string, alertId: string): Promise<void> {
  const existing = await prisma.alertaNotificacao.findFirst({
    where: { id: alertId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Alerta não encontrado.', 404, 'ALERT_NOT_FOUND');
  }

  await prisma.alertaNotificacao.delete({
    where: { id: existing.id },
  });
}
