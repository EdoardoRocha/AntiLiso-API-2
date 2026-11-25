import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 2 — Transações, Quick-Add (RF-01), Idempotência Offline (RNF-02) e Estorno ACID',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPadraoAId = '';
    let contaSecundariaAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const regA = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'QuickAdd User A',
          email: `tx-a-${randomUUID()}@antiliso.local`,
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
          nome: 'QuickAdd User B',
          email: `tx-b-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regB.statusCode).toBe(201);
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const accountsRes = await app.inject({
        method: 'GET',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      const padrao = accountsRes
        .json()
        .accounts.find((a: { ehContaPadrao: boolean }) => a.ehContaPadrao);
      contaPadraoAId = padrao.id;

      const secRes = await app.inject({
        method: 'POST',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Carteira Reserva Dia',
          tipo: 'CARTEIRA',
          saldoAtual: 300,
          ehContaPadrao: false,
        },
      });
      expect(secRes.statusCode).toBe(201);
      contaSecundariaAId = secRes.json().account.id;
    });

    afterAll(async () => {
      const ids = [userAId, userBId].filter(Boolean);
      if (ids.length > 0) {
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

    it('registra Quick-Add em texto natural na conta padrão e data atual e atualiza saldo ACID', async () => {
      const todayIso = new Date().toISOString().slice(0, 10);

      const recRes = await app.inject({
        method: 'POST',
        url: '/transactions/quick-add',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { texto: 'R$ 1.000,00 Salário' },
      });
      expect(recRes.statusCode).toBe(201);
      expect(recRes.json().transaction.tipo).toBe('REC');
      expect(recRes.json().transaction.valor).toBe(1000);
      expect(recRes.json().transaction.contaId).toBe(contaPadraoAId);
      expect(recRes.json().transaction.dataCompetencia).toBe(todayIso);
      expect(recRes.json().transaction.categoriaNome).toBe('Salário');

      const despRes = await app.inject({
        method: 'POST',
        url: '/transactions/quick-add',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { texto: 'Almoço 35 pix' },
      });
      expect(despRes.statusCode).toBe(201);
      expect(despRes.json().transaction.tipo).toBe('DESP');
      expect(despRes.json().transaction.valor).toBe(35);
      expect(despRes.json().transaction.descricao).toBe('Almoço');

      const contaDb = await prisma.conta.findUnique({ where: { id: contaPadraoAId } });
      expect(Number(contaDb?.saldoAtual)).toBe(965);
    });

    it('mantém PENDENTE sem afetar saldo até virar PAGO e garante idempotência offline via clientRequestId', async () => {
      const pendingRes = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 100,
          descricao: 'Conta de Luz',
          status: 'PENDENTE',
        },
      });
      expect(pendingRes.statusCode).toBe(201);
      const pendingId = pendingRes.json().transaction.id;

      let contaDb = await prisma.conta.findUnique({ where: { id: contaPadraoAId } });
      expect(Number(contaDb?.saldoAtual)).toBe(965);

      const clientRequestId = randomUUID();
      const firstSync = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 50,
          descricao: 'Farmácia Offline',
          status: 'PAGO',
          clientRequestId,
        },
      });
      expect(firstSync.statusCode).toBe(201);
      expect(firstSync.json().idempotent).toBe(false);

      const secondSync = await app.inject({
        method: 'POST',
        url: '/transactions',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          tipo: 'DESP',
          valor: 50,
          descricao: 'Farmácia Offline',
          status: 'PAGO',
          clientRequestId,
        },
      });
      expect(secondSync.statusCode).toBe(200);
      expect(secondSync.json().idempotent).toBe(true);
      expect(secondSync.json().transaction.id).toBe(firstSync.json().transaction.id);

      contaDb = await prisma.conta.findUnique({ where: { id: contaPadraoAId } });
      expect(Number(contaDb?.saldoAtual)).toBe(915);

      const payRes = await app.inject({
        method: 'PATCH',
        url: `/transactions/${pendingId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          status: 'PAGO',
          valor: 120,
          contaId: contaSecundariaAId,
        },
      });
      expect(payRes.statusCode).toBe(200);
      expect(payRes.json().transaction.valor).toBe(120);
      expect(payRes.json().transaction.contaId).toBe(contaSecundariaAId);

      const secDb = await prisma.conta.findUnique({ where: { id: contaSecundariaAId } });
      expect(Number(secDb?.saldoAtual)).toBe(180);

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/transactions/${pendingId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(delRes.statusCode).toBe(204);

      const secAfterDelete = await prisma.conta.findUnique({ where: { id: contaSecundariaAId } });
      expect(Number(secAfterDelete?.saldoAtual)).toBe(300);
    });

    it('mantém TRANSF neutro no summary mensal, estorna TRANSF ao excluir e isola usuários', async () => {
      const transfRes = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaPadraoAId,
          contaDestinoId: contaSecundariaAId,
          valor: 200,
          descricao: 'Reserva para carteira',
        },
      });
      expect(transfRes.statusCode).toBe(201);
      const transferId = transfRes.json().transfer.id;

      const currentMonth = new Date().toISOString().slice(0, 7);
      const listRes = await app.inject({
        method: 'GET',
        url: `/transactions?month=${currentMonth}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(listRes.statusCode).toBe(200);
      const summary = listRes.json().summary;
      expect(summary.totalReceitas).toBe(1000);
      expect(summary.totalDespesas).toBe(85);
      expect(summary.saldoPeriodo).toBe(915);

      const editTransf = await app.inject({
        method: 'PATCH',
        url: `/transactions/${transferId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { valor: 250 },
      });
      expect(editTransf.statusCode).toBe(400);

      const crossUserDelete = await app.inject({
        method: 'DELETE',
        url: `/transactions/${transferId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(crossUserDelete.statusCode).toBe(404);

      const deleteTransf = await app.inject({
        method: 'DELETE',
        url: `/transactions/${transferId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleteTransf.statusCode).toBe(204);

      const [padraoAfter, secAfter] = await Promise.all([
        prisma.conta.findUnique({ where: { id: contaPadraoAId } }),
        prisma.conta.findUnique({ where: { id: contaSecundariaAId } }),
      ]);
      expect(Number(padraoAfter?.saldoAtual)).toBe(915);
      expect(Number(secAfter?.saldoAtual)).toBe(300);
    });
  },
);
