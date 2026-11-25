import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { generateMonthlyRecurrences } from '../recurrences/recurrences.service.js';
import { getMonthRange } from '../recurrences/recurrences.utils.js';
import { parseReferenceDateStrict, roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';
import {
  calculateIdealReserveTarget,
  calculateReserveThermometer,
  calculateSplitAmount,
  evaluateInvestmentTriggerStatus,
  evaluateMonthlyReservePriority,
  simulateWithdrawalImpact,
} from './reserve.engine.js';
import type {
  CreateReserveDepositInput,
  CreateReserveWithdrawalInput,
  ReserveMovementDto,
  ReserveMutationResponseDto,
  ReserveOverviewDto,
  ReserveSplitSuggestionDto,
  ReserveWithdrawalResponseDto,
  UpdateReserveConfigInput,
} from './reserve.schemas.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

function shiftMonthIso(month: string, deltaMonths: number): string {
  const { year, monthNumber } = getMonthRange(month);
  return new Date(Date.UTC(year, monthNumber - 1 + deltaMonths, 1)).toISOString().slice(0, 7);
}

function formatReserveMovement(row: {
  id: string;
  tipo: 'APORTE' | 'RESGATE';
  valor: Prisma.Decimal;
  justificativaResgate: string | null;
  dataMovimento: Date;
  transacaoOrigemId: string | null;
}): ReserveMovementDto {
  return {
    id: row.id,
    tipo: row.tipo,
    valor: decimalToNumber(row.valor),
    justificativaResgate: row.justificativaResgate,
    dataMovimento: row.dataMovimento.toISOString(),
    transacaoOrigemId: row.transacaoOrigemId,
  };
}

async function resolveLiquidAccountForReserve(
  tx: DbClient,
  userId: string,
  contaCofreId: string,
  requestedAccountId: string | undefined,
  direction: 'origem' | 'destino',
) {
  const account = requestedAccountId
    ? await tx.conta.findFirst({
        where: { id: requestedAccountId, usuarioId: userId },
      })
    : await tx.conta.findFirst({
        where: { usuarioId: userId, ehContaPadrao: true, ativa: true },
      });

  if (!account) {
    throw new AppError(
      `Conta de ${direction} não encontrada.`,
      404,
      requestedAccountId ? 'ACCOUNT_NOT_FOUND' : 'DEFAULT_ACCOUNT_NOT_FOUND',
    );
  }

  if (!account.ativa) {
    throw new AppError(
      `A conta de ${direction} selecionada está inativa.`,
      400,
      'INACTIVE_ACCOUNT',
    );
  }

  if (account.tipo === 'COFRE' || account.id === contaCofreId) {
    throw new AppError(
      `Selecione uma conta líquida (Corrente ou Carteira) como ${direction}, não o Cofre.`,
      400,
      direction === 'origem' ? 'INVALID_SOURCE_ACCOUNT' : 'INVALID_DESTINATION_ACCOUNT',
    );
  }

  return account;
}

export async function getReserveOverview(
  userId: string,
  dateInput?: string,
): Promise<ReserveOverviewDto> {
  const reference = parseReferenceDateStrict(dateInput);

  await generateMonthlyRecurrences(userId, reference.month);

  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    include: {
      reservaEmergencia: {
        include: {
          contaCofre: { select: { id: true, nome: true } },
        },
      },
    },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    throw new AppError('Reserva de emergência não encontrada.', 404, 'RESERVE_NOT_FOUND');
  }

  const reserva = usuario.reservaEmergencia;
  const sixMonthsAgoMonth = shiftMonthIso(reference.month, -5);
  const sixMonthsAgoRange = getMonthRange(sixMonthsAgoMonth);

  const [
    essentialRecurrences,
    essentialCategories,
    monthTransactions,
    windowMovementsRaw,
    recentMovementsRaw,
  ] = await Promise.all([
    prisma.recorrencia.findMany({
      where: {
        usuarioId: userId,
        ativa: true,
        categoria: { tipo: 'DESPESA', ehEssencial: true },
      },
      select: { valorEstimado: true },
    }),
    prisma.categoria.findMany({
      where: {
        usuarioId: userId,
        tipo: 'DESPESA',
        ehEssencial: true,
        orcamentoMensal: { not: null },
      },
      select: { orcamentoMensal: true },
    }),
    prisma.transacao.findMany({
      where: {
        usuarioId: userId,
        dataCompetencia: { gte: reference.gte, lt: reference.lt },
        tipo: { in: ['REC', 'DESP'] },
      },
      select: {
        tipo: true,
        valor: true,
        status: true,
        cartaoId: true,
        recorrenciaId: true,
        categoria: { select: { ehEssencial: true } },
      },
    }),
    prisma.movimentoReserva.findMany({
      where: {
        reservaId: reserva.id,
        dataMovimento: { gte: sixMonthsAgoRange.gte, lt: reference.lt },
      },
      select: {
        tipo: true,
        valor: true,
        dataMovimento: true,
      },
    }),
    prisma.movimentoReserva.findMany({
      where: { reservaId: reserva.id },
      orderBy: [{ dataMovimento: 'desc' }],
      take: 30,
    }),
  ]);

  const fixasEssenciaisAtivas = roundCurrency(
    essentialRecurrences.reduce((sum, rec) => sum + decimalToNumber(rec.valorEstimado), 0),
  );

  const orcamentoCategoriasEssenciais = roundCurrency(
    essentialCategories.reduce(
      (sum, cat) => sum + (cat.orcamentoMensal ? decimalToNumber(cat.orcamentoMensal) : 0),
      0,
    ),
  );

  let receitasMes = 0;
  let gastosEssenciaisMesAtual = 0;

  for (const tx of monthTransactions) {
    const valor = decimalToNumber(tx.valor);
    if (tx.tipo === 'REC') {
      receitasMes += valor;
    } else if (
      tx.tipo === 'DESP' &&
      tx.categoria?.ehEssencial &&
      (tx.status === 'PAGO' || tx.cartaoId !== null || tx.recorrenciaId !== null)
    ) {
      gastosEssenciaisMesAtual += valor;
    }
  }

  receitasMes = roundCurrency(receitasMes);
  gastosEssenciaisMesAtual = roundCurrency(gastosEssenciaisMesAtual);

  const custoEssencialSugerido = roundCurrency(
    Math.max(fixasEssenciaisAtivas, gastosEssenciaisMesAtual, orcamentoCategoriasEssenciais),
  );

  let aportesMes = 0;
  let resgatesMes = 0;

  const recentMovementsPoints = windowMovementsRaw.map((mov) => {
    const month = mov.dataMovimento.toISOString().slice(0, 7);
    const valor = decimalToNumber(mov.valor);
    if (month === reference.month) {
      if (mov.tipo === 'APORTE') {
        aportesMes += valor;
      } else {
        resgatesMes += valor;
      }
    }
    return {
      month,
      tipo: mov.tipo,
      valor,
    };
  });

  const custoVidaMensal = decimalToNumber(usuario.custoVidaMensal);
  const pctPaguePrimeiro = decimalToNumber(usuario.pctPaguePrimeiro);
  const gatilhoInvestPct = decimalToNumber(usuario.gatilhoInvestPct);
  const valorMetaCalculado = decimalToNumber(reserva.valorMetaCalculado);
  const saldoAcumulado = decimalToNumber(reserva.saldoAcumulado);

  const thermometer = calculateReserveThermometer({
    saldoAcumulado,
    valorMetaCalculado,
    custoVidaMensal,
    mesesReservaAlvo: usuario.mesesReservaAlvo,
    gatilhoInvestPct,
    referenceMonth: reference.month,
    recentMovements: recentMovementsPoints,
  });

  const monthlyPriority = evaluateMonthlyReservePriority({
    saldoAcumulado,
    valorMetaCalculado,
    receitasMes,
    pctPaguePrimeiro,
    aportesMes,
    resgatesMes,
  });

  return {
    reservaId: reserva.id,
    contaCofreId: reserva.contaCofreId,
    contaCofreNome: reserva.contaCofre.nome,
    referenceDate: reference.referenceDate,
    month: reference.month,
    custoVidaMensal,
    mesesReservaAlvo: usuario.mesesReservaAlvo,
    pctPaguePrimeiro,
    gatilhoInvestPct,
    valorMetaCalculado,
    saldoAcumulado,
    travaResgateAtiva: reserva.travaResgateAtiva,
    statusGatilho: thermometer.statusGatilho,
    calculatorSuggestion: {
      fixasEssenciaisAtivas,
      gastosEssenciaisMesAtual,
      orcamentoCategoriasEssenciais,
      custoEssencialSugerido,
    },
    thermometer,
    monthlyPriority,
    movements: recentMovementsRaw.map(formatReserveMovement),
  };
}

