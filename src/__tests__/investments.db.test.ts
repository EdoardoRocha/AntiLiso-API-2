import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 9 — Módulo de Investimentos e Patrimônio (RF-12 a RF-15)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      // Custo de vida = 2000 * 6 = 12000 meta reserva. Gatilho 50% -> libera com R$ 6.000,00.
      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF12 User A',
            email: `rf12-a-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            custoVidaMensal: 2000,
            mesesReservaAlvo: 6,
            gatilhoInvestPct: 50,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF12 User B',
            email: `rf12-b-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
          },
        }),
      ]);

      expect(regA.statusCode).toBe(201);
      expect(regB.statusCode).toBe(201);

      userAId = regA.json().user.id;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const accountsARes = await app.inject({
        method: 'GET',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      const accountsA = accountsARes.json().accounts as Array<{
        id: string;
        ehContaPadrao: boolean;
      }>;
      contaPadraoAId = accountsA.find((a) => a.ehContaPadrao)!.id;

      await prisma.conta.update({
        where: { id: contaPadraoAId },
        data: { saldoAtual: '10000.00' },
      });
    });

    afterAll(async () => {
      const ids = [userAId, userBId].filter(Boolean);
      if (ids.length > 0) {
        await prisma.ativoCarteira.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.alocacaoAlvo.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.regraAprendizado.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.movimentoReserva.deleteMany({
          where: { reserva: { usuarioId: { in: ids } } },
        });
        await prisma.transacao.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.recorrencia.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.cartaoCredito.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.reservaEmergencia.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.conta.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.categoria.deleteMany({ where: { usuarioId: { in: ids } } });
        await prisma.usuario.deleteMany({ where: { id: { in: ids } } });
      }
      await app.close();
      await prisma.$disconnect();
    });

    it('provisiona alocações padrão, valida soma = 100% e impõe bloqueio RF-12 para risco enquanto reserva < gatilho', async () => {
      const initialOverview = await app.inject({
        method: 'GET',
        url: '/investments',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(initialOverview.statusCode).toBe(200);
      expect(initialOverview.json().trigger).toMatchObject({
        statusGatilho: 'BLOQUEADO',
        modoEducativoAtivo: true,
        valorMetaReserva: 12000,
        valorGatilhoRequerido: 6000,
        faltaParaDesbloquear: 6000,
      });
      expect(initialOverview.json().classes).toHaveLength(5);

      // Soma != 100% deve falhar com 400
      const invalidSumRes = await app.inject({
        method: 'PUT',
        url: '/investments/allocations',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          allocations: [
            { classeAtivo: 'RF', percentualIdeal: 50 },
            { classeAtivo: 'FII', percentualIdeal: 20 },
            { classeAtivo: 'ACOES', percentualIdeal: 20 },
            { classeAtivo: 'INT', percentualIdeal: 5 },
            { classeAtivo: 'CRIPTO', percentualIdeal: 0 },
          ],
        },
      });
      expect(invalidSumRes.statusCode).toBe(400);

      // Soma = 100% válida
      const validAllocRes = await app.inject({
        method: 'PUT',
        url: '/investments/allocations',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          allocations: [
            { classeAtivo: 'RF', percentualIdeal: 30 },
            { classeAtivo: 'FII', percentualIdeal: 25 },
            { classeAtivo: 'ACOES', percentualIdeal: 25 },
            { classeAtivo: 'INT', percentualIdeal: 15 },
            { classeAtivo: 'CRIPTO', percentualIdeal: 5 },
          ],
        },
      });
      expect(validAllocRes.statusCode).toBe(200);

      // Bloqueia FII/ACOES enquanto BLOQUEADO (403 INVESTMENT_TRIGGER_LOCKED)
      const blockedRiskRes = await app.inject({
        method: 'POST',
        url: '/investments/assets',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          classeAtivo: 'ACOES',
          tickerOuNome: 'WEGE3',
          quantidade: 10,
          valorInvestido: 400,
          saldoAtualMercado: 400,
        },
      });
      expect(blockedRiskRes.statusCode).toBe(403);
      expect(blockedRiskRes.json().error).toBe('INVESTMENT_TRIGGER_LOCKED');

      // Permite RF conservador mesmo em Modo Educativo
      const allowRfRes = await app.inject({
        method: 'POST',
        url: '/investments/assets',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          classeAtivo: 'RF',
          tickerOuNome: 'Tesouro Selic 2029',
          quantidade: 1,
          valorInvestido: 1000,
          saldoAtualMercado: 1050,
        },
      });
      expect(allowRfRes.statusCode).toBe(201);
      expect(allowRfRes.json().overview.patrimonioCarteira).toBe(1050);

      // Rebalanceamento enquanto BLOQUEADO orienta completar a reserva
      const blockedRebalance = await app.inject({
        method: 'POST',
        url: '/investments/rebalance',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { valorAporte: 2000 },
      });
      expect(blockedRebalance.statusCode).toBe(200);
      expect(blockedRebalance.json()).toMatchObject({
        modo: 'PRIORIZAR_RESERVA',
        valorSugeridoReserva: 2000,
      });

      // Isolamento multi-tenant no ativo de RF
      const assetId = allowRfRes.json().asset.id as string;
      const foreignUpdate = await app.inject({
        method: 'PATCH',
        url: `/investments/assets/${assetId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: { saldoAtualMercado: 9999 },
      });
      expect(foreignUpdate.statusCode).toBe(404);
    });

    it('libera investimentos após atingir gatilho na Reserva, consolida carteira (RF-13), rebalanceia aporte (RF-14) e reativa trava após resgate', async () => {
      // Aporta R$ 6.000 (50% de 12.000) -> statusGatilho passa para LIBERADO
      const depositRes = await app.inject({
        method: 'POST',
        url: '/reserve/deposits',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaPadraoAId,
          valor: 6000,
          descricao: 'Meta do gatilho',
          dataMovimento: '2026-11-20',
        },
      });
      expect(depositRes.statusCode).toBe(201);
      expect(depositRes.json().overview.statusGatilho).toBe('LIBERADO');

      // Agora cadastrar ativo de risco (ACOES e FII) funciona (201)
      const stockRes = await app.inject({
        method: 'POST',
        url: '/investments/assets',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          classeAtivo: 'ACOES',
          tickerOuNome: 'WEGE3',
          quantidade: 20,
          valorInvestido: 800,
          saldoAtualMercado: 950,
        },
      });
      expect(stockRes.statusCode).toBe(201);
      const stockId = stockRes.json().asset.id as string;

      // Novo aporte no ativo existente
      const contribRes = await app.inject({
        method: 'POST',
        url: `/investments/assets/${stockId}/contributions`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          valorAporte: 200,
          quantidadeAdicional: 5,
        },
      });
      expect(contribRes.statusCode).toBe(200);
      expect(contribRes.json().asset).toMatchObject({
        quantidade: 25,
        valorInvestido: 1000,
        saldoAtualMercado: 1150,
      });

      // Consolidação global: Conta (10000 - 6000 = 4000) + Reserva (6000) + Carteira (1050 RF + 1150 ACOES = 2200) = 12200
      const overviewAfterContrib = contribRes.json().overview;
      expect(overviewAfterContrib.patrimonioCarteira).toBe(2200);
      expect(overviewAfterContrib.lucroPrejuizoCarteira).toBe(200);
      expect(overviewAfterContrib.patrimonioTotalGlobal).toBe(12200);

      // Rebalanceamento guiado por aporte (RF-14)
      const rebalanceRes = await app.inject({
        method: 'POST',
        url: '/investments/rebalance',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { valorAporte: 1000 },
      });
      expect(rebalanceRes.statusCode).toBe(200);
      expect(rebalanceRes.json().modo).toBe('REBALANCEAMENTO_CARTEIRA');
      const sumRebalance =
        Math.round(
          (rebalanceRes.json().itens as Array<{ valorSugeridoAporte: number }>).reduce(
            (acc, item) => acc + item.valorSugeridoAporte,
            0,
          ) * 100,
        ) / 100;
      expect(sumRebalance).toBe(1000);

      // Resgate na Reserva derruba saldo para 5000 (< 6000) -> regressão segura do gatilho!
      const withdrawRes = await app.inject({
        method: 'POST',
        url: '/reserve/withdrawals',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaDestinoId: contaPadraoAId,
          valor: 1000,
          justificativaResgate: 'Despesa médica inesperada em família',
          confirmacaoDuasEtapas: true,
          dataMovimento: '2026-11-22',
        },
      });
      expect(withdrawRes.statusCode).toBe(201);
      expect(withdrawRes.json().overview.statusGatilho).toBe('BLOQUEADO');

      // Novo aporte em WEGE3 volta a ser bloqueado (403)
      const blockedContribAfterRegression = await app.inject({
        method: 'POST',
        url: `/investments/assets/${stockId}/contributions`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { valorAporte: 100, quantidadeAdicional: 2 },
      });
      expect(blockedContribAfterRegression.statusCode).toBe(403);
      expect(blockedContribAfterRegression.json().error).toBe('INVESTMENT_TRIGGER_LOCKED');

      // Mas atualizar apenas cotação de mercado (mark-to-market) continua permitido
      const markToMarketRes = await app.inject({
        method: 'PATCH',
        url: `/investments/assets/${stockId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { saldoAtualMercado: 1180 },
      });
      expect(markToMarketRes.statusCode).toBe(200);
      expect(markToMarketRes.json().asset.saldoAtualMercado).toBe(1180);
    });

    it('executa simulador de juros compostos para 1, 5, 10 e 20 anos (RF-15)', async () => {
      const simRes = await app.inject({
        method: 'POST',
        url: '/investments/simulate',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          saldoInicial: 5000,
          aporteMensal: 800,
          taxaAnualRealPct: 8,
          metaPatrimonio: 100000,
        },
      });

      expect(simRes.statusCode).toBe(200);
      const body = simRes.json();
      expect(body.horizons).toHaveLength(4);
      expect(body.horizons.map((h: { anos: number }) => h.anos)).toEqual([1, 5, 10, 20]);
      expect(body.mesesParaMeta).toBeGreaterThan(60);
      expect(body.anosParaMeta).toBeGreaterThan(5);
    });
  },
);
