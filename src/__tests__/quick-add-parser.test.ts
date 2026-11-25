import { describe, expect, it } from 'vitest';
import { parseQuickAddText } from '../modules/transactions/quick-add-parser.js';

describe('Etapa 2 — Parser Quick-Add PT-BR', () => {
  it('interpreta despesas simples e com método de pagamento', () => {
    expect(parseQuickAddText('Almoço 35 pix')).toEqual({
      tipo: 'DESP',
      valor: 35,
      descricao: 'Almoço',
      metodoDetectado: 'pix',
    });

    expect(parseQuickAddText('Uber 24,90')).toEqual({
      tipo: 'DESP',
      valor: 24.9,
      descricao: 'Uber',
      metodoDetectado: null,
    });

    expect(parseQuickAddText('Mercado 180.40 débito')).toEqual({
      tipo: 'DESP',
      valor: 180.4,
      descricao: 'Mercado',
      metodoDetectado: 'debito',
    });

    expect(parseQuickAddText('Café 8,5')).toEqual({
      tipo: 'DESP',
      valor: 8.5,
      descricao: 'Café',
      metodoDetectado: null,
    });

    expect(parseQuickAddText('Uber -15')).toEqual({
      tipo: 'DESP',
      valor: 15,
      descricao: 'Uber',
      metodoDetectado: null,
    });

    expect(parseQuickAddText('Jantar 120 crédito')).toEqual({
      tipo: 'DESP',
      valor: 120,
      descricao: 'Jantar',
      metodoDetectado: 'credito',
    });

    expect(parseQuickAddText('Uber 24,90 no cartão')).toEqual({
      tipo: 'DESP',
      valor: 24.9,
      descricao: 'Uber',
      metodoDetectado: 'cartao',
    });
  });

  it('interpreta receitas por prefixo + ou palavras-chave', () => {
    expect(parseQuickAddText('R$ 1.250,50 Salário')).toEqual({
      tipo: 'REC',
      valor: 1250.5,
      descricao: 'Salário',
      metodoDetectado: null,
    });

    expect(parseQuickAddText('+500 freela')).toEqual({
      tipo: 'REC',
      valor: 500,
      descricao: 'Freela',
      metodoDetectado: null,
    });

    expect(parseQuickAddText('recebi 200 reembolso via pix')).toEqual({
      tipo: 'REC',
      valor: 200,
      descricao: 'Recebi reembolso',
      metodoDetectado: 'pix',
    });
  });

  it('rejeita entradas sem valor válido ou vazias', () => {
    expect(() => parseQuickAddText('   ')).toThrow();
    expect(() => parseQuickAddText('Almoço')).toThrow();
    expect(() => parseQuickAddText('Almoço 0')).toThrow();
    expect(() => parseQuickAddText('Almoço 0,00')).toThrow();
  });
});