export async function updateReserveConfig(
  userId: string,
  input: UpdateReserveConfigInput,
): Promise<ReserveOverviewDto> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.usuario.findUnique({
      where: { id: userId },
      include: { reservaEmergencia: true },
    });

    if (!existing || !existing.reservaEmergencia) {
      throw new AppError('Reserva de emergência não encontrada.', 404, 'RESERVE_NOT_FOUND');
    }

    const updatedUser = await tx.usuario.update({
      where: { id: userId },
      data: {
        ...(input.custoVidaMensal !== undefined
          ? { custoVidaMensal: toDecimalString(input.custoVidaMensal) }
          : {}),
        ...(input.mesesReservaAlvo !== undefined
          ? { mesesReservaAlvo: input.mesesReservaAlvo }
          : {}),
        ...(input.pctPaguePrimeiro !== undefined
          ? { pctPaguePrimeiro: toDecimalString(input.pctPaguePrimeiro) }
          : {}),
        ...(input.gatilhoInvestPct !== undefined
          ? { gatilhoInvestPct: toDecimalString(input.gatilhoInvestPct) }
          : {}),
      },
    });

    const novaMeta = calculateIdealReserveTarget(
      decimalToNumber(updatedUser.custoVidaMensal),
      updatedUser.mesesReservaAlvo,
    );

    const novoStatusGatilho = evaluateInvestmentTriggerStatus(
      decimalToNumber(existing.reservaEmergencia.saldoAcumulado),
      novaMeta,
      decimalToNumber(updatedUser.gatilhoInvestPct),
    );

    await tx.reservaEmergencia.update({
      where: { id: existing.reservaEmergencia.id },
      data: {
        valorMetaCalculado: toDecimalString(novaMeta),
        statusGatilho: novoStatusGatilho,
        ...(input.travaResgateAtiva !== undefined
          ? { travaResgateAtiva: input.travaResgateAtiva }
          : {}),
      },
    });
  });

  return getReserveOverview(userId);
}

