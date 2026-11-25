import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 7 — Reserva de Emergência e Blindagem (RF-08..RF-11 / RN-03)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let contaCofreAId = '';
    let catSalarioAId = '';
    let catMoradiaAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'Reserve User A',
            email: `reserve-a-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            custoVidaMensal: 2000,
            mesesReservaAlvo: 6,
            pctPaguePrimeiro: 15,
            gatilhoInvestPct: 50,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'Reserve User B',
            email: `reserve-b-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
          },
        }),
      ]);

      expect(regA.statusCode).toBe(201);
      expect(regB.statusCode).toBe(201);

      userAId = regA.json().user.id;
      contaCofreAId = regA.json().user.reserva.contaCofreId;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const [accountsARes, catsARes] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/accounts',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
        app.inject({
          method: 'GET',
          url: '/categories',
          cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        }),
      ]);

      contaPadraoAId = accountsARes
        .json()
        .accounts.find((a: { ehContaPadrao: boolean }) => a.ehContaPadrao).id;

      const catsA = catsARes.json().categories as Array<{ id: string; nome: string }>;
      catSalarioAId = catsA.find((c) => c.nome === 'Salário')!.id;
      catMoradiaAId = catsA.find((c) => c.nome === 'Moradia')!.id;
    });

    afterAll(async () => {
      const ids = [userAId, userBId].filter(Boolean);
      if (ids.length > 0) {
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

    it('calcula sugestão guiada por categorias essenciais (RF-08), sugere split em receitas (RF-09), atualiza termômetro/gatilho (RF-10/12) e bloqueia bypass de Cofre (RF-11)', async () => {
      // Cria recorrência fixa essencial para testar sugestão guiada da calculadora RF-08
      const recRes = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          descricao: 'Aluguel Essencial',
          valorEstimado: 1500,
          diaVencimento: 10,
          categoriaId: catMoradiaAId,
          contaId: contaPadraoAId,
        },
      });
      expect(recRes.statusCode).toBe(201);

      const initialOverview = await app.inject({
        method: 'GET',
        url: '/reserve?date=2026-11-10',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(initialOverview.statusCode).toBe(200);
      expect(initialOverview.json().calculatorSuggestion.fixasEssenciaisAtivas).toBe(1500);
      expect(initialOverview.json().calculatorSuggestion.custoEssencialSugerido).toBe(1500);

      // Ajusta config para custo R$ 1.500 * 4 meses = meta R$ 6.000, pct 15%, gatilho 50% (R$ 3.000)
      const configRes = await app.inject({
        method: 'PATCH',
        url: '/reserve/config',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          custoVidaMensal: 1500,
          mesesReservaAlvo: 4,
          pctPaguePrimeiro: 15,
          gatilhoInvestPct: 50,
        },
      });
      expect(configRes.statusCode).toBe(200);
      expect(configRes.json().valorMetaCalculado).toBe(6000);
      expect(configRes.json().statusGatilho).toBe('BLOQUEADO');

      // Receita de R$ 4.000 deve retornar split sugerido de 15% = R$ 600 (RF-09)
      const incomeRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'REC',
          valor: 4000,
          descricao: 'Salário Base',
          contaId: contaPadraoAId,
          categoriaId: catSalarioAId,
          dataCompetencia: '2026-11-05',
          status: 'PAGO',
        },
      });
      expect(incomeRes.statusCode).toBe(201);
      expect(incomeRes.json().reserveSplitSuggestion).toMatchObject({
        pctPaguePrimeiro: 15,
        valorReceita: 4000,
        valorSugerido: 600,
        contaOrigemId: contaPadraoAId,
        metaConcluida: false,
      });

      // RN-03: prioridade no topo com R$ 600 pendentes no mês
      const beforeDepositOverview = await app.inject({
        method: 'GET',
        url: '/reserve?date=2026-11-10',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(beforeDepositOverview.json().monthlyPriority).toMatchObject({
        abaixoDaMeta: true,
        prioridadeTopoAtiva: true,
        acaoPendenteMes: true,
        metaAporteMes: 600,
        valorPendenteMes: 600,
      });

      // Bloqueia lançamento direto de receita/despesa no Cofre
      const directVaultTx = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 100,
          descricao: 'Tentativa direta cofre',
          contaId: contaCofreAId,
        },
      });
      expect(directVaultTx.statusCode).toBe(400);
      expect(directVaultTx.json().error).toBe('VAULT_DIRECT_TRANSACTION_BLOCKED');

      // Executa aporte de R$ 3.000 (atinge 50% de R$ 6.000 -> libera gatilho RF-12!)
      const depositRes = await app.inject({
        method: 'POST',
        url: '/reserve/deposits',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaPadraoAId,
          valor: 3000,
          descricao: 'Aporte inicial reserva',
          dataMovimento: '2026-11-10',
        },
      });
      expect(depositRes.statusCode).toBe(201);
      const depositBody = depositRes.json();
      expect(depositBody.movement.tipo).toBe('APORTE');
      expect(depositBody.overview.saldoAcumulado).toBe(3000);
      expect(depositBody.overview.statusGatilho).toBe('LIBERADO');
      expect(depositBody.overview.thermometer.percentualConcluido).toBe(50);
      expect(depositBody.overview.thermometer.mesesSegurancaCobertos).toBe(2);
      expect(depositBody.overview.monthlyPriority.acaoPendenteMes).toBe(false);

      // Saldo da conta principal: 4000 - 3000 = 1000; Cofre = 3000
      const [contaPadraoDb, contaCofreDb] = await Promise.all([
        prisma.conta.findUniqueOrThrow({ where: { id: contaPadraoAId } }),
        prisma.conta.findUniqueOrThrow({ where: { id: contaCofreAId } }),
      ]);
      expect(Number(contaPadraoDb.saldoAtual)).toBe(1000);
      expect(Number(contaCofreDb.saldoAtual)).toBe(3000);

      // Bloqueia exclusão avulsa da TRANSF vinculada ao movimento da reserva
      const deleteAuditTransfer = await app.inject({
        method: 'DELETE',
        url: `/transactions/${depositBody.movement.transacaoOrigemId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleteAuditTransfer.statusCode).toBe(400);
      expect(deleteAuditTransfer.json().error).toBe('RESERVE_MOVEMENT_DELETE_BLOCKED');

      // RN-02: Safe-to-Spend não trata aporte de R$ 3.000 como gasto variável (apenas conta como reserva comprometida)
      const safeRes = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-11',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(safeRes.statusCode).toBe(200);
      expect(safeRes.json().breakdown.gastosVariaveisRealizados).toBe(0);
      expect(safeRes.json().breakdown.aportesLiquidosReservaMes).toBe(3000);

      // RF-11 Anti-bypass: transferência genérica saindo do Cofre é bloqueada com 403
      const bypassTransfer = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaCofreAId,
          contaDestinoId: contaPadraoAId,
          valor: 500,
        },
      });
      expect(bypassTransfer.statusCode).toBe(403);
      expect(bypassTransfer.json().error).toBe('VAULT_WITHDRAWAL_LOCKED');

      // RF-11: rejeita resgate sem confirmação em 2 etapas ou justificativa < 15 chars
      const shortJustification = await app.inject({
        method: 'POST',
        url: '/reserve/withdrawals',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaDestinoId: contaPadraoAId,
          valor: 500,
          justificativaResgate: 'curta demais',
          confirmacaoDuasEtapas: true,
        },
      });
      expect(shortJustification.statusCode).toBe(400);

      const noTwoStep = await app.inject({
        method: 'POST',
        url: '/reserve/withdrawals',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaDestinoId: contaPadraoAId,
          valor: 500,
          justificativaResgate: 'Despesa médica emergencial inesperada',
          confirmacaoDuasEtapas: false,
        },
      });
      expect(noTwoStep.statusCode).toBe(400);

      // Resgate válido com justificativa >= 15 chars + 2 etapas reduz saldo e reverte gatilho para BLOQUEADO
      const withdrawalRes = await app.inject({
        method: 'POST',
        url: '/reserve/withdrawals',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaDestinoId: contaPadraoAId,
          valor: 500,
          justificativaResgate: 'Manutenção emergencial do veículo para trabalho',
          confirmacaoDuasEtapas: true,
          dataMovimento: '2026-11-12',
        },
      });
      expect(withdrawalRes.statusCode).toBe(201);
      const withdrawalBody = withdrawalRes.json();
      expect(withdrawalBody.movement.tipo).toBe('RESGATE');
      expect(withdrawalBody.impact.perdeuGatilhoInvestimentos).toBe(true);
      expect(withdrawalBody.overview.saldoAcumulado).toBe(2500);
      expect(withdrawalBody.overview.statusGatilho).toBe('BLOQUEADO');

      // Multi-tenant: User B não acessa nem movimenta contas de User A
      const crossDeposit = await app.inject({
        method: 'POST',
        url: '/reserve/deposits',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          contaOrigemId: contaPadraoAId,
          valor: 100,
        },
      });
      expect(crossDeposit.statusCode).toBe(404);
    });
  },
);
