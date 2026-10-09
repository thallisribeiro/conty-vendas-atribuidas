import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Sales } from './sales';
import { ValidationError } from './shopify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/** Shopify signs the raw body: base64(HMAC-SHA256(secret, body)) in X-Shopify-Hmac-Sha256. */
export function validHmac(secret: string, rawBody: Buffer, header: unknown): boolean {
  if (typeof header !== 'string') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(header, 'base64');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function buildApp({ sales, webhookSecret }: { sales: Sales; webhookSecret?: string }) {
  const app = Fastify();

  // Keep the raw bytes: the HMAC is computed over them, not over re-serialized JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    const code = err.statusCode ?? 500;
    return reply.code(code).send({ error: code >= 500 ? 'erro interno' : err.message });
  });

  // Optional, as in Shopify: only enforced when a secret is configured.
  const verifyHmac = async (req: FastifyRequest, reply: FastifyReply) => {
    if (webhookSecret && !validHmac(webhookSecret, req.rawBody ?? Buffer.alloc(0), req.headers['x-shopify-hmac-sha256'])) {
      return reply.code(401).send({ error: 'assinatura HMAC inválida' });
    }
  };

  app.post('/webhooks/orders', { preHandler: verifyHmac }, async (req) => sales.receiveOrder(req.body));
  app.post('/webhooks/refunds', { preHandler: verifyHmac }, async (req) => sales.receiveRefund(req.body));

  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const order = sales.order(req.params.id);
    if (order) return order;
    return reply.code(404).send({ error: 'pedido não encontrado', pendingRefunds: sales.pendingRefunds(req.params.id) });
  });

  app.get<{ Params: { id: string } }>('/creators/:id/sales', async (req, reply) => {
    return sales.creatorSales(req.params.id) ?? reply.code(404).send({ error: 'criador não encontrado' });
  });

  return app;
}
