-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "tipo_conta" AS ENUM ('CORRENTE', 'CARTEIRA', 'COFRE');

-- CreateEnum
CREATE TYPE "tipo_categoria" AS ENUM ('RECEITA', 'DESPESA');

-- CreateEnum
CREATE TYPE "tipo_transacao" AS ENUM ('REC', 'DESP', 'TRANSF');

-- CreateEnum
CREATE TYPE "status_transacao" AS ENUM ('PAGO', 'PENDENTE');

-- CreateEnum
CREATE TYPE "status_gatilho" AS ENUM ('BLOQUEADO', 'LIBERADO');

-- CreateEnum
CREATE TYPE "tipo_movimento_reserva" AS ENUM ('APORTE', 'RESGATE');

-- CreateEnum
CREATE TYPE "classe_ativo" AS ENUM ('RF', 'FII', 'ACOES', 'INT', 'CRIPTO');

-- CreateEnum
CREATE TYPE "tipo_alerta" AS ENUM ('VENC', 'ORCAM', 'RESUMO');

-- CreateEnum
CREATE TYPE "canal_alerta" AS ENUM ('PUSH', 'EMAIL', 'WHATS');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "email" VARCHAR(180) NOT NULL,
    "senha_hash" VARCHAR(255) NOT NULL,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "custo_vida_mensal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "meses_reserva_alvo" INTEGER NOT NULL DEFAULT 6,
    "pct_pague_primeiro" DECIMAL(5,2) NOT NULL DEFAULT 15.00,
    "gatilho_invest_pct" DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contas" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "nome" VARCHAR(80) NOT NULL,
    "tipo" "tipo_conta" NOT NULL,
    "saldo_atual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "eh_conta_padrao" BOOLEAN NOT NULL DEFAULT false,
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "contas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cartoes_credito" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "conta_pagamento_id" UUID NOT NULL,
    "nome" VARCHAR(80) NOT NULL,
    "limite_total" DECIMAL(12,2) NOT NULL,
    "teto_mensal_alerta" DECIMAL(12,2) NOT NULL,
    "dia_fechamento" INTEGER NOT NULL,
    "dia_vencimento" INTEGER NOT NULL,

    CONSTRAINT "cartoes_credito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "nome" VARCHAR(60) NOT NULL,
    "tipo" "tipo_categoria" NOT NULL,
    "eh_essencial" BOOLEAN NOT NULL DEFAULT false,
    "orcamento_mensal" DECIMAL(12,2),

    CONSTRAINT "categorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transacoes" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "conta_id" UUID,
    "conta_destino_id" UUID,
    "cartao_id" UUID,
    "categoria_id" UUID,
    "recorrencia_id" UUID,
    "tipo" "tipo_transacao" NOT NULL,
    "valor" DECIMAL(12,2) NOT NULL,
    "descricao" VARCHAR(200) NOT NULL,
    "data_competencia" DATE NOT NULL,
    "status" "status_transacao" NOT NULL DEFAULT 'PAGO',
    "hash_dedup" VARCHAR(64),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recorrencias" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "conta_id" UUID,
    "cartao_id" UUID,
    "descricao" VARCHAR(150) NOT NULL,
    "valor_estimado" DECIMAL(12,2) NOT NULL,
    "dia_vencimento" INTEGER NOT NULL,
    "ativa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "recorrencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regras_aprendizado" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "termo_chave" VARCHAR(80) NOT NULL,
    "hits_confianca" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "regras_aprendizado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserva_emergencia" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "conta_cofre_id" UUID NOT NULL,
    "valor_meta_calculado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "saldo_acumulado" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "trava_resgate_ativa" BOOLEAN NOT NULL DEFAULT true,
    "status_gatilho" "status_gatilho" NOT NULL DEFAULT 'BLOQUEADO',
    "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserva_emergencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimentos_reserva" (
    "id" UUID NOT NULL,
    "reserva_id" UUID NOT NULL,
    "transacao_origem_id" UUID,
    "tipo" "tipo_movimento_reserva" NOT NULL,
    "valor" DECIMAL(12,2) NOT NULL,
    "justificativa_resgate" TEXT,
    "data_movimento" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimentos_reserva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alocacao_alvo" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "classe_ativo" "classe_ativo" NOT NULL,
    "percentual_ideal" DECIMAL(5,2) NOT NULL,
    "atualizado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alocacao_alvo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ativos_carteira" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "alocacao_id" UUID NOT NULL,
    "ticker_ou_nome" VARCHAR(60) NOT NULL,
    "quantidade" DECIMAL(14,6) NOT NULL,
    "valor_investido" DECIMAL(12,2) NOT NULL,
    "saldo_atual_mercado" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "ativos_carteira_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alertas_notificacoes" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "tipo_alerta" "tipo_alerta" NOT NULL,
    "mensagem" VARCHAR(255) NOT NULL,
    "canal" "canal_alerta" NOT NULL DEFAULT 'PUSH',
    "lido" BOOLEAN NOT NULL DEFAULT false,
    "enviado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alertas_notificacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "contas_usuario_id_idx" ON "contas"("usuario_id");

-- CreateIndex
CREATE INDEX "cartoes_credito_usuario_id_idx" ON "cartoes_credito"("usuario_id");

-- CreateIndex
CREATE INDEX "categorias_usuario_id_idx" ON "categorias"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_usuario_id_nome_tipo_key" ON "categorias"("usuario_id", "nome", "tipo");

-- CreateIndex
CREATE INDEX "transacoes_usuario_id_data_competencia_idx" ON "transacoes"("usuario_id", "data_competencia");

-- CreateIndex
CREATE INDEX "transacoes_usuario_id_tipo_status_idx" ON "transacoes"("usuario_id", "tipo", "status");

-- CreateIndex
CREATE INDEX "transacoes_cartao_id_data_competencia_idx" ON "transacoes"("cartao_id", "data_competencia");

-- CreateIndex
CREATE INDEX "recorrencias_usuario_id_ativa_idx" ON "recorrencias"("usuario_id", "ativa");

-- CreateIndex
CREATE INDEX "regras_aprendizado_usuario_id_idx" ON "regras_aprendizado"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "regras_aprendizado_usuario_id_termo_chave_key" ON "regras_aprendizado"("usuario_id", "termo_chave");

-- CreateIndex
CREATE UNIQUE INDEX "reserva_emergencia_usuario_id_key" ON "reserva_emergencia"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "movimentos_reserva_transacao_origem_id_key" ON "movimentos_reserva"("transacao_origem_id");

-- CreateIndex
CREATE INDEX "movimentos_reserva_reserva_id_data_movimento_idx" ON "movimentos_reserva"("reserva_id", "data_movimento");

-- CreateIndex
CREATE UNIQUE INDEX "alocacao_alvo_usuario_id_classe_ativo_key" ON "alocacao_alvo"("usuario_id", "classe_ativo");

-- CreateIndex
CREATE INDEX "ativos_carteira_usuario_id_alocacao_id_idx" ON "ativos_carteira"("usuario_id", "alocacao_id");

-- CreateIndex
CREATE INDEX "alertas_notificacoes_usuario_id_lido_enviado_em_idx" ON "alertas_notificacoes"("usuario_id", "lido", "enviado_em");

-- AddForeignKey
ALTER TABLE "contas" ADD CONSTRAINT "contas_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartoes_credito" ADD CONSTRAINT "cartoes_credito_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cartoes_credito" ADD CONSTRAINT "cartoes_credito_conta_pagamento_id_fkey" FOREIGN KEY ("conta_pagamento_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_conta_id_fkey" FOREIGN KEY ("conta_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_conta_destino_id_fkey" FOREIGN KEY ("conta_destino_id") REFERENCES "contas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_cartao_id_fkey" FOREIGN KEY ("cartao_id") REFERENCES "cartoes_credito"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_recorrencia_id_fkey" FOREIGN KEY ("recorrencia_id") REFERENCES "recorrencias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recorrencias" ADD CONSTRAINT "recorrencias_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recorrencias" ADD CONSTRAINT "recorrencias_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recorrencias" ADD CONSTRAINT "recorrencias_conta_id_fkey" FOREIGN KEY ("conta_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recorrencias" ADD CONSTRAINT "recorrencias_cartao_id_fkey" FOREIGN KEY ("cartao_id") REFERENCES "cartoes_credito"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_aprendizado" ADD CONSTRAINT "regras_aprendizado_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regras_aprendizado" ADD CONSTRAINT "regras_aprendizado_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserva_emergencia" ADD CONSTRAINT "reserva_emergencia_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserva_emergencia" ADD CONSTRAINT "reserva_emergencia_conta_cofre_id_fkey" FOREIGN KEY ("conta_cofre_id") REFERENCES "contas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentos_reserva" ADD CONSTRAINT "movimentos_reserva_reserva_id_fkey" FOREIGN KEY ("reserva_id") REFERENCES "reserva_emergencia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentos_reserva" ADD CONSTRAINT "movimentos_reserva_transacao_origem_id_fkey" FOREIGN KEY ("transacao_origem_id") REFERENCES "transacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alocacao_alvo" ADD CONSTRAINT "alocacao_alvo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ativos_carteira" ADD CONSTRAINT "ativos_carteira_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ativos_carteira" ADD CONSTRAINT "ativos_carteira_alocacao_id_fkey" FOREIGN KEY ("alocacao_id") REFERENCES "alocacao_alvo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alertas_notificacoes" ADD CONSTRAINT "alertas_notificacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Constraints CHECK e Índices Parciais de Integridade do DER (Etapa 0)
-- ============================================================================

-- USUARIOS
ALTER TABLE "usuarios"
  ADD CONSTRAINT "chk_usuarios_custo_vida_mensal_non_negative" CHECK ("custo_vida_mensal" >= 0),
  ADD CONSTRAINT "chk_usuarios_meses_reserva_alvo_range" CHECK ("meses_reserva_alvo" BETWEEN 3 AND 12),
  ADD CONSTRAINT "chk_usuarios_pct_pague_primeiro_range" CHECK ("pct_pague_primeiro" BETWEEN 0 AND 100),
  ADD CONSTRAINT "chk_usuarios_gatilho_invest_pct_range" CHECK ("gatilho_invest_pct" BETWEEN 0 AND 100);

-- CONTAS (no máximo uma conta padrão por usuário)
CREATE UNIQUE INDEX "uq_contas_usuario_conta_padrao"
  ON "contas" ("usuario_id")
  WHERE "eh_conta_padrao" = true;

-- CARTOES_CREDITO
ALTER TABLE "cartoes_credito"
  ADD CONSTRAINT "chk_cartoes_credito_limite_total_positive" CHECK ("limite_total" > 0),
  ADD CONSTRAINT "chk_cartoes_credito_teto_mensal_alerta_non_negative" CHECK ("teto_mensal_alerta" >= 0),
  ADD CONSTRAINT "chk_cartoes_credito_dia_fechamento_range" CHECK ("dia_fechamento" BETWEEN 1 AND 31),
  ADD CONSTRAINT "chk_cartoes_credito_dia_vencimento_range" CHECK ("dia_vencimento" BETWEEN 1 AND 31);

-- CATEGORIAS
ALTER TABLE "categorias"
  ADD CONSTRAINT "chk_categorias_orcamento_mensal_non_negative" CHECK ("orcamento_mensal" IS NULL OR "orcamento_mensal" >= 0);

-- TRANSACOES (exclusividade conta vs. cartão, regras de TRANSF e deduplicação OFX/CSV)
ALTER TABLE "transacoes"
  ADD CONSTRAINT "chk_transacoes_valor_positive" CHECK ("valor" > 0),
  ADD CONSTRAINT "chk_transacoes_conta_ou_cartao_xor" CHECK (
    ("conta_id" IS NOT NULL AND "cartao_id" IS NULL)
    OR ("conta_id" IS NULL AND "cartao_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "chk_transacoes_transf_rules" CHECK (
    ("tipo" <> 'TRANSF' AND "conta_destino_id" IS NULL)
    OR (
      "tipo" = 'TRANSF'
      AND "conta_id" IS NOT NULL
      AND "cartao_id" IS NULL
      AND ("conta_destino_id" IS NULL OR "conta_destino_id" <> "conta_id")
    )
  ),
  ADD CONSTRAINT "chk_transacoes_rec_only_conta" CHECK ("tipo" <> 'REC' OR "cartao_id" IS NULL);

CREATE UNIQUE INDEX "uq_transacoes_usuario_hash_dedup"
  ON "transacoes" ("usuario_id", "hash_dedup")
  WHERE "hash_dedup" IS NOT NULL;

-- RECORRENCIAS
ALTER TABLE "recorrencias"
  ADD CONSTRAINT "chk_recorrencias_conta_ou_cartao_xor" CHECK (
    ("conta_id" IS NOT NULL AND "cartao_id" IS NULL)
    OR ("conta_id" IS NULL AND "cartao_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "chk_recorrencias_valor_estimado_positive" CHECK ("valor_estimado" > 0),
  ADD CONSTRAINT "chk_recorrencias_dia_vencimento_range" CHECK ("dia_vencimento" BETWEEN 1 AND 31);

-- REGRAS_APRENDIZADO
ALTER TABLE "regras_aprendizado"
  ADD CONSTRAINT "chk_regras_aprendizado_hits_confianca_min" CHECK ("hits_confianca" >= 1);

-- RESERVA_EMERGENCIA
ALTER TABLE "reserva_emergencia"
  ADD CONSTRAINT "chk_reserva_emergencia_valor_meta_non_negative" CHECK ("valor_meta_calculado" >= 0),
  ADD CONSTRAINT "chk_reserva_emergencia_saldo_acumulado_non_negative" CHECK ("saldo_acumulado" >= 0);

-- MOVIMENTOS_RESERVA (trava auditável de justificativa >= 15 caracteres no resgate)
ALTER TABLE "movimentos_reserva"
  ADD CONSTRAINT "chk_movimentos_reserva_valor_positive" CHECK ("valor" > 0),
  ADD CONSTRAINT "chk_movimentos_reserva_resgate_justificativa" CHECK (
    "tipo" <> 'RESGATE'
    OR ("justificativa_resgate" IS NOT NULL AND char_length(btrim("justificativa_resgate")) >= 15)
  );

-- ALOCACAO_ALVO
ALTER TABLE "alocacao_alvo"
  ADD CONSTRAINT "chk_alocacao_alvo_percentual_ideal_range" CHECK ("percentual_ideal" >= 0 AND "percentual_ideal" <= 100);

-- ATIVOS_CARTEIRA
ALTER TABLE "ativos_carteira"
  ADD CONSTRAINT "chk_ativos_carteira_quantidade_non_negative" CHECK ("quantidade" >= 0),
  ADD CONSTRAINT "chk_ativos_carteira_valor_investido_non_negative" CHECK ("valor_investido" >= 0),
  ADD CONSTRAINT "chk_ativos_carteira_saldo_atual_mercado_non_negative" CHECK ("saldo_atual_mercado" >= 0);
