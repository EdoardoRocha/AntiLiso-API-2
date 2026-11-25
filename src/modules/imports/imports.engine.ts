import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors/app-error.js';
import { roundCurrency } from '../safe-to-spend/safe-to-spend.engine.js';

export type ImportFormat = 'OFX' | 'CSV';
export type ImportTargetType = 'CONTA' | 'CARTAO';
export type ParsedRowKind = 'VALIDO' | 'IGNORADO_CREDITO_CARTAO' | 'IGNORADO_VALOR_ZERO';

export interface ParsedStatementRow {
  lineNumber: number;
  kind: ParsedRowKind;
  ignoreReason: string | null;
  dataCompetencia: string;
  descricao: string;
  valor: number;
  tipo: 'REC' | 'DESP';
  externalId: string | null;
  hashDedup: string | null;
}

export interface ExistingManualTxCandidate {
  id: string;
  descricao: string;
  valor: number;
  tipo: 'REC' | 'DESP';
  dataCompetencia: string;
}

export interface MatchedManualTxInfo {
  id: string;
  descricao: string;
  dataCompetencia: string;
  valor: number;
}

const DUMMY_EXTERNAL_IDS = new Set(['0', 'null', 'undefined', 'n/a', 'na', '-', 'none']);

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function normalizeHeaderText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeImportDescription(description: string): string {
  return description
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

function sanitizeDescription(raw: string): string {
  const cleaned = decodeBasicEntities(raw).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return 'Lançamento importado';
  }
  return cleaned.slice(0, 255);
}

function sanitizeExternalId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (DUMMY_EXTERNAL_IDS.has(lower) || /^0+$/.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 120);
}

export function detectImportFormat(fileName: string, content: string): ImportFormat {
  const cleaned = stripBom(content).trimStart();
  const upperPreview = cleaned.slice(0, 2000).toUpperCase();

  if (
    upperPreview.includes('<OFX') ||
    upperPreview.includes('<STMTTRN>') ||
    upperPreview.includes('OFXHEADER:') ||
    fileName.trim().toLowerCase().endsWith('.ofx')
  ) {
    return 'OFX';
  }

  return 'CSV';
}

function isValidUtcDateParts(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function formatUtcParts(year: number, month: number, day: number): string | null {
  if (!isValidUtcDateParts(year, month, day)) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseFlexibleDateToIso(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }

  // OFX timestamp: YYYYMMDD or YYYYMMDDHHMMSS[-3:BRT]
  const ofxMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})(?:[\d.[\]:+A-Za-z-]*)?$/);
  if (ofxMatch) {
    return formatUtcParts(Number(ofxMatch[1]), Number(ofxMatch[2]), Number(ofxMatch[3]));
  }

  // ISO date or datetime: YYYY-MM-DD...
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoMatch) {
    return formatUtcParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // Brazilian DD/MM/YYYY or DD-MM-YYYY or DD.MM.YY
  const brMatch = cleaned.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s+.*)?$/);
  if (brMatch) {
    const day = Number(brMatch[1]);
    const month = Number(brMatch[2]);
    let year = Number(brMatch[3]);
    if (brMatch[3]!.length === 2) {
      year += 2000;
    }
    return formatUtcParts(year, month, day);
  }

  return null;
}

export function parseFlexibleMoney(raw: string): number | null {
  let cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }

  let isNegative = false;
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    isNegative = true;
    cleaned = cleaned.slice(1, -1).trim();
  }

  cleaned = cleaned.replace(/R\$/gi, '').replace(/\s+/g, '');

  if (cleaned.startsWith('-')) {
    isNegative = true;
    cleaned = cleaned.slice(1);
  } else if (cleaned.endsWith('-')) {
    isNegative = true;
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }

  cleaned = cleaned.replace(/[^\d.,]/g, '');
  if (!cleaned) {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // PT-BR: 1.234,56
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // EN: 1,234.56
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const commaCount = (cleaned.match(/,/g) ?? []).length;
    if (commaCount > 1) {
      normalized = cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(',', '.');
    }
  } else if (lastDot !== -1) {
    const dotCount = (cleaned.match(/\./g) ?? []).length;
    if (dotCount > 1) {
      normalized = cleaned.replace(/\./g, '');
    } else {
      normalized = cleaned;
    }
  } else {
    normalized = cleaned;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const signed = isNegative ? -Math.abs(parsed) : parsed;
  return roundCurrency(signed);
}

