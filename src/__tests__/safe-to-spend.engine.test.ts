import { describe, expect, it } from 'vitest';
import { AppError } from '../shared/errors/app-error.js';
import {
  calculateSafeToSpend,
  parseReferenceDateStrict,
} from '../modules/safe-to-spend/safe-to-spend.engine.js';

describe('Safe-to-Spend Engine (RF-04 / RN-01 / RN-04)', () => {
  it('calcula a fórmula exata de Safe-to-Spend e partição Base Zero (RN-01)', () => {
    const reference = parseReferenceDateStrict('2026-11-11');
    expect(reference.daysInMonth).toBe(30);
    expect(reference.diasRestantes).toBe(20);

    const result = calculateSafeToSpend({
      receitasPagas: 5000,
      receitasPendentes: 0,
      contasFixasPagas: 1200,
      contasFixasPendentes: 800,
      gastosVariaveisRealizados: 500,
      pctPaguePrimeiro: 10, // metaReservaPlanejada = 500
      aportesReservaMes: 0,
      resgatesReservaMes: 0,
      reference,
    });

    // (5000 - 2000 - 500 - 500) / 20 = 2000 / 20 = 100
    expect(result.status).toBe('SAUDAVEL');
    expect(result.saldoLivreMes).toBe(2000);
    expect(result.saldoDiarioReal).toBe(100);
    expect(result.quantoPossoGastarHoje).toBe(100);

    expect(result.breakdown.contasFixasTotal).toBe(2000);
    expect(result.breakdown.metaReservaPlanejada).toBe(500);
    expect(result.breakdown.reservaComprometidaMes).toBe(500);
    expect(result.breakdown.totalComprometidoMes).toBe(3000);

    expect(result.partition.fixas).toEqual({ valor: 2000, percentualReceita: 40 });
    expect(result.partition.reserva).toEqual({ valor: 500, percentualReceita: 10 });
    expect(result.partition.variaveis).toEqual({ valor: 500, percentualReceita: 10 });
    expect(result.partition.livre).toEqual({ valor: 2000, percentualReceita: 40 });
  });

  it('usa diasRestantes = 1 no último dia do mês', () => {
    const novEnd = parseReferenceDateStrict('2026-11-30');
    expect(novEnd.daysInMonth).toBe(30);
    expect(novEnd.diasRestantes).toBe(1);

    const febEnd = parseReferenceDateStrict('2026-02-28');
    expect(febEnd.daysInMonth).toBe(28);
    expect(febEnd.diasRestantes).toBe(1);

    const result = calculateSafeToSpend({
      receitasPagas: 4000,
      receitasPendentes: 0,
      contasFixasPagas: 2000,
      contasFixasPendentes: 0,
      gastosVariaveisRealizados: 1000,
      pctPaguePrimeiro: 15, // 600
      aportesReservaMes: 600,
      resgatesReservaMes: 0,
      reference: novEnd,
    });

    // Livre = 4000 - 2000 - 600 - 1000 = 400; 400 / 1 = 400 (10% da receita -> ATENCAO)
    expect(result.saldoLivreMes).toBe(400);
    expect(result.quantoPossoGastarHoje).toBe(400);
    expect(result.status).toBe('ATENCAO');
  });

  it('zera quantoPossoGastarHoje em estouro, expõe saldoDiarioReal negativo e marca ESGOTADO (RN-04)', () => {
    const reference = parseReferenceDateStrict('2026-11-21'); // diasRestantes = 10

    const result = calculateSafeToSpend({
      receitasPagas: 3000,
      receitasPendentes: 0,
      contasFixasPagas: 1500,
      contasFixasPendentes: 500,
      gastosVariaveisRealizados: 1200,
      pctPaguePrimeiro: 10, // 300
      aportesReservaMes: 0,
      resgatesReservaMes: 0,
      reference,
    });

    // Total comprometido = 2000 + 300 + 1200 = 3500 -> Livre = -500 -> /10 = -50
    expect(result.status).toBe('ESGOTADO');
    expect(result.saldoLivreMes).toBe(-500);
    expect(result.saldoDiarioReal).toBe(-50);
    expect(result.quantoPossoGastarHoje).toBe(0);
    expect(result.partition.livre).toEqual({ valor: 0, percentualReceita: 0 });
  });

  it('retorna status SEM_RECEITA quando receitasMes <= 0', () => {
    const reference = parseReferenceDateStrict('2026-11-15');

    const result = calculateSafeToSpend({
      receitasPagas: 0,
      receitasPendentes: 0,
      contasFixasPagas: 0,
      contasFixasPendentes: 500,
      gastosVariaveisRealizados: 0,
      pctPaguePrimeiro: 15,
      aportesReservaMes: 0,
      resgatesReservaMes: 0,
      reference,
    });

    expect(result.status).toBe('SEM_RECEITA');
    expect(result.quantoPossoGastarHoje).toBe(0);
    expect(result.breakdown.metaReservaPlanejada).toBe(0);
    expect(result.saldoLivreMes).toBe(-500);
  });

  it('considera aportesLiquidosReservaMes quando ultrapassam metaReservaPlanejada sem duplicar', () => {
    const reference = parseReferenceDateStrict('2026-11-11'); // diasRestantes = 20

    const result = calculateSafeToSpend({
      receitasPagas: 5000,
      receitasPendentes: 0,
      contasFixasPagas: 1000,
      contasFixasPendentes: 0,
      gastosVariaveisRealizados: 0,
      pctPaguePrimeiro: 10, // metaReservaPlanejada = 500
      aportesReservaMes: 1100,
      resgatesReservaMes: 100, // aportesLiquidosReservaMes = 1000 > 500
      reference,
    });

    expect(result.breakdown.metaReservaPlanejada).toBe(500);
    expect(result.breakdown.aportesLiquidosReservaMes).toBe(1000);
    expect(result.breakdown.reservaComprometidaMes).toBe(1000);
    expect(result.saldoLivreMes).toBe(3000);
    expect(result.quantoPossoGastarHoje).toBe(150);
  });

  it('rejeita data de calendário inválida como 2026-02-31', () => {
    expect(() => parseReferenceDateStrict('2026-02-31')).toThrowError(AppError);

    try {
      parseReferenceDateStrict('2026-02-31');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).code).toBe('INVALID_REFERENCE_DATE');
    }
  });
});
