import type { Prisma } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { evaluateInvestmentTriggerStatus } from '../reserve/reserve.engine.js';
import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';
import {
  ASSET_CLASSES,
  calculateContributionRebalance,
  consolidatePortfolio,
  decimalQuantityToNumber,
  DEFAULT_TARGET_ALLOCATIONS,
  isRiskAssetClass,
  roundQuantity,
  simulateCompoundInterest,
  toQuantityDecimalString,
  type AssetClass,
} from './investments.engine.js';
import type {
  AddAssetContributionInput,
  CompoundSimulationDto,
  CreateAssetInput,
  InvestmentsOverviewDto,
  InvestmentTriggerStateDto,
  PortfolioAssetResponseDto,
  PutAllocationsInput,
  RebalancePlanDto,
  SimulateCompoundInput,
  UpdateAssetInput,
} from './investments.schemas.js';

type DbClient = Prisma.TransactionClient | typeof prisma;

export async function ensureDefaultAllocations(db: DbClient, userId: string) {
  let rows = await db.alocacaoAlvo.findMany({
    where: { usuarioId: userId },
  });

  if (rows.length < ASSET_CLASSES.length) {
    if (rows.length === 0) {
      await db.alocacaoAlvo.createMany({
        data: DEFAULT_TARGET_ALLOCATIONS.map((item) => ({
          usuarioId: userId,
          classeAtivo: item.classeAtivo,
          percentualIdeal: toDecimalString(item.percentualIdeal),
        })),
        skipDuplicates: true,
      });
    } else {
      const existingSet = new Set(rows.map((r) => r.classeAtivo));
      const missing = ASSET_CLASSES.filter((cls) => !existingSet.has(cls));
      if (missing.length > 0) {
        await db.alocacaoAlvo.createMany({
          data: missing.map((classeAtivo) => ({
            usuarioId: userId,
            classeAtivo,
            percentualIdeal: '0.00',
          })),
          skipDuplicates: true,
        });
      }
    }

    rows = await db.alocacaoAlvo.findMany({
      where: { usuarioId: userId },
    });
  }

  return rows;
}

async function loadTriggerState(db: DbClient, userId: string): Promise<InvestmentTriggerStateDto> {
  const [usuario, reserva] = await Promise.all([
    db.usuario.findUnique({
      where: { id: userId },
      select: { gatilhoInvestPct: true },
    }),
    db.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      select: { valorMetaCalculado: true, saldoAcumulado: true },
    }),
  ]);

  if (!usuario || !reserva) {
    throw new AppError('Usuário ou reserva não encontrados.', 404, 'RESERVE_NOT_FOUND');
  }

  const gatilhoInvestPct = decimalToNumber(usuario.gatilhoInvestPct);
  const valorMetaReserva = decimalToNumber(reserva.valorMetaCalculado);
  const saldoReservaAtual = decimalToNumber(reserva.saldoAcumulado);

  const statusGatilho = evaluateInvestmentTriggerStatus(
    saldoReservaAtual,
    valorMetaReserva,
    gatilhoInvestPct,
  );
  const valorGatilhoRequerido =
    valorMetaReserva > 0 ? roundCurrency(valorMetaReserva * (gatilhoInvestPct / 100)) : 0;
  const faltaParaDesbloquear =
    valorMetaReserva > 0
      ? roundCurrency(Math.max(0, valorGatilhoRequerido - saldoReservaAtual))
      : 0;
  const percentualReservaAtual =
    valorMetaReserva > 0 ? roundCurrency((saldoReservaAtual / valorMetaReserva) * 100) : 0;

  return {
    statusGatilho,
    modoEducativoAtivo: statusGatilho === 'BLOQUEADO',
    gatilhoInvestPct,
    valorMetaReserva,
    saldoReservaAtual,
    percentualReservaAtual,
    valorGatilhoRequerido,
    faltaParaDesbloquear,
  };
}

function assertRiskClassAllowed(
  triggerStatus: 'BLOQUEADO' | 'LIBERADO',
  classeAtivo: AssetClass,
): void {
  if (isRiskAssetClass(classeAtivo) && triggerStatus === 'BLOQUEADO') {
    throw new AppError(
      'Módulo de ativos de risco em Modo Educativo: atinja o gatilho mínimo da Reserva de Emergência antes de aportar em FIIs, Ações, Internacional ou Cripto.',
      403,
      'INVESTMENT_TRIGGER_LOCKED',
    );
  }
}