export function isCardBillPaymentDescription(description: string): boolean {
  const normalized = normalizeImportDescription(description);
  if (!normalized) {
    return false;
  }

  return /\b(pagamento recebido|pagamento da fatura|pagamento de fatura|pagamento fatura|pgto fatura|debito automatico fatura|credito de fatura)\b/.test(
    normalized,
  );
}

export function buildImportHashDedup(params: {
  targetType: ImportTargetType;
  targetId: string;
  externalId: string | null;
  dataCompetencia: string;
  tipo: 'REC' | 'DESP';
  valor: number;
  descricao: string;
  occurrenceTracker: Map<string, number>;
}): string {
  const baseKey = params.externalId
    ? `fitid:${params.targetType}:${params.targetId}:${params.externalId.toLowerCase()}`
    : `row:${params.targetType}:${params.targetId}:${params.dataCompetencia}:${params.tipo}:${params.valor.toFixed(2)}:${normalizeImportDescription(params.descricao)}`;

  const occurrence = (params.occurrenceTracker.get(baseKey) ?? 0) + 1;
  params.occurrenceTracker.set(baseKey, occurrence);

  const digest = createHash('sha256').update(`${baseKey}:#${occurrence}`).digest('hex');
  // 4 + 56 = 60 chars (well within VARCHAR(64) limit)
  return `imp:${digest.slice(0, 56)}`;
}

function extractOfxTag(block: string, tagName: string): string | null {
  const xmlRegex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const xmlMatch = block.match(xmlRegex);
  if (xmlMatch?.[1] !== undefined) {
    return xmlMatch[1].trim();
  }

  const sgmlRegex = new RegExp(`<${tagName}>([^<\\r\\n]+)`, 'i');
  const sgmlMatch = block.match(sgmlRegex);
  if (sgmlMatch?.[1] !== undefined) {
    return sgmlMatch[1].trim();
  }

  return null;
}

