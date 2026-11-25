import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 4 — Contas Fixas e Recorrências (RF-05)',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let contasFixasCatId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const regA = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'RF05 User A',
          email: `rf05-a-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regA.statusCode).toBe(201);
      userAId = regA.json().user.id;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const regB = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'RF05 User B',
          email: `rf05-b-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regB.statusCode).toBe(201);
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const [accountsRes, catsRes] = await Promise.all([
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

      contaPadraoAId = accountsRes
        .json()
        .accounts.find((a: { ehContaPadrao: boolean }) => a.ehContaPadrao).id;
      contasFixasCatId = catsRes
        .json()
        .categories.find((c: { nome: string }) => c.nome === 'Contas Fixas').id;

      await prisma.conta.update({
        where: { id: contaPadraoAId },
        data: { saldoAtual: '1000.00' },
      });
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

    it('cria recorrência, gera mensalmente com idempotência e clamping de fevereiro, liquida com ajuste de valor, pausa e exclui preservando histórico', async () => {
      const invalidDay = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          descricao: 'Dia Inválido',
          valorEstimado: 100,
          diaVencimento: 32,
          categoriaId: contasFixasCatId,
        },
      });
      expect(invalidDay.statusCode).toBe(400);

      const crossCreate = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          descricao: 'Invasão',
          valorEstimado: 100,
          diaVencimento: 10,
          categoriaId: contasFixasCatId,
        },
      });
      expect(crossCreate.statusCode).toBe(404);

      const created = await app.inject({
        method: 'POST',
        url: '/recurrences',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          descricao: 'Energia Elétrica',
          valorEstimado: 180,
          diaVencimento: 31,
          categoriaId: contasFixasCatId,
        },
      });
      expect(created.statusCode).toBe(201);
      const recId = created.json().recurrence.id;
      expect(created.json().recurrence.contaId).toBe(contaPadraoAId);

      const checklistFeb1 = await app.inject({
        method: 'GET',
        url: '/recurrences/checklist?month=2026-02',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(checklistFeb1.statusCode).toBe(200);
      const body1 = checklistFeb1.json();
      expect(body1.items).toHaveLength(1);
      expect(body1.items[0].dataCompetencia).toBe('2026-02-28');
      expect(body1.items[0].status).toBe('PENDENTE');
      expect(body1.summary.totalPendenteDespesas).toBe(180);

      let contaDb = await prisma.conta.findUnique({ where: { id: contaPadraoAId } });
      expect(Number(contaDb?.saldoAtual)).toBe(1000);

      const genAgain = await app.inject({
        method: 'POST',
        url: '/recurrences/generate',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { month: '2026-02' },
      });
      expect(genAgain.statusCode).toBe(200);
      expect(genAgain.json().generatedCount).toBe(0);
      expect(genAgain.json().existingCount).toBe(1);

      const checklistFeb2 = await app.inject({
        method: 'GET',
        url: '/recurrences/checklist?month=2026-02',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(checklistFeb2.json().items).toHaveLength(1);

      const txId = body1.items[0].id;
      const payRes = await app.inject({
        method: 'PATCH',
        url: `/transactions/${txId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          status: 'PAGO',
          valor: 195.5,
        },
      });
      expect(payRes.statusCode).toBe(200);

      contaDb = await prisma.conta.findUnique({ where: { id: contaPadraoAId } });
      expect(Number(contaDb?.saldoAtual)).toBe(804.5);

      const checklistAfterPay = await app.inject({
        method: 'GET',
        url: '/recurrences/checklist?month=2026-02',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(checklistAfterPay.json().summary.countPagas).toBe(1);
      expect(checklistAfterPay.json().summary.totalPagoDespesas).toBe(195.5);

      const pauseRes = await app.inject({
        method: 'PATCH',
        url: `/recurrences/${recId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { ativa: false },
      });
      expect(pauseRes.statusCode).toBe(200);
      expect(pauseRes.json().recurrence.ativa).toBe(false);

      const checklistMar = await app.inject({
        method: 'GET',
        url: '/recurrences/checklist?month=2026-03',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(checklistMar.statusCode).toBe(200);
      expect(checklistMar.json().items).toHaveLength(0);

      const crossDelete = await app.inject({
        method: 'DELETE',
        url: `/recurrences/${recId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(crossDelete.statusCode).toBe(404);

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/recurrences/${recId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(delRes.statusCode).toBe(204);

      const historicalTx = await prisma.transacao.findUnique({ where: { id: txId } });
      expect(historicalTx).not.toBeNull();
      expect(historicalTx?.recorrenciaId).toBeNull();
    });
  },
);
