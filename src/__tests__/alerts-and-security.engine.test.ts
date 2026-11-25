import { describe, expect, it } from 'vitest';
import {
  buildWeeklyDigest,
  clampAlertMessage,
  computeIsoWeekId,
  evaluateBudgetCandidates,
  evaluateDueSoonCandidates,
} from '../modules/alerts/alerts.engine.js';
import {
  buildOtpAuthUri,
  deriveUserTotpSecret,
  generateTotpCode,
  verifyTotpCode,
} from '../shared/security/totp.js';

describe('alerts.engine & totp — RF-07 e RNF-03', () => {
  it('trunca mensagens em até 255 caracteres e calcula semana ISO', () => {
    const longMsg = 'A'.repeat(300);
    const clamped = clampAlertMessage(longMsg);
    expect(clamped.length).toBe(255);
    expect(clamped.endsWith('...')).toBe(true);
    expect(computeIsoWeekId('2026-11-20')).toBe('2026-W47');
  });

  it('gera alertas VENC exclusivamente para a janela de 48h (0, 1 e 2 dias)', () => {
    const candidates = evaluateDueSoonCandidates('2026-11-20', [
      {
        id: '11111111-0000',
        kind: 'CONTA_FIXA_OU_DESP',
        descricao: 'Luz',
        valor: 180,
        dueDateIso: '2026-11-20',
      },
      {
        id: '22222222-0000',
        kind: 'FATURA_CARTAO',
        descricao: 'Nubank',
        valor: 950,
        dueDateIso: '2026-11-22',
      },
      {
        id: '33333333-0000',
        kind: 'CONTA_FIXA_OU_DESP',
        descricao: 'Fora 72h',
        valor: 100,
        dueDateIso: '2026-11-23',
      },
      {
        id: '44444444-0000',
        kind: 'CONTA_FIXA_OU_DESP',
        descricao: 'Passada',
        valor: 100,
        dueDateIso: '2026-11-19',
      },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.mensagem).toContain('vence hoje');
    expect(candidates[1]!.mensagem).toContain('vence em 48h');
    expect(candidates.every((c) => c.mensagem.length <= 255)).toBe(true);
  });

  it('gera alertas ORCAM para 80% e 100% do orçamento da categoria', () => {
    const candidates = evaluateBudgetCandidates('2026-11', [
      {
        categoriaId: 'aaaaaaaa-1111',
        categoriaNome: 'Ok 70%',
        orcamentoMensal: 500,
        gastoMes: 350,
      },
      { categoriaId: 'bbbbbbbb-2222', categoriaNome: 'Lazer', orcamentoMensal: 500, gastoMes: 425 },
      {
        categoriaId: 'cccccccc-3333',
        categoriaNome: 'Delivery',
        orcamentoMensal: 300,
        gastoMes: 330,
      },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.dedupPrefix).toBe('[ORCAM 80% 2026-11 #bbbbbbbb]');
    expect(candidates[1]!.dedupPrefix).toBe('[ORCAM 100% 2026-11 #cccccccc]');
  });

  it('consolida resumo semanal (7 dias) destacando maior categoria e Safe-to-Spend', () => {
    const { digest, candidate } = buildWeeklyDigest({
      referenceDateIso: '2026-11-20',
      transactions7d: [
        { tipo: 'REC', valor: 2500, categoriaNome: 'Salário' },
        { tipo: 'DESP', valor: 300, categoriaNome: 'Alimentação' },
        { tipo: 'DESP', valor: 120, categoriaNome: 'Transporte' },
      ],
      quantoPossoGastarHoje: 95.5,
      contasVencendo48hCount: 1,
    });

    expect(digest).toMatchObject({
      isoWeek: '2026-W47',
      periodStart: '2026-11-14',
      periodEnd: '2026-11-20',
      receitas7d: 2500,
      despesas7d: 420,
      saldoSemana: 2080,
      maiorCategoriaSemana: { nome: 'Alimentação', valor: 300 },
      quantoPossoGastarHoje: 95.5,
      contasVencendo48hCount: 1,
    });
    expect(candidate.tipoAlerta).toBe('RESUMO');
    expect(candidate.mensagem.length).toBeLessThanOrEqual(255);
  });

  it('deriva segredo Base32 e valida TOTP RFC 6238 com janela de tolerância ±1 passo', () => {
    const secret = deriveUserTotpSecret(
      'master-secret-test-key-with-at-least-32-chars',
      'user-uuid-123',
      'hash-abc-xyz',
    );
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    const uri = buildOtpAuthUri('teste@antiliso.local', secret);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('digits=6&period=30');

    const nowMs = 1_795_000_000_000;
    const codeNow = generateTotpCode(secret, nowMs);
    const codePrev = generateTotpCode(secret, nowMs - 30_000);
    const codeFar = generateTotpCode(secret, nowMs - 120_000);

    expect(verifyTotpCode(secret, codeNow, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, codePrev, nowMs)).toBe(true);
    expect(verifyTotpCode(secret, codeFar, nowMs)).toBe(false);
    expect(verifyTotpCode(secret, '000000', nowMs)).toBe(false);
  });
});