export function parseOfxStatement(
  content: string,
  targetType: ImportTargetType,
  targetId: string,
): ParsedStatementRow[] {
  const cleaned = stripBom(content);
  const blockRegex = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>)|$)/gi;
  const matches = Array.from(cleaned.matchAll(blockRegex));

  if (matches.length === 0) {
    throw new AppError(
      'Nenhuma transação OFX válida foi encontrada no arquivo.',
      400,
      'EMPTY_OR_INVALID_IMPORT_FILE',
    );
  }

  const occurrenceTracker = new Map<string, number>();
  const rows: ParsedStatementRow[] = [];

  for (let idx = 0; idx < matches.length; idx++) {
    const match = matches[idx]!;
    const block = match[1] ?? '';
    const matchIndex = match.index ?? 0;
    const lineNumber = cleaned.slice(0, matchIndex).split(/\r?\n/).length;

    const rawDate = extractOfxTag(block, 'DTPOSTED');
    const rawAmount = extractOfxTag(block, 'TRNAMT');
    if (!rawDate || !rawAmount) {
      continue;
    }

    const dataCompetencia = parseFlexibleDateToIso(rawDate);
    const signedAmount = parseFlexibleMoney(rawAmount);
    if (!dataCompetencia || signedAmount === null) {
      continue;
    }

    const trnType = (extractOfxTag(block, 'TRNTYPE') ?? '').trim().toUpperCase();
    const fitid = sanitizeExternalId(extractOfxTag(block, 'FITID'));
    const rawName = extractOfxTag(block, 'NAME') ?? '';
    const rawMemo = extractOfxTag(block, 'MEMO') ?? '';

    let combinedDesc = rawName || rawMemo;
    if (rawName && rawMemo) {
      const normName = normalizeImportDescription(rawName);
      const normMemo = normalizeImportDescription(rawMemo);
      if (normMemo && !normName.includes(normMemo)) {
        combinedDesc = normMemo.includes(normName) ? rawMemo : `${rawName} - ${rawMemo}`;
      }
    }

    const descricao = sanitizeDescription(combinedDesc);
    const absValor = roundCurrency(Math.abs(signedAmount));

    if (absValor < 0.01) {
      rows.push({
        lineNumber,
        kind: 'IGNORADO_VALOR_ZERO',
        ignoreReason: 'Lançamento com valor R$ 0,00 ignorado.',
        dataCompetencia,
        descricao,
        valor: 0,
        tipo: 'DESP',
        externalId: fitid,
        hashDedup: null,
      });
      continue;
    }

    if (targetType === 'CARTAO') {
      const isCardCreditOrPayment =
        signedAmount > 0 || trnType === 'CREDIT' || isCardBillPaymentDescription(descricao);

      if (isCardCreditOrPayment) {
        rows.push({
          lineNumber,
          kind: 'IGNORADO_CREDITO_CARTAO',
          ignoreReason:
            'Crédito ou pagamento de fatura ignorado no cartão (para pagamento use "Pagar Fatura" na aba Cartões).',
          dataCompetencia,
          descricao,
          valor: absValor,
          tipo: 'DESP',
          externalId: fitid,
          hashDedup: null,
        });
        continue;
      }

      const hashDedup = buildImportHashDedup({
        targetType,
        targetId,
        externalId: fitid,
        dataCompetencia,
        tipo: 'DESP',
        valor: absValor,
        descricao,
        occurrenceTracker,
      });

      rows.push({
        lineNumber,
        kind: 'VALIDO',
        ignoreReason: null,
        dataCompetencia,
        descricao,
        valor: absValor,
        tipo: 'DESP',
        externalId: fitid,
        hashDedup,
      });
      continue;
    }

    const tipo: 'REC' | 'DESP' =
      signedAmount > 0 || (signedAmount === 0 && trnType === 'CREDIT') ? 'REC' : 'DESP';

    const hashDedup = buildImportHashDedup({
      targetType,
      targetId,
      externalId: fitid,
      dataCompetencia,
      tipo,
      valor: absValor,
      descricao,
      occurrenceTracker,
    });

    rows.push({
      lineNumber,
      kind: 'VALIDO',
      ignoreReason: null,
      dataCompetencia,
      descricao,
      valor: absValor,
      tipo,
      externalId: fitid,
      hashDedup,
    });
  }

  if (rows.length === 0) {
    throw new AppError(
      'Nenhuma transação OFX válida foi encontrada no arquivo.',
      400,
      'EMPTY_OR_INVALID_IMPORT_FILE',
    );
  }

  return rows;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  cells.push(current.trim());
  return cells;
}

function detectDelimiterForLine(line: string): string {
  const candidates = [';', ',', '\t'];
  let best = ',';
  let bestCount = -1;

  for (const delimiter of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        count++;
      }
    }

    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }

  return bestCount > 0 ? best : ';';
}

interface CsvColumnMap {
  dateIdx: number;
  descIndices: number[];
  amountIdx: number;
  creditIdx: number;
  debitIdx: number;
  typeIdx: number;
  externalIdIdx: number;
}

function findColumnIndex(
  headers: string[],
  exactMatches: string[],
  partialMatches: string[],
): number {
  for (const exact of exactMatches) {
    const idx = headers.findIndex((h) => h === exact);
    if (idx !== -1) {
      return idx;
    }
  }

  for (const partial of partialMatches) {
    const idx = headers.findIndex((h) => h.includes(partial));
    if (idx !== -1) {
      return idx;
    }
  }

  return -1;
}

