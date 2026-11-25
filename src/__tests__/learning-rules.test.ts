import { describe, expect, it } from 'vitest';
import {
  extractLearningTerm,
  normalizeLearningText,
  rankMatchingRule,
} from '../modules/categories/learning-rules.engine.js';

describe('Etapa 3 — Motor de Regras de Aprendizado (RF-03)', () => {
  it('extrai termo-chave normalizado ignorando stopwords, métodos e descrições genéricas', () => {
    expect(normalizeLearningText('Café / iFood!')).toBe('cafe ifood');
    expect(extractLearningTerm('Uber aeroporto')).toBe('uber');
    expect(extractLearningTerm('iFood almoço pix')).toBe('ifood');
    expect(extractLearningTerm('Conta de luz')).toBe('conta luz');
    expect(extractLearningTerm('Plano de saúde')).toBe('plano saude');
    expect(extractLearningTerm('Gasto rápido')).toBeNull();
    expect(extractLearningTerm('Receita rápida')).toBeNull();
    expect(extractLearningTerm('12345 pix')).toBeNull();
  });

  it('ordena candidatas por exatidão, confiança, especificidade e respeita fronteira de palavra', () => {
    const rules = [
      { id: '1', termoChave: 'conta', hitsConfianca: 2 },
      { id: '2', termoChave: 'conta luz', hitsConfianca: 2 },
      { id: '3', termoChave: 'uber', hitsConfianca: 1 },
      { id: '4', termoChave: 'bar', hitsConfianca: 10 },
    ];

    expect(rankMatchingRule('Conta de luz 180', rules)?.id).toBe('2');
    expect(rankMatchingRule('Barbearia do Zé', rules)).toBeNull();

    const conflictRules = [
      { id: 'a', termoChave: 'ifood', hitsConfianca: 1 },
      { id: 'b', termoChave: 'almoco', hitsConfianca: 5 },
    ];
    expect(rankMatchingRule('iFood almoço', conflictRules)?.id).toBe('b');

    const exactVsPartial = [
      { id: 'partial', termoChave: 'uber', hitsConfianca: 9 },
      { id: 'exact', termoChave: 'uber aeroporto', hitsConfianca: 1 },
    ];
    expect(rankMatchingRule('Uber aeroporto', exactVsPartial)?.id).toBe('exact');
  });
});
