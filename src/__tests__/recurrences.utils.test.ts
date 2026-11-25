import { describe, expect, it } from 'vitest';
import {
  buildRecurrenceHashDedup,
  getMonthRange,
  resolveCompetenceDateForMonth,
} from '../modules/recurrences/recurrences.utils.js';

describe('Etapa 4 — Utilitários de Recorrências (RF-05)', () => {
  it('ajusta dias de vencimento em meses curtos e anos bissextos', () => {
    expect(resolveCompetenceDateForMonth('2026-02', 31).toISOString().slice(0, 10)).toBe(
      '2026-02-28',
    );
    expect(resolveCompetenceDateForMonth('2028-02', 31).toISOString().slice(0, 10)).toBe(
      '2028-02-29',
    );
    expect(resolveCompetenceDateForMonth('2026-04', 31).toISOString().slice(0, 10)).toBe(
      '2026-04-30',
    );
    expect(resolveCompetenceDateForMonth('2026-11', 10).toISOString().slice(0, 10)).toBe(
      '2026-11-10',
    );
  });

  it('gera hashDedup dentro do limite VARCHAR(64) e valida formato de mês', () => {
    const hash = buildRecurrenceHashDedup('00000000-0000-0000-0000-000000000001', '2026-11');
    expect(hash).toBe('rec:00000000-0000-0000-0000-000000000001:2026-11');
    expect(hash.length).toBeLessThanOrEqual(64);

    expect(() => getMonthRange('2026-13')).toThrow();
    expect(() => getMonthRange('2026-00')).toThrow();
    expect(() => getMonthRange('2026-1')).toThrow();
  });
});