function resolveCsvColumns(rawHeaders: string[]): CsvColumnMap | null {
  const headers = rawHeaders.map(normalizeHeaderText);

  const dateIdx = findColumnIndex(
    headers,
    [
      'data',
      'date',
      'data lancamento',
      'data de lancamento',
      'dt lancamento',
      'data compra',
      'data da compra',
      'vencimento',
    ],
    ['data', 'date'],
  );

  const amountIdx = findColumnIndex(
    headers,
    ['valor', 'amount', 'value', 'valor r$', 'valor (r$)', 'quantia', 'valor total'],
    ['valor', 'amount', 'value'],
  );

  const creditIdx = findColumnIndex(
    headers,
    ['credito', 'credit', 'entrada', 'receita'],
    ['credito', 'credit', 'entrada'],
  );

  const debitIdx = findColumnIndex(
    headers,
    ['debito', 'debit', 'saida', 'despesa'],
    ['debito', 'debit', 'saida'],
  );

  if (dateIdx === -1 || (amountIdx === -1 && creditIdx === -1 && debitIdx === -1)) {
    return null;
  }

  const descCandidateTerms = [
    'descricao',
    'historico',
    'title',
    'titulo',
    'estabelecimento',
    'lancamento',
    'memo',
    'nome',
    'detalhes',
    'description',
  ];

  const primaryDescIdx = findColumnIndex(headers, descCandidateTerms, [
    'descri',
    'histor',
    'title',
    'estabelec',
    'memo',
  ]);
  const secondaryDescIdx = findColumnIndex(headers, ['detalhes', 'complemento', 'category'], []);

  const descIndices: number[] = [];
  if (primaryDescIdx !== -1) {
    descIndices.push(primaryDescIdx);
  }
  if (secondaryDescIdx !== -1 && secondaryDescIdx !== primaryDescIdx) {
    // Only keep secondary if primary was empty at row level (checked per-row) or if no primary exists
    if (descIndices.length === 0) {
      descIndices.push(secondaryDescIdx);
    }
  }

  const typeIdx = findColumnIndex(
    headers,
    ['tipo', 'natureza', 'd/c', 'dc', 'operacao', 'sinal', 'type'],
    ['d/c', 'natureza'],
  );

  const externalIdIdx = findColumnIndex(
    headers,
    ['identificador', 'id', 'fitid', 'id transacao', 'codigo', 'transaction id'],
    ['identificador', 'fitid'],
  );

  return {
    dateIdx,
    descIndices,
    amountIdx,
    creditIdx,
    debitIdx,
    typeIdx,
    externalIdIdx,
  };
}

interface RawCsvRow {
  lineNumber: number;
  dataCompetencia: string;
  descricao: string;
  signedAmount: number;
  externalId: string | null;
}