async function buildOverview(
  db: DbClient,
  userId: string,
  valorAporteSugerido?: number,
): Promise<InvestmentsOverviewDto> {
  const [trigger, allocations, assets, liquidAccounts] = await Promise.all([
    loadTriggerState(db, userId),
    ensureDefaultAllocations(db, userId),
    db.ativoCarteira.findMany({
      where: { usuarioId: userId },
      include: {
        alocacao: { select: { classeAtivo: true } },
      },
    }),
    db.conta.findMany({
      where: {
        usuarioId: userId,
        ativa: true,
        tipo: { in: ['CORRENTE', 'CARTEIRA'] },
      },
      select: { saldoAtual: true },
    }),
  ]);

  const saldoContasLiquidas = roundCurrency(
    liquidAccounts.reduce((acc, account) => acc + decimalToNumber(account.saldoAtual), 0),
  );

  const consolidated = consolidatePortfolio({
    allocations: allocations.map((a) => ({
      id: a.id,
      classeAtivo: a.classeAtivo as AssetClass,
      percentualIdeal: decimalToNumber(a.percentualIdeal),
    })),
    assets: assets.map((asset) => ({
      id: asset.id,
      alocacaoId: asset.alocacaoId,
      classeAtivo: asset.alocacao.classeAtivo as AssetClass,
      tickerOuNome: asset.tickerOuNome,
      quantidade: decimalQuantityToNumber(asset.quantidade),
      valorInvestido: decimalToNumber(asset.valorInvestido),
      saldoAtualMercado: decimalToNumber(asset.saldoAtualMercado),
    })),
    saldoContasLiquidas,
    saldoReservaEmergencia: trigger.saldoReservaAtual,
    statusGatilho: trigger.statusGatilho,
  });

  const rebalanceSugerido =
    valorAporteSugerido !== undefined && valorAporteSugerido > 0
      ? calculateContributionRebalance({
          valorAporte: valorAporteSugerido,
          statusGatilho: trigger.statusGatilho,
          faltaParaGatilhoReserva: trigger.faltaParaDesbloquear,
          classes: consolidated.classes,
        })
      : null;

  return {
    trigger,
    ...consolidated,
    rebalanceSugerido,
  };
}

export async function getInvestmentsOverview(
  userId: string,
  valorAporteSugerido?: number,
): Promise<InvestmentsOverviewDto> {
  return buildOverview(prisma, userId, valorAporteSugerido);
}

export async function updateTargetAllocations(
  userId: string,
  input: PutAllocationsInput,
): Promise<InvestmentsOverviewDto> {
  const sum = roundCurrency(input.allocations.reduce((acc, item) => acc + item.percentualIdeal, 0));
  if (Math.abs(sum - 100) > 0.001) {
    throw new AppError(
      'A soma dos percentuais ideais das 5 classes deve ser exatamente 100%.',
      400,
      'INVALID_ALLOCATION_SUM',
    );
  }

  return prisma.$transaction(async (tx) => {
    const existing = await ensureDefaultAllocations(tx, userId);
    const byClass = new Map(existing.map((row) => [row.classeAtivo, row.id]));

    for (const item of input.allocations) {
      const id = byClass.get(item.classeAtivo);
      if (!id) {
        continue;
      }
      await tx.alocacaoAlvo.update({
        where: { id },
        data: { percentualIdeal: toDecimalString(item.percentualIdeal) },
      });
    }

    return buildOverview(tx, userId);
  });
}

export async function createPortfolioAsset(
  userId: string,
  input: CreateAssetInput,
): Promise<PortfolioAssetResponseDto> {
  return prisma.$transaction(async (tx) => {
    const trigger = await loadTriggerState(tx, userId);
    assertRiskClassAllowed(trigger.statusGatilho, input.classeAtivo);

    const allocations = await ensureDefaultAllocations(tx, userId);
    const targetAllocation = allocations.find((a) => a.classeAtivo === input.classeAtivo);
    if (!targetAllocation) {
      throw new AppError('Classe de alocação não encontrada.', 404, 'ALLOCATION_NOT_FOUND');
    }

    const created = await tx.ativoCarteira.create({
      data: {
        usuarioId: userId,
        alocacaoId: targetAllocation.id,
        tickerOuNome: input.tickerOuNome,
        quantidade: toQuantityDecimalString(input.quantidade),
        valorInvestido: toDecimalString(roundCurrency(input.valorInvestido)),
        saldoAtualMercado: toDecimalString(roundCurrency(input.saldoAtualMercado)),
      },
    });

    const overview = await buildOverview(tx, userId);

    return {
      asset: {
        id: created.id,
        alocacaoId: created.alocacaoId,
        classeAtivo: input.classeAtivo,
        tickerOuNome: created.tickerOuNome,
        quantidade: decimalQuantityToNumber(created.quantidade),
        valorInvestido: decimalToNumber(created.valorInvestido),
        saldoAtualMercado: decimalToNumber(created.saldoAtualMercado),
      },
      overview,
    };
  });
}

