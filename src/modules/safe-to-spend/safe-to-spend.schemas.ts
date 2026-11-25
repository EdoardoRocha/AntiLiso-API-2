import { z } from 'zod';
import type { SafeToSpendStatus } from './safe-to-spend.engine.js';

export const safeToSpendQuerySchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD')
    .optional(),
});

export interface SafeToSpendDto {
  referenceDate: string;
  month: string;
  daysInMonth: number;
  diasRestantes: number;
  status: SafeToSpendStatus;
  quantoPossoGastarHoje: number;
  saldoLivreMes: number;
  saldoDiarioReal: number;
  breakdown: {
    receitasMes: number;
    receitasPagas: number;
    receitasPendentes: number;
    contasFixasTotal: number;
    contasFixasPagas: number;
    contasFixasPendentes: number;
    pctPaguePrimeiro: number;
    metaReservaPlanejada: number;
    aportesReservaMes: number;
    resgatesReservaMes: number;
    aportesLiquidosReservaMes: number;
    reservaComprometidaMes: number;
    gastosVariaveisRealizados: number;
    totalComprometidoMes: number;
  };
  partition: {
    fixas: { valor: number; percentualReceita: number };
    reserva: { valor: number; percentualReceita: number };
    variaveis: { valor: number; percentualReceita: number };
    livre: { valor: number; percentualReceita: number };
  };
}