export async function createReserveDeposit(
  userId: string,
  input: CreateReserveDepositInput,
): Promise<ReserveMutationResponseDto> {
  const movementRef = parseReferenceDateStrict(input.dataMovimento);
  const valorDecimal = toDecimalString(input.valor);

  const createdMovement = await prisma.$transaction(async (tx) => {
    const reserva = await tx.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      include: {
        usuario: { select: { gatilhoInvestPct: true } },
      },
    });

    if (!reserva) {
      throw new AppError('Reserva de emergência não encontrada.', 404, 'RESERVE_NOT_FOUND');
    }

    const contaOrigem = await resolveLiquidAccountForReserve(
      tx,
      userId,
      reserva.contaCofreId,
      input.contaOrigemId,
      'origem',
    );

    const transfer = await tx.transacao.create({
      data: {
        usuarioId: userId,
        contaId: contaOrigem.id,
        contaDestinoId: reserva.contaCofreId,
        cartaoId: null,
        categoriaId: null,
        recorrenciaId: null,
        tipo: 'TRANSF',
        valor: valorDecimal,
        descricao: (input.descricao ?? 'Aporte Pague-se Primeiro (Reserva)').slice(0, 200),
        dataCompetencia: new Date(`${movementRef.referenceDate}T00:00:00.000Z`),
        status: 'PAGO',
        hashDedup: `reserva-ap:${randomUUID()}`,
      },
      select: { id: true },
    });

    await tx.conta.update({
      where: { id: contaOrigem.id },
      data: { saldoAtual: { decrement: valorDecimal } },
    });

    await tx.conta.update({
      where: { id: reserva.contaCofreId },
      data: { saldoAtual: { increment: valorDecimal } },
    });

    const novoSaldo = roundCurrency(decimalToNumber(reserva.saldoAcumulado) + input.valor);
    const novoStatusGatilho = evaluateInvestmentTriggerStatus(
      novoSaldo,
      decimalToNumber(reserva.valorMetaCalculado),
      decimalToNumber(reserva.usuario.gatilhoInvestPct),
    );

    await tx.reservaEmergencia.update({
      where: { id: reserva.id },
      data: {
        saldoAcumulado: toDecimalString(novoSaldo),
        statusGatilho: novoStatusGatilho,
      },
    });

    return tx.movimentoReserva.create({
      data: {
        reservaId: reserva.id,
        transacaoOrigemId: transfer.id,
        tipo: 'APORTE',
        valor: valorDecimal,
        justificativaResgate: null,
        dataMovimento: new Date(`${movementRef.referenceDate}T12:00:00.000Z`),
      },
    });
  });

  const overview = await getReserveOverview(userId, movementRef.referenceDate);
  return {
    movement: formatReserveMovement(createdMovement),
    overview,
  };
}