export async function updatePortfolioAsset(
  userId: string,
  assetId: string,
  input: UpdateAssetInput,
): Promise<PortfolioAssetResponseDto> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ativoCarteira.findFirst({
      where: { id: assetId, usuarioId: userId },
      include: { alocacao: { select: { classeAtivo: true } } },
    });

    if (!existing) {
      throw new AppError('Ativo não encontrado na carteira.', 404, 'ASSET_NOT_FOUND');
    }

    const currentClass = existing.alocacao.classeAtivo as AssetClass;
    const nextClass = input.classeAtivo ?? currentClass;
    const currentInvested = decimalToNumber(existing.valorInvestido);
    const currentQuantity = decimalQuantityToNumber(existing.quantidade);

    const trigger = await loadTriggerState(tx, userId);

    if (nextClass !== currentClass && isRiskAssetClass(nextClass)) {
      assertRiskClassAllowed(trigger.statusGatilho, nextClass);
    }

    const isIncreasingPosition =
      (input.valorInvestido !== undefined && input.valorInvestido > currentInvested + 0.001) ||
      (input.quantidade !== undefined && input.quantidade > currentQuantity + 1e-6);

    if (isIncreasingPosition && isRiskAssetClass(nextClass)) {
      assertRiskClassAllowed(trigger.statusGatilho, nextClass);
    }

    let nextAlocacaoId = existing.alocacaoId;
    if (input.classeAtivo && input.classeAtivo !== currentClass) {
      const allocations = await ensureDefaultAllocations(tx, userId);
      const found = allocations.find((a) => a.classeAtivo === input.classeAtivo);
      if (!found) {
        throw new AppError('Classe de alocação não encontrada.', 404, 'ALLOCATION_NOT_FOUND');
      }
      nextAlocacaoId = found.id;
    }

    const updated = await tx.ativoCarteira.update({
      where: { id: existing.id },
      data: {
        alocacaoId: nextAlocacaoId,
        ...(input.tickerOuNome !== undefined ? { tickerOuNome: input.tickerOuNome } : {}),
        ...(input.quantidade !== undefined
          ? { quantidade: toQuantityDecimalString(input.quantidade) }
          : {}),
        ...(input.valorInvestido !== undefined
          ? { valorInvestido: toDecimalString(roundCurrency(input.valorInvestido)) }
          : {}),
        ...(input.saldoAtualMercado !== undefined
          ? { saldoAtualMercado: toDecimalString(roundCurrency(input.saldoAtualMercado)) }
          : {}),
      },
    });

    const overview = await buildOverview(tx, userId);

    return {
      asset: {
        id: updated.id,
        alocacaoId: updated.alocacaoId,
        classeAtivo: nextClass,
        tickerOuNome: updated.tickerOuNome,
        quantidade: decimalQuantityToNumber(updated.quantidade),
        valorInvestido: decimalToNumber(updated.valorInvestido),
        saldoAtualMercado: decimalToNumber(updated.saldoAtualMercado),
      },
      overview,
    };
  });
}

export async function addAssetContribution(
  userId: string,
  assetId: string,
  input: AddAssetContributionInput,
): Promise<PortfolioAssetResponseDto> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ativoCarteira.findFirst({
      where: { id: assetId, usuarioId: userId },
      include: { alocacao: { select: { classeAtivo: true } } },
    });

    if (!existing) {
      throw new AppError('Ativo não encontrado na carteira.', 404, 'ASSET_NOT_FOUND');
    }

    const classeAtivo = existing.alocacao.classeAtivo as AssetClass;
    const trigger = await loadTriggerState(tx, userId);
    assertRiskClassAllowed(trigger.statusGatilho, classeAtivo);

    const nextQuantity = roundQuantity(
      decimalQuantityToNumber(existing.quantidade) + input.quantidadeAdicional,
    );
    const nextInvested = roundCurrency(
      decimalToNumber(existing.valorInvestido) + input.valorAporte,
    );
    const marketDelta = input.saldoMercadoAdicional ?? input.valorAporte;
    const nextMarket = roundCurrency(decimalToNumber(existing.saldoAtualMercado) + marketDelta);

    const updated = await tx.ativoCarteira.update({
      where: { id: existing.id },
      data: {
        quantidade: toQuantityDecimalString(nextQuantity),
        valorInvestido: toDecimalString(nextInvested),
        saldoAtualMercado: toDecimalString(nextMarket),
      },
    });

    const overview = await buildOverview(tx, userId);

    return {
      asset: {
        id: updated.id,
        alocacaoId: updated.alocacaoId,
        classeAtivo,
        tickerOuNome: updated.tickerOuNome,
        quantidade: decimalQuantityToNumber(updated.quantidade),
        valorInvestido: decimalToNumber(updated.valorInvestido),
        saldoAtualMercado: decimalToNumber(updated.saldoAtualMercado),
      },
      overview,
    };
  });
}

export async function deletePortfolioAsset(userId: string, assetId: string): Promise<void> {
  const existing = await prisma.ativoCarteira.findFirst({
    where: { id: assetId, usuarioId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('Ativo não encontrado na carteira.', 404, 'ASSET_NOT_FOUND');
  }

  await prisma.ativoCarteira.delete({
    where: { id: existing.id },
  });
}

export async function calculateUserRebalance(
  userId: string,
  valorAporte: number,
): Promise<RebalancePlanDto> {
  const overview = await buildOverview(prisma, userId, valorAporte);
  return overview.rebalanceSugerido!;
}

export function runCompoundSimulation(input: SimulateCompoundInput): CompoundSimulationDto {
  return simulateCompoundInterest(input);
}
