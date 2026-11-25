import type { Conta } from '@prisma/client';
import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber, toDecimalString } from '../../shared/utils/money.js';
import { evaluateInvestmentTriggerStatus } from '../reserve/reserve.engine.js';
import type {
  AccountDto,
  CreateAccountInput,
  CreateTransferInput,
  TransferDto,
  UpdateAccountInput,
} from './accounts.schemas.js';

function formatAccount(account: Conta, contaCofreId: string | null): AccountDto {
  return {
    id: account.id,
    nome: account.nome,
    tipo: account.tipo,
    saldoAtual: decimalToNumber(account.saldoAtual),
    ehContaPadrao: account.ehContaPadrao,
    ativa: account.ativa,
    ehCofreReserva: contaCofreId === account.id,
  };
}

function parseCompetenceDate(dateString?: string): Date {
  const isoDate = dateString ?? new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new AppError('Data de competência inválida.', 400, 'INVALID_DATE');
  }

  return parsed;
}

export async function listAccounts(
  userId: string,
  includeInactive: boolean,
): Promise<AccountDto[]> {
  const [accounts, reserva] = await Promise.all([
    prisma.conta.findMany({
      where: {
        usuarioId: userId,
        ...(includeInactive ? {} : { ativa: true }),
      },
      orderBy: [{ ehContaPadrao: 'desc' }, { tipo: 'asc' }, { nome: 'asc' }],
    }),
    prisma.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      select: { contaCofreId: true },
    }),
  ]);

  const contaCofreId = reserva?.contaCofreId ?? null;
  return accounts.map((account) => formatAccount(account, contaCofreId));
}

export async function createAccount(
  userId: string,
  input: CreateAccountInput,
): Promise<AccountDto> {
  if (input.tipo === 'COFRE' && input.ehContaPadrao) {
    throw new AppError(
      'Contas do tipo Cofre não podem ser definidas como conta padrão.',
      400,
      'VAULT_CANNOT_BE_DEFAULT',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    if (input.ehContaPadrao) {
      await tx.conta.updateMany({
        where: { usuarioId: userId, ehContaPadrao: true },
        data: { ehContaPadrao: false },
      });
    }

    const account = await tx.conta.create({
      data: {
        usuarioId: userId,
        nome: input.nome,
        tipo: input.tipo,
        saldoAtual: toDecimalString(input.saldoAtual),
        ehContaPadrao: input.ehContaPadrao,
        ativa: true,
      },
    });

    const reserva = await tx.reservaEmergencia.findUnique({
      where: { usuarioId: userId },
      select: { contaCofreId: true },
    });

    return { account, contaCofreId: reserva?.contaCofreId ?? null };
  });

  return formatAccount(result.account, result.contaCofreId);
}