export async function createReserveWithdrawal(
  userId: string,
  input: CreateReserveWithdrawalInput,
): Promise<ReserveWithdrawalResponseDto> {
  const movementRef = parseReferenceDateStrict(input.dataMovimento);
  const trimmedJustificativa = input.justificativaResgate.trim();

  if (!input.confirmacaoDuasEtapas || trimmedJustificativa.length < 15) {
    throw new AppError(
      'O resgate do Cofre exige confirmação em duas etapas e justificativa com no mínimo 15 caracteres.',
      400,
      'INVALID_WITHDRAWAL_JUSTIFICATION',
    );
  }

  const valorDecimal = toDecimalString(input.valor);

  const txResult = await prisma.$transaction(async (tx) => {
    const reserva = await tx.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      include: {
        usuario: {
          select: {
            custoVidaMensal: true,
            gatilhoInvestPct: true,
          },
        },
      },
    });

    if (!reserva) {
      throw new AppError('Reserva de emergência não encontrada.', 404, 'RESERVE_NOT_FOUND');
    }

    const saldoAtual = decimalToNumber(reserva.saldoAcumulado);
    if (input.valor > saldoAtual) {
      throw new AppError(
        'Saldo insuficiente na Reserva de Emergência para este resgate.',
        400,
        'INSUFFICIENT_RESERVE_BALANCE',
      );
    }

    const contaDestino = await resolveLiquidAccountForReserve(
      tx,
      userId,
      reserva.contaCofreId,
      input.contaDestinoId,
      'destino',
    );

    const impact = simulateWithdrawalImpact({
      valorResgate: input.valor,
      saldoAcumuladoAtual: saldoAtual,
      valorMetaCalculado: decimalToNumber(reserva.valorMetaCalculado),
      custoVidaMensal: decimalToNumber(reserva.usuario.custoVidaMensal),
      gatilhoInvestPct: decimalToNumber(reserva.usuario.gatilhoInvestPct),
    });

    const transfer = await tx.transacao.create({
      data: {
        usuarioId: userId,
        contaId: reserva.contaCofreId,
        contaDestinoId: contaDestino.id,
        cartaoId: null,
        categoriaId: null,
        recorrenciaId: null,
        tipo: 'TRANSF',
        valor: valorDecimal,
        descricao: `Resgate Reserva: ${trimmedJustificativa}`.slice(0, 200),
        dataCompetencia: new Date(`${movementRef.referenceDate}T00:00:00.000Z`),
        status: 'PAGO',
        hashDedup: `reserva-re:${randomUUID()}`,
      },
      select: { id: true },
    });

    await tx.conta.update({
      where: { id: reserva.contaCofreId },
      data: { saldoAtual: { decrement: valorDecimal } },
    });

    await tx.conta.update({
      where: { id: contaDestino.id },
      data: { saldoAtual: { increment: valorDecimal } },
    });

    await tx.reservaEmergencia.update({
      where: { id: reserva.id },
      data: {
        saldoAcumulado: toDecimalString(impact.saldoDepois),
        statusGatilho: impact.statusGatilhoDepois,
      },
    });

    const movement = await tx.movimentoReserva.create({
      data: {
        reservaId: reserva.id,
        transacaoOrigemId: transfer.id,
        tipo: 'RESGATE',
        valor: valorDecimal,
        justificativaResgate: trimmedJustificativa,
        dataMovimento: new Date(`${movementRef.referenceDate}T12:00:00.000Z`),
      },
    });

    return { movement, impact };
  });

  const overview = await getReserveOverview(userId, movementRef.referenceDate);
  return {
    movement: formatReserveMovement(txResult.movement),
    impact: txResult.impact,
    overview,
  };
}

export async function buildReserveSplitSuggestionForIncome(
  userId: string,
  valorReceita: number,
  contaOrigemId: string,
): Promise<ReserveSplitSuggestionDto | null> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    select: {
      pctPaguePrimeiro: true,
      reservaEmergencia: {
        select: {
          valorMetaCalculado: true,
          saldoAcumulado: true,
        },
      },
    },
  });

  if (!usuario || !usuario.reservaEmergencia) {
    return null;
  }

  const pctPaguePrimeiro = decimalToNumber(usuario.pctPaguePrimeiro);
  if (pctPaguePrimeiro <= 0) {
    return null;
  }

  const valorSugerido = calculateSplitAmount(valorReceita, pctPaguePrimeiro);
  if (valorSugerido <= 0) {
    return null;
  }

  const valorMetaCalculado = decimalToNumber(usuario.reservaEmergencia.valorMetaCalculado);
  const saldoAcumulado = decimalToNumber(usuario.reservaEmergencia.saldoAcumulado);

  return {
    pctPaguePrimeiro,
    valorReceita: roundCurrency(valorReceita),
    valorSugerido,
    contaOrigemId,
    valorMetaCalculado,
    saldoAcumulado,
    faltaParaMeta: roundCurrency(Math.max(0, valorMetaCalculado - saldoAcumulado)),
    metaConcluida: valorMetaCalculado > 0 && saldoAcumulado >= valorMetaCalculado,
  };
}
