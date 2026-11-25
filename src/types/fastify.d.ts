import '@fastify/jwt';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      type: 'access' | 'refresh';
    };
    user: {
      sub: string;
      type: 'access' | 'refresh';
    };
  }
}