export function parseCsvStatement(
  content: string,
  targetType: ImportTargetType,
  targetId: string,
): ParsedStatementRow[] {
  const cleaned = stripBom(content);
  const rawLines = cleaned.split(/\r?\n/);

  let headerLineIdx = -1;
  let delimiter = ';';
  let columnMap: CsvColumnMap | null = null;

  const maxScanLines = Math.min(rawLines.length, 15);
  for (let i = 0; i < maxScanLines; i++) {
    const line = rawLines[i]?.trim();
    if (!line) {
      continue;
    }

    const candidateDelimiter = detectDelimiterForLine(line);
    const cells = splitCsvLine(line, candidateDelimiter);
    if (cells.length < 2) {
      continue;
    }

    const candidateMap = resolveCsvColumns(cells);
    if (candidateMap) {
      headerLineIdx = i;
      delimiter = candidateDelimiter;
      columnMap = candidateMap;
      break;
    }
  }

  if (headerLineIdx === -1 || !columnMap) {
    throw new AppError(
      'Cabeçalho CSV inválido. Certifique-se de incluir colunas de Data, Descrição e Valor.',
      400,
      'INVALID_CSV_HEADER',
    );
  }

  const rawRows: RawCsvRow[] = [];

  for (let i = headerLineIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i]?.trim();
    if (!line) {
      continue;
    }

    const cells = splitCsvLine(line, delimiter);
    const rawDate = cells[columnMap.dateIdx] ?? '';
    const dataCompetencia = parseFlexibleDateToIso(rawDate);
    if (!dataCompetencia) {
      continue;
    }

    let signedAmount: number | null = null;

    if (columnMap.amountIdx !== -1) {
      signedAmount = parseFlexibleMoney(cells[columnMap.amountIdx] ?? '');
    } else {
      const creditVal =
        columnMap.creditIdx !== -1 ? parseFlexibleMoney(cells[columnMap.creditIdx] ?? '') : null;
      const debitVal =
        columnMap.debitIdx !== -1 ? parseFlexibleMoney(cells[columnMap.debitIdx] ?? '') : null;

      if (creditVal !== null && Math.abs(creditVal) >= 0.01) {
        signedAmount = Math.abs(creditVal);
      } else if (debitVal !== null && Math.abs(debitVal) >= 0.01) {
        signedAmount = -Math.abs(debitVal);
      } else if (creditVal === 0 || debitVal === 0) {
        signedAmount = 0;
      }
    }

    if (signedAmount === null) {
      continue;
    }

    if (columnMap.typeIdx !== -1) {
      const rawType = normalizeHeaderText(cells[columnMap.typeIdx] ?? '');
      if (
        rawType === 'd' ||
        rawType === '-' ||
        rawType.startsWith('deb') ||
        rawType.startsWith('desp') ||
        rawType.startsWith('said')
      ) {
        signedAmount = -Math.abs(signedAmount);
      } else if (
        rawType === 'c' ||
        rawType === '+' ||
        rawType.startsWith('cred') ||
        rawType.startsWith('rec') ||
        rawType.startsWith('entr')
      ) {
        signedAmount = Math.abs(signedAmount);
      }
    }

    let rawDesc = columnMap.descIndices
      .map((idx) => (cells[idx] ?? '').trim())
      .filter(Boolean)
      .join(' - ');

    if (!rawDesc) {
      const ignoredCols = new Set([
        columnMap.dateIdx,
        columnMap.amountIdx,
        columnMap.creditIdx,
        columnMap.debitIdx,
        columnMap.typeIdx,
        columnMap.externalIdIdx,
      ]);
      rawDesc = cells
        .filter((_, idx) => !ignoredCols.has(idx) && Boolean(cells[idx]?.trim()))
        .join(' - ');
    }

    const externalId =
      columnMap.externalIdIdx !== -1 ? sanitizeExternalId(cells[columnMap.externalIdIdx]) : null;

    rawRows.push({
      lineNumber: i + 1,
      dataCompetencia,
      descricao: sanitizeDescription(rawDesc),
      signedAmount: roundCurrency(signedAmount),
      externalId,
    });
  }

  if (rawRows.length === 0) {
    throw new AppError(
      'Nenhum lançamento válido foi encontrado no arquivo CSV.',
      400,
      'EMPTY_OR_INVALID_IMPORT_FILE',
    );
  }

  // Determine CSV sign convention for credit cards:
  // Nubank/Inter fatura CSVs represent purchases as positive numbers and bill payments as negative.
  // Traditional exports represent charges as negative numbers and payments as positive.
  let positivePurchasesAreCharges = true;
  if (targetType === 'CARTAO') {
    let positiveCount = 0;
    let negativeCount = 0;
    for (const row of rawRows) {
      if (Math.abs(row.signedAmount) < 0.01 || isCardBillPaymentDescription(row.descricao)) {
        continue;
      }
      if (row.signedAmount > 0) {
        positiveCount++;
      } else {
        negativeCount++;
      }
    }
    positivePurchasesAreCharges = positiveCount >= negativeCount;
  }

  const occurrenceTracker = new Map<string, number>();

  return rawRows.map((row) => {
    const absValor = roundCurrency(Math.abs(row.signedAmount));
    if (absValor < 0.01) {
      return {
        lineNumber: row.lineNumber,
        kind: 'IGNORADO_VALOR_ZERO',
        ignoreReason: 'Lançamento com valor R$ 0,00 ignorado.',
        dataCompetencia: row.dataCompetencia,
        descricao: row.descricao,
        valor: 0,
        tipo: 'DESP',
        externalId: row.externalId,
        hashDedup: null,
      };
    }

    if (targetType === 'CARTAO') {
      const isCreditOrPayment =
        isCardBillPaymentDescription(row.descricao) ||
        (positivePurchasesAreCharges ? row.signedAmount < 0 : row.signedAmount > 0);

      if (isCreditOrPayment) {
        return {
          lineNumber: row.lineNumber,
          kind: 'IGNORADO_CREDITO_CARTAO',
          ignoreReason:
            'Crédito ou pagamento de fatura ignorado no cartão (para pagamento use "Pagar Fatura" na aba Cartões).',
          dataCompetencia: row.dataCompetencia,
          descricao: row.descricao,
          valor: absValor,
          tipo: 'DESP',
          externalId: row.externalId,
          hashDedup: null,
        };
      }

      const hashDedup = buildImportHashDedup({
        targetType,
        targetId,
        externalId: row.externalId,
        dataCompetencia: row.dataCompetencia,
        tipo: 'DESP',
        valor: absValor,
        descricao: row.descricao,
        occurrenceTracker,
      });

      return {
        lineNumber: row.lineNumber,
        kind: 'VALIDO',
        ignoreReason: null,
        dataCompetencia: row.dataCompetencia,
        descricao: row.descricao,
        valor: absValor,
        tipo: 'DESP',
        externalId: row.externalId,
        hashDedup,
      };
    }

    const tipo: 'REC' | 'DESP' = row.signedAmount > 0 ? 'REC' : 'DESP';
    const hashDedup = buildImportHashDedup({
      targetType,
      targetId,
      externalId: row.externalId,
      dataCompetencia: row.dataCompetencia,
      tipo,
      valor: absValor,
      descricao: row.descricao,
      occurrenceTracker,
    });

    return {
      lineNumber: row.lineNumber,
      kind: 'VALIDO',
      ignoreReason: null,
      dataCompetencia: row.dataCompetencia,
      descricao: row.descricao,
      valor: absValor,
      tipo,
      externalId: row.externalId,
      hashDedup,
    };
  });
}

