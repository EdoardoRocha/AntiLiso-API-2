import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildApp,
  createServerlessHandler,
  parseCorsOrigins,
  type ServerlessRequestHandler,
} from '../app.js';
import { parseEnv } from '../config/env.js';
import serverlessDefault from '../serverless.js';

interface InvokeOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
}

interface InvokeResult {
  status: number;
  headers: http.OutgoingHttpHeaders;
  bodyText: string;
  json: <T>() => T;
}

async function invokeHandler(
  handler: ServerlessRequestHandler,
  options: InvokeOptions,
): Promise<InvokeResult> {
  const socket = new PassThrough();
  const req = new http.IncomingMessage(socket as never);
  req.method = options.method ?? 'GET';
  req.url = options.url;
  req.headers = {
    host: 'antiliso-api.vercel.app',
    'x-forwarded-proto': 'https',
    ...(options.headers ?? {}),
  };

  const res = new http.ServerResponse(req);
  const bodyChunks: Buffer[] = [];
  const headHeaders: Record<string, string | string[] | number> = {};

  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.writeHead = ((
    statusCode: number,
    statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    headersArg?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
  ) => {
    const rawHeaders =
      typeof statusMessageOrHeaders === 'object' && statusMessageOrHeaders !== null
        ? statusMessageOrHeaders
        : headersArg;
    if (rawHeaders && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        if (value !== undefined) {
          headHeaders[key.toLowerCase()] = value;
        }
      }
    }
    return originalWriteHead(statusCode, statusMessageOrHeaders as never, headersArg as never);
  }) as typeof res.writeHead;

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const responseDone = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  res.on('error', rejectDone);

  res.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ) => {
    if (typeof chunk === 'string') {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
      bodyChunks.push(Buffer.from(chunk, encoding));
    } else if (chunk) {
      bodyChunks.push(Buffer.from(chunk));
    }
    return originalWrite(chunk, encodingOrCb as never, cb);
  }) as typeof res.write;

  res.end = ((
    chunkOrCb?: string | Uint8Array | (() => void),
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ) => {
    if (typeof chunkOrCb === 'string') {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
      bodyChunks.push(Buffer.from(chunkOrCb, encoding));
    } else if (chunkOrCb && typeof chunkOrCb !== 'function') {
      bodyChunks.push(Buffer.from(chunkOrCb));
    }
    const result = originalEnd(chunkOrCb as never, encodingOrCb as never, cb);
    resolveDone();
    return result;
  }) as typeof res.end;

  await handler(req, res);
  req.push(null);
  await responseDone;

  const bodyText = Buffer.concat(bodyChunks).toString('utf8');
  const capturedHeaders: http.OutgoingHttpHeaders = {
    ...res.getHeaders(),
    ...headHeaders,
  };
  socket.destroy();

  return {
    status: res.statusCode,
    headers: capturedHeaders,
    bodyText,
    json: <T>() => JSON.parse(bodyText) as T,
  };
}

describe('Adaptação Serverless Vercel', () => {
  const createdApps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (createdApps.length > 0) {
      const app = createdApps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it('exporta handler padrão funcional em src/serverless.ts', () => {
    expect(typeof serverlessDefault).toBe('function');
  });

  it('responde 200 na rota raiz GET / via handler serverless', async () => {
    const handler = createServerlessHandler(
      { checkDb: async () => true, logger: false },
      async (opts) => {
        const app = await buildApp(opts);
        createdApps.push(app);
        return app;
      },
    );

    const response = await invokeHandler(handler, { url: '/' });
    expect(response.status).toBe(200);
    expect(response.json<{ name: string; status: string; health: string }>()).toEqual({
      name: 'AntiLiso API',
      status: 'ok',
      health: '/health',
    });
  });

  it('responde 200 em GET /health via handler serverless', async () => {
    const handler = createServerlessHandler(
      { checkDb: async () => true, logger: false },
      async (opts) => {
        const app = await buildApp(opts);
        createdApps.push(app);
        return app;
      },
    );

    const response = await invokeHandler(handler, { url: '/health' });
    expect(response.status).toBe(200);
    const body = response.json<{ status: string; database: string }>();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('up');
  });

  it('normaliza barras finais de CORS_ORIGIN no preflight OPTIONS', async () => {
    expect(parseCorsOrigins('https://app.vercel.app/, http://localhost:3000/// ')).toEqual([
      'https://app.vercel.app',
      'http://localhost:3000',
    ]);

    const handler = createServerlessHandler(
      {
        checkDb: async () => true,
        logger: false,
        corsOrigin: 'https://antiliso-web.vercel.app/',
      },
      async (opts) => {
        const app = await buildApp(opts);
        createdApps.push(app);
        return app;
      },
    );

    const response = await invokeHandler(handler, {
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://antiliso-web.vercel.app',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://antiliso-web.vercel.app');
  });

  it('reutiliza a mesma instância Fastify entre requisições concorrentes', async () => {
    const appFactory = vi.fn(async (opts) => {
      const app = await buildApp(opts);
      createdApps.push(app);
      return app;
    });

    const handler = createServerlessHandler(
      { checkDb: async () => true, logger: false },
      appFactory,
    );

    const [r1, r2, r3] = await Promise.all([
      invokeHandler(handler, { url: '/' }),
      invokeHandler(handler, { url: '/health' }),
      invokeHandler(handler, { url: '/' }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(appFactory).toHaveBeenCalledTimes(1);
  });

  it('limpa o cache e se recupera se a inicialização falhar no cold start', async () => {
    let attempts = 0;
    const appFactory = vi.fn(async (opts) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Falha simulada no cold start');
      }
      const app = await buildApp(opts);
      createdApps.push(app);
      return app;
    });

    const handler = createServerlessHandler(
      { checkDb: async () => true, logger: false },
      appFactory,
    );

    await expect(handler({} as http.IncomingMessage, {} as http.ServerResponse)).rejects.toThrow(
      'Falha simulada no cold start',
    );

    const response = await invokeHandler(handler, { url: '/' });
    expect(response.status).toBe(200);
    expect(appFactory).toHaveBeenCalledTimes(2);
  });

  it('rejeita variáveis de ambiente inválidas em parseEnv sem logar objeto sintético', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      parseEnv({
        DATABASE_URL: '',
        JWT_SECRET: 'curto',
      }),
    ).toThrow();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
