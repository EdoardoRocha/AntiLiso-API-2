import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const DER_TABLES = [
  'usuarios',
  'contas',
  'cartoes_credito',
  'categorias',
  'transacoes',
  'recorrencias',
  'regras_aprendizado',
  'reserva_emergencia',
  'movimentos_reserva',
  'alocacao_alvo',
  'ativos_carteira',
  'alertas_notificacoes',
] as const;

const CRITICAL_CONSTRAINTS = [
  'chk_movimentos_reserva_resgate_justificativa',
  'chk_transacoes_conta_ou_cartao_xor',
  'chk_transacoes_transf_rules',
  'chk_recorrencias_conta_ou_cartao_xor',
  'uq_contas_usuario_conta_padrao',
  'uq_transacoes_usuario_hash_dedup',
] as const;

describe('Etapa 0 — /health e integridade do DER', () => {
  it('retorna 200 ok quando o banco responde', async () => {
    const app = await buildApp({
      checkDb: async () => true,
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
    expect(typeof body.timestamp).toBe('string');

    await app.close();
  });

  it('retorna 503 degraded quando o banco está indisponível', async () => {
    const app = await buildApp({
      checkDb: async () => false,
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.database).toBe('down');

    await app.close();
  });

  it('contém todas as 12 tabelas do DER no schema.prisma e na migration SQL', () => {
    const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
    const migrationPath = path.resolve(
      process.cwd(),
      'prisma/migrations/20261122000000_init_der/migration.sql',
    );

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    for (const table of DER_TABLES) {
      expect(schemaSql).toContain(`@@map("${table}")`);
      expect(migrationSql).toContain(`CREATE TABLE "${table}"`);
    }

    for (const constraint of CRITICAL_CONSTRAINTS) {
      expect(migrationSql).toContain(constraint);
    }
  });

  it('responde preflight CORS permitindo PATCH e DELETE', async () => {
    const app = await buildApp({
      checkDb: async () => true,
      logger: false,
    });

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/accounts/00000000-0000-0000-0000-000000000000',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    const allowMethods = String(response.headers['access-control-allow-methods'] ?? '');
    expect(allowMethods).toContain('PATCH');
    expect(allowMethods).toContain('DELETE');

    await app.close();
  });
});
