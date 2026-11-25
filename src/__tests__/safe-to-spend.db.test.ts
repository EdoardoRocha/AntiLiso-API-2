import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 5 — Safe-to-Spend (RF-04 / RN-01 / RN-02 / RN-04)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let receitaSalarioCatAId = '';
    let despesaMoradiaCatAId = '';
    let despesaAlimentacaoCatAId = '';
    let receitaSalarioCatBId = '';
    let despesaOutrosCatBId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const [regA, regB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF04 User A',
            email: `rf04-a-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            pctPaguePrimeiro: 15,
          },
        }),
        app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: {
            nome: 'RF04 User B',
            email: `rf04-b-${randomUUID()}@antiliso.local`,
            senha: 'SenhaForte@2026',
            pctPaguePrimeiro: 10,
          },
        }),
      ]);

      expect(regA.statusCode).toBe(201);
      expect(regB.statusCode).toBe(201);

      userAId = regA.json().user.id;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const [accountsARes, catsARes, catsBRes] = await Promise.all([
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
        app.inject({
          method: 'GET',
          url: '/categories',
          cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        }),
      ]);

      contaPadraoAId = accountsARes
        .json()
        .accounts.find((a: { ehContaPadrao: boolean }) => a.ehContaPadrao).id;

      const catsA = catsARes.json().categories as Array<{ id: string; nome: string }>;
      receitaSalarioCatAId = catsA.find((c) => c.nome === 'Salário')!.id;
      despesaMoradiaCatAId = catsA.find((c) => c.nome === 'Moradia')!.id;
      despesaAlimentacaoCatAId = catsA.find((c) => c.nome === 'Alimentação')!.id;

      const catsB = catsBRes.json().categories as Array<{ id: string; nome: string }>;
      receitaSalarioCatBId = catsB.find((c) => c.nome === 'Salário')!.id;
      despesaOutrosCatBId = catsB.find((c) => c.nome === 'Outros')!.id;
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

    it('rejeita requisição não autenticada com 401 e data calendário inválida com 400', async () => {
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-11',
      });
      expect(unauthRes.statusCode).toBe(401);

      const invalidDateRes = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-02-31',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(invalidDateRes.statusCode).toBe(400);
      expect(invalidDateRes.json().error).toBe('INVALID_REFERENCE_DATE');
    });

    it('materializa recorrência na 1ª consulta, mantém neutralidade de TRANSF (RN-02) e reconhece aportes extras na reserva', async () => {
      const carteiraRes = await app.inject({
        method: 'POST',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Carteira Dia a Dia',
          tipo: 'CARTEIRA',
          saldoAtual: 0,
        },
      });
      expect(carteiraRes.statusCode).toBe(201);
      const carteiraId = carteiraRes.json().account.id;

      const recRes = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          descricao: 'Aluguel Apartamento',
          valorEstimado: 1200,
          diaVencimento: 10,
          categoriaId: despesaMoradiaCatAId,
          contaId: contaPadraoAId,
          ativa: true,
        },
      });
      expect(recRes.statusCode).toBe(201);
      const recorrenciaId = recRes.json().recurrence.id;

      const incomeRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'REC',
          valor: 4000,
          descricao: 'Salário Mensal',
          contaId: contaPadraoAId,
          categoriaId: receitaSalarioCatAId,
          dataCompetencia: '2026-11-05',
          status: 'PAGO',
        },
      });
      expect(incomeRes.statusCode).toBe(201);

      const varExpenseRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 400,
          descricao: 'Supermercado Semana',
          contaId: contaPadraoAId,
          categoriaId: despesaAlimentacaoCatAId,
          dataCompetencia: '2026-11-10',
          status: 'PAGO',
        },
      });
      expect(varExpenseRes.statusCode).toBe(201);

      const beforeTransfer = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21', // 30 - 21 + 1 = 10 dias restantes
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(beforeTransfer.statusCode).toBe(200);
      const body1 = beforeTransfer.json();

      // Receitas = 4000; Fixas (auto-gerada) = 1200; Meta Reserva (15%) = 600; Variáveis = 400
      // Livre = 4000 - 1200 - 600 - 400 = 1800; / 10 dias = 180
      expect(body1.status).toBe('SAUDAVEL');
      expect(body1.diasRestantes).toBe(10);
      expect(body1.breakdown.contasFixasPendentes).toBe(1200);
      expect(body1.breakdown.metaReservaPlanejada).toBe(600);
      expect(body1.breakdown.reservaComprometidaMes).toBe(600);
      expect(body1.breakdown.gastosVariaveisRealizados).toBe(400);
      expect(body1.saldoLivreMes).toBe(1800);
      expect(body1.quantoPossoGastarHoje).toBe(180);

      // RN-02: transferência entre contas não afeta despesas nem receitas
      const transferRes = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaPadraoAId,
          contaDestinoId: carteiraId,
          valor: 500,
          descricao: 'Saque para carteira',
          dataCompetencia: '2026-11-21',
        },
      });
      expect(transferRes.statusCode).toBe(201);

      const afterTransfer = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(afterTransfer.statusCode).toBe(200);
      expect(afterTransfer.json()).toEqual(body1);

      // Idempotência da materialização da recorrência
      const generatedCount = await prisma.transacao.count({
        where: {
          usuarioId: userAId,
          recorrenciaId,
          dataCompetencia: {
            gte: new Date('2026-11-01T00:00:00.000Z'),
            lt: new Date('2026-12-01T00:00:00.000Z'),
          },
        },
      });
      expect(generatedCount).toBe(1);

      // MovimentoReserva extra (APORTE R$ 900 > meta planejada R$ 600)
      const reserva = await prisma.reservaEmergencia.findUniqueOrThrow({
        where: { usuarioId: userAId },
      });
      await prisma.movimentoReserva.create({
        data: {
          reservaId: reserva.id,
          tipo: 'APORTE',
          valor: '900.00',
          dataMovimento: new Date('2026-11-15T12:00:00.000Z'),
        },
      });

      const afterReserve = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(afterReserve.statusCode).toBe(200);
      const body2 = afterReserve.json();
      expect(body2.breakdown.aportesLiquidosReservaMes).toBe(900);
      expect(body2.breakdown.reservaComprometidaMes).toBe(900);
      expect(body2.saldoLivreMes).toBe(1500); // 4000 - 1200 - 900 - 400
      expect(body2.quantoPossoGastarHoje).toBe(150);
    });

    it('zera indicador em estouro e recalcula sem culpa na virada de ciclo 2026-11 -> 2026-12 (RN-04)', async () => {
      await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          tipo: 'REC',
          valor: 1000,
          descricao: 'Freela Novembro',
          categoriaId: receitaSalarioCatBId,
          dataCompetencia: '2026-11-05',
          status: 'PAGO',
        },
      });

      await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          tipo: 'DESP',
          valor: 1200,
          descricao: 'Estouro Novembro',
          categoriaId: despesaOutrosCatBId,
          dataCompetencia: '2026-11-18',
          status: 'PAGO',
        },
      });

      const novRes = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-11-21', // 10 dias restantes
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(novRes.statusCode).toBe(200);
      const novBody = novRes.json();

      // Receita 1000 - Reserva 100 (10%) - Variaveis 1200 = -300 -> ESGOTADO
      expect(novBody.status).toBe('ESGOTADO');
      expect(novBody.saldoLivreMes).toBe(-300);
      expect(novBody.saldoDiarioReal).toBe(-30);
      expect(novBody.quantoPossoGastarHoje).toBe(0);

      // Ciclo seguinte (2026-12) deve ignorar o saldo negativo de novembro
      await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          tipo: 'REC',
          valor: 3100,
          descricao: 'Receita Dezembro',
          categoriaId: receitaSalarioCatBId,
          dataCompetencia: '2026-12-01',
          status: 'PAGO',
        },
      });

      const decRes = await app.inject({
        method: 'GET',
        url: '/safe-to-spend?date=2026-12-01', // 31 dias restantes
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(decRes.statusCode).toBe(200);
      const decBody = decRes.json();

      // 3100 - 310 (10% reserva) - 0 = 2790 / 31 = 90
      expect(decBody.status).toBe('SAUDAVEL');
      expect(decBody.diasRestantes).toBe(31);
      expect(decBody.saldoLivreMes).toBe(2790);
      expect(decBody.quantoPossoGastarHoje).toBe(90);
    });
  },
);
