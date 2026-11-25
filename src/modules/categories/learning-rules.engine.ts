const IGNORED_DESCRIPTIONS = new Set([
  'gasto rapido',
  'receita rapida',
  'lancamento rapido',
  'transferencia entre contas',
]);

const STOPWORDS = new Set([
  'de',
  'do',
  'da',
  'dos',
  'das',
  'para',
  'pra',
  'pro',
  'com',
  'sem',
  'no',
  'na',
  'nos',
  'nas',
  'em',
  'por',
  'pelo',
  'pela',
  'via',
  'uma',
  'um',
  'uns',
  'umas',
  'que',
  'ao',
  'aos',
  'del',
  'the',
]);

const PAYMENT_NOISE = new Set([
  'pix',
  'debito',
  'credito',
  'dinheiro',
  'especie',
  'boleto',
  'ted',
  'doc',
  'transferencia',
]);

const GENERIC_PREFIXES = new Set([
  'conta',
  'pagamento',
  'compra',
  'taxa',
  'fatura',
  'parcela',
  'assinatura',
  'mensalidade',
  'plano',
  'loja',
  'posto',
  'mercado',
  'supermercado',
  'restaurante',
  'clinica',
  'consulta',
  'exame',
  'servico',
  'recebi',
  'recebido',
  'ganhei',
]);

export function normalizeLearningText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractMeaningfulTokens(descricao: string): string[] {
  const normalized = normalizeLearningText(descricao);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(' ')
    .filter(
      (token) =>
        token.length >= 3 &&
        !/^\d+$/.test(token) &&
        !STOPWORDS.has(token) &&
        !PAYMENT_NOISE.has(token),
    );
}

export function extractLearningTerm(descricao: string): string | null {
  const normalized = normalizeLearningText(descricao);
  if (!normalized || IGNORED_DESCRIPTIONS.has(normalized)) {
    return null;
  }

  const tokens = extractMeaningfulTokens(descricao);
  if (tokens.length === 0) {
    return null;
  }

  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 80);
  }

  if (GENERIC_PREFIXES.has(tokens[0]!)) {
    return `${tokens[0]} ${tokens[1]}`.slice(0, 80);
  }

  return tokens[0]!.slice(0, 80);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rankMatchingRule<T extends { termoChave: string; hitsConfianca: number }>(
  descricao: string,
  rules: readonly T[],
): T | null {
  const normalizedText = normalizeLearningText(descricao);
  if (!normalizedText) {
    return null;
  }

  const meaningfulJoined = extractMeaningfulTokens(descricao).join(' ');

  const candidates = rules
    .map((rule) => ({
      rule,
      normalizedTerm: normalizeLearningText(rule.termoChave),
    }))
    .filter(({ normalizedTerm }) => {
      if (!normalizedTerm) {
        return false;
      }

      const pattern = new RegExp(`(?:^|\\s)${escapeRegex(normalizedTerm)}(?:\\s|$)`);
      return (
        pattern.test(normalizedText) ||
        (meaningfulJoined.length > 0 && pattern.test(meaningfulJoined))
      );
    });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const aExact = a.normalizedTerm === normalizedText || a.normalizedTerm === meaningfulJoined;
    const bExact = b.normalizedTerm === normalizedText || b.normalizedTerm === meaningfulJoined;
    if (aExact !== bExact) {
      return aExact ? -1 : 1;
    }

    if (b.rule.hitsConfianca !== a.rule.hitsConfianca) {
      return b.rule.hitsConfianca - a.rule.hitsConfianca;
    }

    if (b.normalizedTerm.length !== a.normalizedTerm.length) {
      return b.normalizedTerm.length - a.normalizedTerm.length;
    }

    return a.normalizedTerm.localeCompare(b.normalizedTerm);
  });

  return candidates[0]!.rule;
}
