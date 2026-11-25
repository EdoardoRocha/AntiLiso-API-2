import { prisma } from '../../infra/database/prisma.js';
import { AppError } from '../../shared/errors/app-error.js';
import { decimalToNumber } from '../../shared/utils/money.js';
import { generateMonthlyRecurrences } from '../recurrences/recurrences.service.js';
import { calculateSafeToSpend, parseReferenceDateStrict } from './safe-to-spend.engine.js';
import type { SafeToSpendDto } from './safe-to-spend.schemas.js';

export async function getSafeToSpend(userId: string, dateInput?: string): Promise<SafeToSpendDto> {
  const reference = parseReferenceDateStrict(dateInput);

  const usuario = await prisma.usuario.findUnique({
    where: { id: userId },
    select: {
      id: true,
      pctPaguePrimeiro: true,
    },
  });

  if (!usuario) {
    throw new AppError('Usuário não encontrado.', 404, 'USER_NOT_FOUND');
  }

  // Materializa de forma idempotente as contas fixas ativas do mês antes de agregar.
  await generateMonthlyRecurrences(userId, reference.month);

  const [transactions, reserveMovements] = await Promise.all([
    prisma.transacao.findMany({
      where: {
        usuarioId: userId,
        dataCompetencia: {
          gte: reference.gte,
          lt: reference.lt,
        },
        tipo: {
          in: ['REC', 'DESP'],
        },
      },
      select: {
        tipo: true,
        status: true,
        valor: true,
        recorrenciaId: true,
        cartaoId: true,
      },
    }),
    prisma.movimentoReserva.findMany({
      where: {
        reserva: {
          usuarioId: userId,
        },
        dataMovimento: {
          gte: reference.gte,
          lt: reference.lt,
        },
      },
      select: {
        tipo: true,
        valor: true,
      },
    }),
  ]);

  let receitasPagas = 0;
  let receitasPendentes = 0;
  let contasFixasPagas = 0;
  let contasFixasPendentes = 0;
  let gastosVariaveisRealizados = 0;

  for (const tx of transactions) {
    const valor = decimalToNumber(tx.valor);

    if (tx.tipo === 'REC') {
      if (tx.status === 'PAGO') {
        receitasPagas += valor;
      } else {
        receitasPendentes += valor;
      }
      continue;
    }

    if (tx.recorrenciaId !== null) {
      if (tx.status === 'PAGO') {
        contasFixasPagas += valor;
      } else {
        contasFixasPendentes += valor;
      }
      continue;
    }

    if (tx.cartaoId !== null || tx.status === 'PAGO') {
      gastosVariaveisRealizados += valor;
    }
  }

  let aportesReservaMes = 0;
  let resgatesReservaMes = 0;

  for (const mov of reserveMovements) {
    const valor = decimalToNumber(mov.valor);
    if (mov.tipo === 'APORTE') {
      aportesReservaMes += valor;
    } else {
      resgatesReservaMes += valor;
    }
  }

  return calculateSafeToSpend({
    receitasPagas,
    receitasPendentes,
    contasFixasPagas,
    contasFixasPendentes,
    gastosVariaveisRealizados,
    pctPaguePrimeiro: decimalToNumber(usuario.pctPaguePrimeiro),
    aportesReservaMes,
    resgatesReservaMes,
    reference,
  });
}
