import { describe, expect, it } from 'vitest';
import {
  clampDayInMonth,
  evaluateCeilingAlert,
  evaluateInvoiceStatus,
  getInvoiceCycleWindow,
  resolveOpenInvoiceMonth,
} from '../modules/credit-cards/credit-cards.engine.js';

describe('Etapa 6 — Credit Cards Engine (RF-06)', () => {
  it('calcula janela de fechamento e vencimento sem lacunas para dia comum e vencimento no mesmo mês vs próximo mês', () => {
    // Fechamento dia 25, vencimento dia 5 (vence no mês seguinte)
    const novWindow = getInvoiceCycleWindow('2026-11', 25, 5);
    expect(novWindow.periodStartIso).toBe('2026-10-26');
    expect(novWindow.closingDateIso).toBe('2026-11-25');
    expect(novWindow.dueDateIso).toBe('2026-12-05');

    const decWindow = getInvoiceCycleWindow('2026-12', 25, 5);
    expect(decWindow.periodStartIso).toBe('2026-11-26');
    expect(decWindow.closingDateIso).toBe('2026-12-25');
    expect(decWindow.dueDateIso).toBe('2027-01-05');

    // Fechamento dia 10, vencimento dia 20 (vence no próprio mês)
    const sameMonthWindow = getInvoiceCycleWindow('2026-11', 10, 20);
    expect(sameMonthWindow.periodStartIso).toBe('2026-10-11');
    expect(sameMonthWindow.closingDateIso).toBe('2026-11-10');
    expect(sameMonthWindow.dueDateIso).toBe('2026-11-20');
  });

  it('aplica clamping correto para dia 31 e dia 1 sem lacunas nem sobreposições (bissexto e não-bissexto)', () => {
    expect(clampDayInMonth(2026, 2, 31)).toBe(28);
    expect(clampDayInMonth(2028, 2, 31)).toBe(29);

    const jan2026 = getInvoiceCycleWindow('2026-01', 31, 10);
    const feb2026 = getInvoiceCycleWindow('2026-02', 31, 10);
    const mar2026 = getInvoiceCycleWindow('2026-03', 31, 10);

    expect(jan2026.closingDateIso).toBe('2026-01-31');
    expect(feb2026.periodStartIso).toBe('2026-02-01');
    expect(feb2026.closingDateIso).toBe('2026-02-28');
    expect(mar2026.periodStartIso).toBe('2026-03-01');
    expect(mar2026.closingDateIso).toBe('2026-03-31');

    const feb2028 = getInvoiceCycleWindow('2028-02', 31, 10);
    expect(feb2028.closingDateIso).toBe('2028-02-29');

    const dayOne = getInvoiceCycleWindow('2026-11', 1, 10);
    expect(dayOne.periodStartIso).toBe('2026-10-02');
    expect(dayOne.closingDateIso).toBe('2026-11-01');
  });

  it('identifica corretamente a fatura aberta antes, no dia e após o fechamento', () => {
    expect(resolveOpenInvoiceMonth('2026-11-24', 25)).toBe('2026-11');
    expect(resolveOpenInvoiceMonth('2026-11-25', 25)).toBe('2026-11');
    expect(resolveOpenInvoiceMonth('2026-11-26', 25)).toBe('2026-12');
    expect(resolveOpenInvoiceMonth('2026-12-26', 25)).toBe('2027-01');
  });

  it('classifica status da fatura (VAZIA, ABERTA, FECHADA, VENCIDA, PAGA) e alerta de teto mensal', () => {
    expect(
      evaluateInvoiceStatus({
        totalFatura: 0,
        totalPendente: 0,
        closingDateIso: '2026-11-25',
        dueDateIso: '2026-12-05',
        referenceDateIso: '2026-11-20',
      }),
    ).toBe('VAZIA');

    expect(
      evaluateInvoiceStatus({
        totalFatura: 500,
        totalPendente: 0,
        closingDateIso: '2026-11-25',
        dueDateIso: '2026-12-05',
        referenceDateIso: '2026-12-06',
      }),
    ).toBe('PAGA');

    expect(
      evaluateInvoiceStatus({
        totalFatura: 500,
        totalPendente: 500,
        closingDateIso: '2026-11-25',
        dueDateIso: '2026-12-05',
        referenceDateIso: '2026-11-25',
      }),
    ).toBe('ABERTA');

    expect(
      evaluateInvoiceStatus({
        totalFatura: 500,
        totalPendente: 500,
        closingDateIso: '2026-11-25',
        dueDateIso: '2026-12-05',
        referenceDateIso: '2026-11-26',
      }),
    ).toBe('FECHADA');

    expect(
      evaluateInvoiceStatus({
        totalFatura: 500,
        totalPendente: 500,
        closingDateIso: '2026-11-25',
        dueDateIso: '2026-12-05',
        referenceDateIso: '2026-12-06',
      }),
    ).toBe('VENCIDA');

    expect(evaluateCeilingAlert(500, 0)).toEqual({
      percentualTeto: 0,
      alertaTetoAtivo: false,
      alertaTetoStatus: 'SEM_TETO',
    });

    expect(evaluateCeilingAlert(700, 1000)).toEqual({
      percentualTeto: 70,
      alertaTetoAtivo: false,
      alertaTetoStatus: 'OK',
    });

    expect(evaluateCeilingAlert(800, 1000)).toEqual({
      percentualTeto: 80,
      alertaTetoAtivo: false,
      alertaTetoStatus: 'PROXIMO',
    });

    expect(evaluateCeilingAlert(1000, 1000)).toEqual({
      percentualTeto: 100,
      alertaTetoAtivo: true,
      alertaTetoStatus: 'ATINGIDO',
    });
  });
});
