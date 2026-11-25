import { describe, expect, it } from 'vitest';
import {
  calculateIdealReserveTarget,
  calculateReserveThermometer,
  calculateSplitAmount,
  evaluateInvestmentTriggerStatus,
  evaluateMonthlyReservePriority,
  simulateWithdrawalImpact,
} from '../modules/reserve/reserve.engine.js';

describe('Etapa 7 — Emergency Reserve Engine (RF-08..RF-11 / RN-03)', () => {
  it('calcula meta ideal (RF-08) e split Pague-se Primeiro (RF-09)', () => {
    expect(calculateIdealReserveTarget(3500, 6)).toBe(21000);
    expect(calculateIdealReserveTarget(2500.5, 3)).toBe(7501.5);
    expect(calculateSplitAmount(4000, 15)).toBe(600);
    expect(calculateSplitAmount(1234.56, 10)).toBe(123.46);
  });

  it('avalia gatilho de investimentos (RF-12) mantendo BLOQUEADO se meta for zero', () => {
    expect(evaluateInvestmentTriggerStatus(5000, 0, 50)).toBe('BLOQUEADO');
    expect(evaluateInvestmentTriggerStatus(4999.99, 10000, 50)).toBe('BLOQUEADO');
    expect(evaluateInvestmentTriggerStatus(5000, 10000, 50)).toBe('LIBERADO');
    expect(evaluateInvestmentTriggerStatus(10000, 10000, 100)).toBe('LIBERADO');
  });

  it('calcula termômetro e estimativa de conclusão para usuário novo, histórico multi-mês, média nula e meta batida (RF-10)', () => {
    // Usuário no 1º mês com aporte único de R$ 1.000 e meta R$ 6.000 (custo R$ 1.000/mês)
    const firstMonth = calculateReserveThermometer({
      saldoAcumulado: 1000,
      valorMetaCalculado: 6000,
      custoVidaMensal: 1000,
      mesesReservaAlvo: 6,
      gatilhoInvestPct: 50,
      referenceMonth: '2026-11',
      recentMovements: [{ month: '2026-11', tipo: 'APORTE', valor: 1000 }],
    });
    expect(firstMonth.percentualConcluido).toBe(16.67);
    expect(firstMonth.mesesSegurancaCobertos).toBe(1);
    expect(firstMonth.mesesJanelaMedia).toBe(1);
    expect(firstMonth.mediaAportesMensal).toBe(1000);
    expect(firstMonth.mesesRestantesEstimados).toBe(5);
    expect(firstMonth.mesEstimadoConclusao).toBe('2027-04');
    expect(firstMonth.statusGatilho).toBe('BLOQUEADO');

    // Histórico de 3 meses (set..nov = 3 meses): 1000 + 800 - 300 = 1500 líquido / 3 = 500/mês
    const multiMonth = calculateReserveThermometer({
      saldoAcumulado: 3000,
      valorMetaCalculado: 6000,
      custoVidaMensal: 1000,
      mesesReservaAlvo: 6,
      gatilhoInvestPct: 50,
      referenceMonth: '2026-11',
      recentMovements: [
        { month: '2026-09', tipo: 'APORTE', valor: 1000 },
        { month: '2026-11', tipo: 'APORTE', valor: 800 },
        { month: '2026-11', tipo: 'RESGATE', valor: 300 },
      ],
    });
    expect(multiMonth.mesesJanelaMedia).toBe(3);
    expect(multiMonth.mediaAportesMensal).toBe(500);
    expect(multiMonth.mesesRestantesEstimados).toBe(6); // falta 3000 / 500 = 6
    expect(multiMonth.statusGatilho).toBe('LIBERADO');

    // Média nula ou negativa -> estimativa null
    const negativePace = calculateReserveThermometer({
      saldoAcumulado: 500,
      valorMetaCalculado: 6000,
      custoVidaMensal: 1000,
      mesesReservaAlvo: 6,
      gatilhoInvestPct: 50,
      referenceMonth: '2026-11',
      recentMovements: [{ month: '2026-11', tipo: 'RESGATE', valor: 200 }],
    });
    expect(negativePace.mediaAportesMensal).toBe(-200);
    expect(negativePace.mesesRestantesEstimados).toBeNull();
    expect(negativePace.mesEstimadoConclusao).toBeNull();

    // Meta atingida
    const completed = calculateReserveThermometer({
      saldoAcumulado: 6500,
      valorMetaCalculado: 6000,
      custoVidaMensal: 1000,
      mesesReservaAlvo: 6,
      gatilhoInvestPct: 50,
      referenceMonth: '2026-11',
      recentMovements: [],
    });
    expect(completed.metaConcluida).toBe(true);
    expect(completed.valorFaltante).toBe(0);
    expect(completed.mesesRestantesEstimados).toBe(0);
    expect(completed.mesEstimadoConclusao).toBe('2026-11');
  });

  it('simula impacto do resgate (RF-11) e detecta perda de gatilho de investimentos', () => {
    const impact = simulateWithdrawalImpact({
      valorResgate: 2000,
      saldoAcumuladoAtual: 6000,
      valorMetaCalculado: 10000,
      custoVidaMensal: 2000,
      gatilhoInvestPct: 50,
    });

    expect(impact.saldoDepois).toBe(4000);
    expect(impact.percentualAntes).toBe(60);
    expect(impact.percentualDepois).toBe(40);
    expect(impact.mesesCobertosAntes).toBe(3);
    expect(impact.mesesCobertosDepois).toBe(2);
    expect(impact.mesesPerdidos).toBe(1);
    expect(impact.statusGatilhoAntes).toBe('LIBERADO');
    expect(impact.statusGatilhoDepois).toBe('BLOQUEADO');
    expect(impact.perdeuGatilhoInvestimentos).toBe(true);
  });

  it('calcula prioridade absoluta da reserva no mês (RN-03)', () => {
    const priorityPending = evaluateMonthlyReservePriority({
      saldoAcumulado: 1500,
      valorMetaCalculado: 12000,
      receitasMes: 5000,
      pctPaguePrimeiro: 15, // meta mês = 750
      aportesMes: 300,
      resgatesMes: 0,
    });
    expect(priorityPending.abaixoDaMeta).toBe(true);
    expect(priorityPending.prioridadeTopoAtiva).toBe(true);
    expect(priorityPending.acaoPendenteMes).toBe(true);
    expect(priorityPending.metaAporteMes).toBe(750);
    expect(priorityPending.valorPendenteMes).toBe(450);

    const priorityMet = evaluateMonthlyReservePriority({
      saldoAcumulado: 12000,
      valorMetaCalculado: 12000,
      receitasMes: 5000,
      pctPaguePrimeiro: 15,
      aportesMes: 0,
      resgatesMes: 0,
    });
    expect(priorityMet.abaixoDaMeta).toBe(false);
    expect(priorityMet.prioridadeTopoAtiva).toBe(false);
    expect(priorityMet.acaoPendenteMes).toBe(false);
  });
});
