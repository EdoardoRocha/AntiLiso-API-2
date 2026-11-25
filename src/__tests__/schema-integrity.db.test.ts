import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../infra/database/prisma.js';

describe.runIf(process.env.RUN_DB_TESTS === 'true')(
  'Etapa 0 — Constraints reais no PostgreSQL',
  () => {
    let usuarioId = '';
    let contaCorrenteId = '';
    let contaCofreId = '';
    let cartaoId = '';
    let reservaId = '';

    beforeAll(async () => {
      const usuario = await prisma.usuario.create({
        data: {
          nome: 'Teste Integridade',
          email: `teste-der-${Date.now()}@antiliso.local`,
          senhaHash: 'hash-teste-etapa-0',
        },
      });
      usuarioId = usuario.id;

      const contaCorrente = await prisma.conta.create({
        data: {
          usuarioId,
          nome: 'Conta Teste',
          tipo: 'CORRENTE',
          ehContaPadrao: true,
        },
      });
      contaCorrenteId = contaCorrente.id;

      const contaCofre = await prisma.conta.create({
        data: {
          usuarioId,
          nome: 'Cofre Teste',
          tipo: 'COFRE',
        },
      });
      contaCofreId = contaCofre.id;

      const cartao = await prisma.cartaoCredito.create({
        data: {
          usuarioId,
          contaPagamentoId: contaCorrenteId,
          nome: 'Cartao Teste',
          limiteTotal: '5000.00',
          tetoMensalAlerta: '2000.00',
          diaFechamento: 5,
          diaVencimento: 12,
        },
      });
      cartaoId = cartao.id;

      const reserva = await prisma.reservaEmergencia.create({
        data: {
          usuarioId,
          contaCofreId,
        },
      });
      reservaId = reserva.id;
    });

    afterAll(async () => {
      if (usuarioId) {
        await prisma.movimentoReserva.deleteMany({ where: { reservaId } });
        await prisma.transacao.deleteMany({ where: { usuarioId } });
        await prisma.cartaoCredito.deleteMany({ where: { usuarioId } });
        await prisma.reservaEmergencia.deleteMany({ where: { usuarioId } });
        await prisma.conta.deleteMany({ where: { usuarioId } });
        await prisma.usuario.delete({ where: { id: usuarioId } });
      }
      await prisma.$disconnect();
    });

    it('rejeita RESGATE sem justificativa ou com justificativa < 15 caracteres e aceita justificativa válida', async () => {
      await expect(
        prisma.movimentoReserva.create({
          data: {
            reservaId,
            tipo: 'RESGATE',
            valor: '100.00',
            justificativaResgate: null,
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.movimentoReserva.create({
          data: {
            reservaId,
            tipo: 'RESGATE',
            valor: '100.00',
            justificativaResgate: 'curta demais',
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.movimentoReserva.create({
          data: {
            reservaId,
            tipo: 'RESGATE',
            valor: '100.00',
            justificativaResgate: '   curta   ',
          },
        }),
      ).rejects.toThrow();

      const valido = await prisma.movimentoReserva.create({
        data: {
          reservaId,
          tipo: 'RESGATE',
          valor: '100.00',
          justificativaResgate: 'Despesa médica emergencial comprovada',
        },
      });
      expect(valido.id).toBeTruthy();
    });

    it('rejeita transação com conta_id e cartao_id preenchidos ou ambos nulos', async () => {
      await expect(
        prisma.transacao.create({
          data: {
            usuarioId,
            contaId: contaCorrenteId,
            cartaoId,
            tipo: 'DESP',
            valor: '50.00',
            descricao: 'Ambos preenchidos',
            dataCompetencia: new Date('2026-11-22'),
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.transacao.create({
          data: {
            usuarioId,
            contaId: null,
            cartaoId: null,
            tipo: 'DESP',
            valor: '50.00',
            descricao: 'Ambos nulos',
            dataCompetencia: new Date('2026-11-22'),
          },
        }),
      ).rejects.toThrow();
    });

    it('garante relação 1:1 de RESERVA_EMERGENCIA por usuario_id', async () => {
      await expect(
        prisma.reservaEmergencia.create({
          data: {
            usuarioId,
            contaCofreId,
          },
        }),
      ).rejects.toThrow();
    });
  },
);