export async function updateAccount(
  userId: string,
  accountId: string,
  input: UpdateAccountInput,
): Promise<AccountDto> {
  const result = await prisma.$transaction(async (tx) => {
    const [existing, reserva] = await Promise.all([
      tx.conta.findFirst({
        where: { id: accountId, usuarioId: userId },
      }),
      tx.reservaEmergencia.findUnique({
        where: { usuarioId: userId },
        select: { contaCofreId: true },
      }),
    ]);

    if (!existing) {
      throw new AppError('Conta não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    }

    const contaCofreId = reserva?.contaCofreId ?? null;
    const nextEhContaPadrao = input.ehContaPadrao ?? existing.ehContaPadrao;
    const nextAtiva = input.ativa ?? existing.ativa;

    if (!nextAtiva && nextEhContaPadrao) {
      throw new AppError(
        'Não é possível desativar a conta padrão do usuário.',
        400,
        'CANNOT_DEACTIVATE_DEFAULT_ACCOUNT',
      );
    }

    if (!nextAtiva && contaCofreId === existing.id) {
      throw new AppError(
        'Não é possível desativar a conta cofre vinculada à reserva de emergência.',
        400,
        'CANNOT_DEACTIVATE_RESERVE_VAULT',
      );
    }

    if (nextEhContaPadrao && (existing.tipo === 'COFRE' || contaCofreId === existing.id)) {
      throw new AppError(
        'Contas do tipo Cofre não podem ser definidas como conta padrão.',
        400,
        'VAULT_CANNOT_BE_DEFAULT',
      );
    }

    if (input.ehContaPadrao === true && !existing.ehContaPadrao) {
      await tx.conta.updateMany({
        where: { usuarioId: userId, ehContaPadrao: true },
        data: { ehContaPadrao: false },
      });
    }

    const updated = await tx.conta.update({
      where: { id: existing.id },
      data: {
        ...(input.nome !== undefined ? { nome: input.nome } : {}),
        ...(input.ehContaPadrao !== undefined ? { ehContaPadrao: input.ehContaPadrao } : {}),
        ...(input.ativa !== undefined ? { ativa: input.ativa } : {}),
      },
    });

    return { updated, contaCofreId };
  });

  return formatAccount(result.updated, result.contaCofreId);
}

export async function createInternalTransfer(
  userId: string,
  input: CreateTransferInput,
): Promise<{
  transfer: TransferDto;
  contaOrigem: AccountDto;
  contaDestino: AccountDto;
}> {
  if (input.contaOrigemId === input.contaDestinoId) {
    throw new AppError(
      'Conta de origem e destino devem ser diferentes.',
      400,
      'SAME_ACCOUNT_TRANSFER',
    );
  }

  const dataCompetencia = parseCompetenceDate(input.dataCompetencia);
  const valorDecimal = toDecimalString(input.valor);

  const result = await prisma.$transaction(async (tx) => {
    const [accounts, reserva] = await Promise.all([
      tx.conta.findMany({
        where: {
          id: { in: [input.contaOrigemId, input.contaDestinoId] },
          usuarioId: userId,
        },
      }),
      tx.reservaEmergencia.findUnique({
        where: { usuarioId: userId },
        select: {
          id: true,
          contaCofreId: true,
          saldoAcumulado: true,
          valorMetaCalculado: true,
          usuario: { select: { gatilhoInvestPct: true } },
        },
      }),
    ]);

    const origem = accounts.find((account) => account.id === input.contaOrigemId);
    const destino = accounts.find((account) => account.id === input.contaDestinoId);

    if (!origem || !destino) {
      throw new AppError('Conta de origem ou destino não encontrada.', 404, 'ACCOUNT_NOT_FOUND');
    }

    if (!origem.ativa || !destino.ativa) {
      throw new AppError(
        'Ambas as contas devem estar ativas para realizar transferência.',
        400,
        'INACTIVE_ACCOUNT',
      );
    }

    const contaCofreId = reserva?.contaCofreId ?? null;

    if (contaCofreId && origem.id === contaCofreId) {
      throw new AppError(
        'Resgates da Reserva de Emergência exigem confirmação em duas etapas e justificativa auditável pelo módulo de Reserva.',
        403,
        'VAULT_WITHDRAWAL_LOCKED',
      );
    }

    const transfer = await tx.transacao.create({
      data: {
        usuarioId: userId,
        contaId: origem.id,
        contaDestinoId: destino.id,
        cartaoId: null,
        categoriaId: null,
        tipo: 'TRANSF',
        valor: valorDecimal,
        descricao: input.descricao,
        dataCompetencia,
        status: 'PAGO',
      },
    });

    const contaOrigem = await tx.conta.update({
      where: { id: origem.id },
      data: { saldoAtual: { decrement: valorDecimal } },
    });

    const contaDestino = await tx.conta.update({
      where: { id: destino.id },
      data: { saldoAtual: { increment: valorDecimal } },
    });

    if (contaCofreId && reserva && destino.id === contaCofreId) {
      const novoSaldo = Number((decimalToNumber(reserva.saldoAcumulado) + input.valor).toFixed(2));
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

      await tx.movimentoReserva.create({
        data: {
          reservaId: reserva.id,
          transacaoOrigemId: transfer.id,
          tipo: 'APORTE',
          valor: valorDecimal,
          justificativaResgate: null,
          dataMovimento: new Date(`${dataCompetencia.toISOString().slice(0, 10)}T12:00:00.000Z`),
        },
      });
    }

    return {
      transfer: {
        id: transfer.id,
        tipo: 'TRANSF' as const,
        contaId: origem.id,
        contaDestinoId: destino.id,
        valor: decimalToNumber(transfer.valor),
        descricao: transfer.descricao,
        dataCompetencia: transfer.dataCompetencia.toISOString().slice(0, 10),
        status: transfer.status,
      },
      contaOrigem: formatAccount(contaOrigem, contaCofreId),
      contaDestino: formatAccount(contaDestino, contaCofreId),
    };
  });

  return result;
}
