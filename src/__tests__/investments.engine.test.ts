import { describe, expect, it } from 'vitest';
import {
  calculateContributionRebalance,
  consolidatePortfolio,
  simulateCompoundInterest,
} from '../modules/investments/investments.engine.js';

describe('investments.engine — RF-12, RF-13, RF-14 e RF-15', () => {
  const baseAllocations = [
    { id: 'alloc-rf', classeAtivo: 'RF' as const, percentualIdeal: 40 },
    { id: 'alloc-fii', classeAtivo: 'FII' as const, percentualIdeal: 20 },
    { id: 'alloc-acoes', classeAtivo: 'ACOES' as const, percentualIdeal: 20 },
    { id: 'alloc-int', classeAtivo: 'INT' as const, percentualIdeal: 15 },
    { id: 'alloc-cripto', classeAtivo: 'CRIPTO' as const, percentualIdeal: 5 },
  ];

  it('consolida ativos por classe com preço médio, rentabilidade e patrimônio global (RF-13)', () => {
    const result = consolidatePortfolio({
      allocations: baseAllocations,
      assets: [
        {
          id: 'a1',
          alocacaoId: 'alloc-rf',
          classeAtivo: 'RF',
          tickerOuNome: 'Tesouro Selic 2029',
          quantidade: 1,
          valorInvestido: 4000,
          saldoAtualMercado: 4400,
        },
        {
          id: 'a2',
          alocacaoId: 'alloc-fii',
          classeAtivo: 'FII',
          tickerOuNome: 'HGLG11',
          quantidade: 10,
          valorInvestido: 1500,
          saldoAtualMercado: 1600,
        },
        {
          id: 'a3',
          alocacaoId: 'alloc-acoes',
          classeAtivo: 'ACOES',
          tickerOuNome: 'WEGE3',
          quantidade: 100,
          valorInvestido: 4500,
          saldoAtualMercado: 4000,
        },
      ],
      saldoContasLiquidas: 1200,
      saldoReservaEmergencia: 8800,
      statusGatilho: 'LIBERADO',
    });

    expect(result.valorInvestidoCarteira).toBe(10000);
    expect(result.patrimonioCarteira).toBe(10000);
    expect(result.lucroPrejuizoCarteira).toBe(0);
    expect(result.patrimonioTotalGlobal).toBe(20000);

    const rf = result.classes.find((c) => c.classeAtivo === 'RF')!;
    expect(rf.percentualAtual).toBe(44);
    expect(rf.desvioPct).toBe(4);
    expect(rf.rentabilidadePct).toBe(10);

    const acoes = result.classes.find((c) => c.classeAtivo === 'ACOES')!;
    expect(acoes.ativos[0]!.precoMedio).toBe(45);
    expect(acoes.ativos[0]!.cotacaoAtual).toBe(40);
    expect(acoes.ativos[0]!.lucroPrejuizo).toBe(-500);
  });

  it('direciona aporte para a Reserva e RF quando gatilho RF-12 está BLOQUEADO', () => {
    const plan = calculateContributionRebalance({
      valorAporte: 1000,
      statusGatilho: 'BLOQUEADO',
      faltaParaGatilhoReserva: 700,
      classes: [
        {
          classeAtivo: 'RF',
          nomeClasse: 'Renda Fixa & Liquidez',
          isRisco: false,
          percentualIdeal: 40,
          saldoAtualMercado: 500,
        },
        {
          classeAtivo: 'FII',
          nomeClasse: 'Fundos Imobiliários',
          isRisco: true,
          percentualIdeal: 20,
          saldoAtualMercado: 0,
        },
        {
          classeAtivo: 'ACOES',
          nomeClasse: 'Ações Nacionais',
          isRisco: true,
          percentualIdeal: 20,
          saldoAtualMercado: 0,
        },
        {
          classeAtivo: 'INT',
          nomeClasse: 'Internacional / ETFs Globais',
          isRisco: true,
          percentualIdeal: 15,
          saldoAtualMercado: 0,
        },
        {
          classeAtivo: 'CRIPTO',
          nomeClasse: 'Criptoativos',
          isRisco: true,
          percentualIdeal: 5,
          saldoAtualMercado: 0,
        },
      ],
    });

    expect(plan.modo).toBe('PRIORIZAR_RESERVA');
    expect(plan.valorSugeridoReserva).toBe(700);
    expect(plan.classePrioritaria).toBe('RF');
    expect(plan.itens.find((i) => i.classeAtivo === 'RF')!.valorSugeridoAporte).toBe(300);
    expect(
      plan.itens.filter((i) => i.bloqueadaPorGatilho).every((i) => i.valorSugeridoAporte === 0),
    ).toBe(true);
  });

  it('rebalanceia aporte novo com exatidão de centavos sem vender classes sobre-alocadas (RF-14)', () => {
    const plan = calculateContributionRebalance({
      valorAporte: 1000,
      statusGatilho: 'LIBERADO',
      faltaParaGatilhoReserva: 0,
      classes: [
        // RF já está bem acima de 40% (8000 de 10000 pós-aporte = 80%) -> não deve receber nada!
        {
          classeAtivo: 'RF',
          nomeClasse: 'Renda Fixa & Liquidez',
          isRisco: false,
          percentualIdeal: 40,
          saldoAtualMercado: 8000,
        },
        {
          classeAtivo: 'FII',
          nomeClasse: 'Fundos Imobiliários',
          isRisco: true,
          percentualIdeal: 20,
          saldoAtualMercado: 500,
        },
        {
          classeAtivo: 'ACOES',
          nomeClasse: 'Ações Nacionais',
          isRisco: true,
          percentualIdeal: 20,
          saldoAtualMercado: 300,
        },
        {
          classeAtivo: 'INT',
          nomeClasse: 'Internacional / ETFs Globais',
          isRisco: true,
          percentualIdeal: 15,
          saldoAtualMercado: 200,
        },
        {
          classeAtivo: 'CRIPTO',
          nomeClasse: 'Criptoativos',
          isRisco: true,
          percentualIdeal: 5,
          saldoAtualMercado: 0,
        },
      ],
    });

    expect(plan.modo).toBe('REBALANCEAMENTO_CARTEIRA');
    expect(plan.itens.find((i) => i.classeAtivo === 'RF')!.valorSugeridoAporte).toBe(0);
    const totalSuggested =
      Math.round(plan.itens.reduce((acc, item) => acc + item.valorSugeridoAporte, 0) * 100) / 100;
    expect(totalSuggested).toBe(1000);
    expect(plan.classePrioritaria).toBe('ACOES');
  });

  it('projeta juros compostos em 1, 5, 10 e 20 anos e estima prazo da meta (RF-15)', () => {
    const sim = simulateCompoundInterest({
      saldoInicial: 10000,
      aporteMensal: 1000,
      taxaAnualRealPct: 12,
      metaPatrimonio: 50000,
    });

    expect(sim.horizons.map((h) => h.anos)).toEqual([1, 5, 10, 20]);
    expect(sim.horizons[0]!.totalAportado).toBe(22000);
    expect(sim.horizons[0]!.patrimonioFinal).toBeGreaterThan(22000);
    expect(sim.horizons[3]!.patrimonioFinal).toBeGreaterThan(sim.horizons[2]!.patrimonioFinal);
    expect(sim.mesesParaMeta).not.toBeNull();
    expect(sim.mesesParaMeta!).toBeGreaterThan(24);
    expect(sim.mesesParaMeta!).toBeLessThan(36);

    const zeroRate = simulateCompoundInterest({
      saldoInicial: 1000,
      aporteMensal: 500,
      taxaAnualRealPct: 0,
      metaPatrimonio: 7000,
    });
    expect(zeroRate.horizons[0]!.patrimonioFinal).toBe(7000);
    expect(zeroRate.horizons[0]!.jurosAcumulados).toBe(0);
    expect(zeroRate.mesesParaMeta).toBe(12);
  });
});