function isoDateToUtcMs(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getTime();
}

function tokenOverlapScore(descA: string, descB: string): number {
  const wordsA = new Set(
    normalizeImportDescription(descA)
      .split(' ')
      .filter((w) => w.length >= 3),
  );
  const wordsB = new Set(
    normalizeImportDescription(descB)
      .split(' ')
      .filter((w) => w.length >= 3),
  );

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) {
      overlap++;
    }
  }
  return overlap;
}

const ONE_DAY_MS = 86_400_000;

export function matchFuzzyManualDuplicates(
  rows: readonly ParsedStatementRow[],
  exactDuplicateHashes: ReadonlySet<string>,
  manualCandidates: readonly ExistingManualTxCandidate[],
): Map<number, MatchedManualTxInfo> {
  const matches = new Map<number, MatchedManualTxInfo>();
  const usedCandidateIds = new Set<string>();

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    if (row.kind !== 'VALIDO' || !row.hashDedup || exactDuplicateHashes.has(row.hashDedup)) {
      continue;
    }

    const rowMs = isoDateToUtcMs(row.dataCompetencia);
    let bestCandidate: ExistingManualTxCandidate | null = null;
    let bestDayDiff = Number.POSITIVE_INFINITY;
    let bestOverlap = -1;

    for (const candidate of manualCandidates) {
      if (usedCandidateIds.has(candidate.id)) {
        continue;
      }
      if (candidate.tipo !== row.tipo) {
        continue;
      }
      if (Math.abs(candidate.valor - row.valor) >= 0.005) {
        continue;
      }

      const dayDiffMs = Math.abs(rowMs - isoDateToUtcMs(candidate.dataCompetencia));
      if (dayDiffMs > ONE_DAY_MS) {
        continue;
      }

      const overlap = tokenOverlapScore(row.descricao, candidate.descricao);
      if (dayDiffMs < bestDayDiff || (dayDiffMs === bestDayDiff && overlap > bestOverlap)) {
        bestCandidate = candidate;
        bestDayDiff = dayDiffMs;
        bestOverlap = overlap;
      }
    }

    if (bestCandidate) {
      usedCandidateIds.add(bestCandidate.id);
      matches.set(rowIdx, {
        id: bestCandidate.id,
        descricao: bestCandidate.descricao,
        dataCompetencia: bestCandidate.dataCompetencia,
        valor: bestCandidate.valor,
      });
    }
  }

  return matches;
}
