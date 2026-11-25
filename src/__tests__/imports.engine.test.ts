import { describe, expect, it } from 'vitest';
import {
  detectImportFormat,
  matchFuzzyManualDuplicates,
  parseCsvStatement,
  parseFlexibleDateToIso,
  parseFlexibleMoney,
  parseOfxStatement,
} from '../modules/imports/imports.engine.js';

describe('imports.engine — OFX, CSV e Deduplicação (RF-02)', () => {
  it('detecta formato OFX e CSV corretamente', () => {
    expect(detectImportFormat('extrato.ofx', 'OFXHEADER:100\n<OFX></OFX>')).toBe('OFX');
    expect(detectImportFormat('extrato.txt', '\uFEFF  <OFX><BANKMSGSRSV1></OFX>')).toBe('OFX');
    expect(detectImportFormat('fatura.csv', 'date,title,amount\n2026-11-10,Uber,25.90')).toBe(
      'CSV',
    );
  });

  it('converte datas e valores monetários BR/EN/OFX corretamente', () => {
    expect(parseFlexibleDateToIso('20261115120000[-3:BRT]')).toBe('2026-11-15');
    expect(parseFlexibleDateToIso('15/11/2026')).toBe('2026-11-15');
    expect(parseFlexibleDateToIso('2026-11-05')).toBe('2026-11-05');

    expect(parseFlexibleMoney('R$ -1.234,56')).toBe(-1234.56);
    expect(parseFlexibleMoney('(450,25)')).toBe(-450.25);
    expect(parseFlexibleMoney('1,234.56')).toBe(1234.56);
    expect(parseFlexibleMoney('120,50')).toBe(120.5);
  });

  it('faz parse de OFX 1.x SGML sem tags de fechamento para CONTA', () => {
    const sgmlOfx = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261105100000[-3:BRT]
<TRNAMT>5000.00
<FITID>FIT-SAL-01
<MEMO>SALARIO EMPRESA X
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261108183000[-3:BRT]
<TRNAMT>-89.90
<FITID>FIT-IFOOD-02
<NAME>IFOOD
<MEMO>IFOOD *RESTAURANTE
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const rows = parseOfxStatement(sgmlOfx, 'CONTA', 'conta-1');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      kind: 'VALIDO',
      dataCompetencia: '2026-11-05',
      descricao: 'SALARIO EMPRESA X',
      tipo: 'REC',
      valor: 5000,
      externalId: 'FIT-SAL-01',
    });
    expect(rows[0]!.hashDedup).toHaveLength(60);

    expect(rows[1]).toMatchObject({
      kind: 'VALIDO',
      dataCompetencia: '2026-11-08',
      descricao: 'IFOOD *RESTAURANTE',
      tipo: 'DESP',
      valor: 89.9,
      externalId: 'FIT-IFOOD-02',
    });
  });

  it('faz parse de OFX 2.x XML para CARTAO ignorando pagamento/crédito da fatura', () => {
    const xmlCardOfx = `<?xml version="1.0" encoding="UTF-8"?>
<OFX>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <CCSTMTRS>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20261102</DTPOSTED>
            <TRNAMT>1500.00</TRNAMT>
            <FITID>CC-PAY-1</FITID>
            <MEMO>Pagamento recebido</MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20261110</DTPOSTED>
            <TRNAMT>-149.90</TRNAMT>
            <FITID>CC-BUY-1</FITID>
            <MEMO>Amazon Marketplace</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`;

    const rows = parseOfxStatement(xmlCardOfx, 'CARTAO', 'card-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('IGNORADO_CREDITO_CARTAO');
    expect(rows[0]!.hashDedup).toBeNull();
    expect(rows[1]).toMatchObject({
      kind: 'VALIDO',
      tipo: 'DESP',
      valor: 149.9,
      dataCompetencia: '2026-11-10',
      descricao: 'Amazon Marketplace',
    });
  });

  it('gera hashes distintos (#1 e #2) para compras gêmeas no mesmo arquivo e idênticos no reenvio', () => {
    const csvWithTwins = `\uFEFFData;Descrição;Valor
10/11/2026;Metrô SP;-5,50
10/11/2026;Metrô SP;-5,50
11/11/2026;"Supermercado, Ltda";"R$ -1.250,40"
12/11/2026;Freelance;2.000,00`;

    const firstRun = parseCsvStatement(csvWithTwins, 'CONTA', 'conta-1');
    const secondRun = parseCsvStatement(csvWithTwins, 'CONTA', 'conta-1');

    expect(firstRun).toHaveLength(4);
    expect(firstRun[0]!.hashDedup).not.toBe(firstRun[1]!.hashDedup);
    expect(firstRun[0]!.hashDedup).toBe(secondRun[0]!.hashDedup);
    expect(firstRun[1]!.hashDedup).toBe(secondRun[1]!.hashDedup);
    expect(firstRun[2]).toMatchObject({
      descricao: 'Supermercado, Ltda',
      valor: 1250.4,
      tipo: 'DESP',
    });
    expect(firstRun[3]).toMatchObject({
      descricao: 'Freelance',
      valor: 2000,
      tipo: 'REC',
    });
  });

  it('faz parse de fatura CSV estilo Nubank (compras positivas, pagamento negativo ignorado)', () => {
    const nubankCsv = `date,category,title,amount
2026-11-01,pagamento,Pagamento recebido,-1200.00
2026-11-03,transporte,Uber *Trip,32.50
2026-11-05,restaurante,Padaria Central,48.00`;

    const rows = parseCsvStatement(nubankCsv, 'CARTAO', 'card-1');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.kind).toBe('IGNORADO_CREDITO_CARTAO');
    expect(rows[1]).toMatchObject({
      kind: 'VALIDO',
      tipo: 'DESP',
      valor: 32.5,
      descricao: 'Uber *Trip',
    });
    expect(rows[2]).toMatchObject({
      kind: 'VALIDO',
      tipo: 'DESP',
      valor: 48,
      descricao: 'Padaria Central',
    });
  });

  it('detecta duplicata manual difusa 1-para-1 em janela de ±1 dia', () => {
    const csv = `Data;Descrição;Valor
10/11/2026;Almoco Restaurante;-35,00
10/11/2026;Almoco Restaurante;-35,00`;

    const rows = parseCsvStatement(csv, 'CONTA', 'conta-1');
    const matches = matchFuzzyManualDuplicates(rows, new Set(), [
      {
        id: 'manual-1',
        descricao: 'Almoço',
        valor: 35,
        tipo: 'DESP',
        dataCompetencia: '2026-11-09',
      },
    ]);

    expect(matches.size).toBe(1);
    expect(matches.get(0)?.id).toBe('manual-1');
    expect(matches.has(1)).toBe(false);
  });
});
