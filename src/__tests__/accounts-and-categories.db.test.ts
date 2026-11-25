import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../infra/database/prisma.js';
import { ACCESS_COOKIE_NAME } from '../shared/middlewares/authenticate.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 1 — Contas, Transferência Neutra (RN-02) e Categorias',
  () => {
    let app: FastifyInstance;
    let userAId = '';
    let userAToken = '';
    let userBId = '';
    let userBToken = '';
    let contaPrincipalAId = '';
    let contaCofreAId = '';

    beforeAll(async () => {
      app = await buildApp({ logger: false });

      const regA = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'Usuário A',
          email: `user-a-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regA.statusCode).toBe(201);
      userAId = regA.json().user.id;
      contaCofreAId = regA.json().user.reserva.contaCofreId;
      userAToken = regA.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const regB = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          nome: 'Usuário B',
          email: `user-b-${randomUUID()}@antiliso.local`,
          senha: 'SenhaForte@2026',
        },
      });
      expect(regB.statusCode).toBe(201);
      userBId = regB.json().user.id;
      userBToken = regB.cookies.find((c) => c.name === ACCESS_COOKIE_NAME)!.value;

      const contasA = await app.inject({
        method: 'GET',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      const principal = contasA
        .json()
        .accounts.find((a: { ehContaPadrao: boolean }) => a.ehContaPadrao);
      contaPrincipalAId = principal.id;
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

    it('gerencia contas, troca conta padrão atomicamente e impede desativar padrão ou cofre', async () => {
      const createCarteira = await app.inject({
        method: 'POST',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Carteira Pix',
          tipo: 'CARTEIRA',
          saldoAtual: 500,
          ehContaPadrao: true,
        },
      });
      expect(createCarteira.statusCode).toBe(201);
      const carteiraId = createCarteira.json().account.id;
      expect(createCarteira.json().account.ehContaPadrao).toBe(true);

      const defaultAccountsDb = await prisma.conta.findMany({
        where: { usuarioId: userAId, ehContaPadrao: true },
      });
      expect(defaultAccountsDb).toHaveLength(1);
      expect(defaultAccountsDb[0]?.id).toBe(carteiraId);

      const disableDefault = await app.inject({
        method: 'PATCH',
        url: `/accounts/${carteiraId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { ativa: false },
      });
      expect(disableDefault.statusCode).toBe(400);

      const disableVault = await app.inject({
        method: 'PATCH',
        url: `/accounts/${contaCofreAId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { ativa: false },
      });
      expect(disableVault.statusCode).toBe(400);

      const restoreDefault = await app.inject({
        method: 'PATCH',
        url: `/accounts/${contaPrincipalAId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { ehContaPadrao: true },
      });
      expect(restoreDefault.statusCode).toBe(200);
      expect(restoreDefault.json().account.ehContaPadrao).toBe(true);

      const crossUserPatch = await app.inject({
        method: 'PATCH',
        url: `/accounts/${contaPrincipalAId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: { nome: 'Invadida' },
      });
      expect(crossUserPatch.statusCode).toBe(404);
    });

    it('executa transferência neutra (RN-02) atualizando saldos em ACID e isola entre usuários', async () => {
      const accountsRes = await app.inject({
        method: 'GET',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      const carteira = accountsRes
        .json()
        .accounts.find((a: { nome: string }) => a.nome === 'Carteira Pix');

      const transferRes = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: carteira.id,
          contaDestinoId: contaPrincipalAId,
          valor: 150.5,
          descricao: 'Aporte para conta principal',
          dataCompetencia: '2026-11-22',
        },
      });
      expect(transferRes.statusCode).toBe(201);
      const body = transferRes.json();
      expect(body.transfer.tipo).toBe('TRANSF');
      expect(body.contaOrigem.saldoAtual).toBe(349.5);
      expect(body.contaDestino.saldoAtual).toBe(150.5);

      const transacoesDb = await prisma.transacao.findMany({
        where: { usuarioId: userAId },
      });
      expect(transacoesDb).toHaveLength(1);
      expect(transacoesDb[0]?.tipo).toBe('TRANSF');
      expect(transacoesDb[0]?.contaId).toBe(carteira.id);
      expect(transacoesDb[0]?.contaDestinoId).toBe(contaPrincipalAId);
      expect(transacoesDb[0]?.cartaoId).toBeNull();
      expect(transacoesDb[0]?.categoriaId).toBeNull();

      const sameAccountRes = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: contaPrincipalAId,
          contaDestinoId: contaPrincipalAId,
          valor: 50,
        },
      });
      expect(sameAccountRes.statusCode).toBe(400);

      const zeroValueRes = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          contaOrigemId: carteira.id,
          contaDestinoId: contaPrincipalAId,
          valor: 0,
        },
      });
      expect(zeroValueRes.statusCode).toBe(400);

      const accountsBRes = await app.inject({
        method: 'GET',
        url: '/accounts',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      const contaBId = accountsBRes.json().accounts[0].id;

      const crossTransfer = await app.inject({
        method: 'POST',
        url: '/accounts/transfers',
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: {
          contaOrigemId: contaBId,
          contaDestinoId: contaPrincipalAId,
          valor: 10,
        },
      });
      expect(crossTransfer.statusCode).toBe(404);
    });

    it('executa CRUD completo de categorias com filtros, unicidade e isolamento multi-tenant', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/categories',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Educação',
          tipo: 'DESPESA',
          ehEssencial: true,
          orcamentoMensal: 600,
        },
      });
      expect(created.statusCode).toBe(201);
      const categoryId = created.json().category.id;

      const duplicate = await app.inject({
        method: 'POST',
        url: '/categories',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: {
          nome: 'Educação',
          tipo: 'DESPESA',
        },
      });
      expect(duplicate.statusCode).toBe(409);

      const filtered = await app.inject({
        method: 'GET',
        url: '/categories?tipo=DESPESA&ehEssencial=true',
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(filtered.statusCode).toBe(200);
      const list = filtered.json().categories as Array<{
        id: string;
        tipo: string;
        ehEssencial: boolean;
      }>;
      expect(list.some((c) => c.id === categoryId)).toBe(true);
      expect(list.every((c) => c.tipo === 'DESPESA' && c.ehEssencial)).toBe(true);

      const crossPatch = await app.inject({
        method: 'PATCH',
        url: `/categories/${categoryId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
        payload: { nome: 'Hack' },
      });
      expect(crossPatch.statusCode).toBe(404);

      const updated = await app.inject({
        method: 'PATCH',
        url: `/categories/${categoryId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
        payload: { orcamentoMensal: 750 },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().category.orcamentoMensal).toBe(750);

      const crossDelete = await app.inject({
        method: 'DELETE',
        url: `/categories/${categoryId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userBToken },
      });
      expect(crossDelete.statusCode).toBe(404);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/categories/${categoryId}`,
        cookies: { [ACCESS_COOKIE_NAME]: userAToken },
      });
      expect(deleted.statusCode).toBe(204);
    });
  },
);
