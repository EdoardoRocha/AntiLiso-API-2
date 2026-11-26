import { buildApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './infra/database/prisma.js';

async function start(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Encerrando servidor...');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API AntiLiso rodando em http://${env.HOST}:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

if (!process.env.VERCEL) {
  void start();
}

export { default } from './serverless.js';
