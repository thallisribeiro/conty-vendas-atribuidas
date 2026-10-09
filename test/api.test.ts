import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { orderPayload, refundPayload, setup } from './fixtures';

const post = (url: string, payload: object, headers: Record<string, string> = {}) => ({ method: 'POST' as const, url, payload, headers });

describe('API HTTP', () => {
  it('fluxo HTTP: estorno antes do pedido, pedido duplicado, estorno repetido e consultas', async () => {
    const app = buildApp({ sales: setup().sales });

    let res = await app.inject(post('/webhooks/refunds', refundPayload(1, '30.00')));
    expect(res.json()).toMatchObject({ status: 'pending' });
    res = await app.inject({ method: 'GET', url: '/orders/5745289543874' });
    expect(res.statusCode).toBe(404);
    expect(res.json().pendingRefunds).toHaveLength(1);

    res = await app.inject(post('/webhooks/orders', orderPayload()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'created', order: { netCents: 7000 } });

    res = await app.inject(post('/webhooks/orders', orderPayload()));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('duplicate');

    res = await app.inject(post('/webhooks/refunds', refundPayload(2, '20.00')));
    expect(res.json()).toMatchObject({ status: 'applied', refund: { appliedCents: 2000 } });
    res = await app.inject(post('/webhooks/refunds', refundPayload(2, '20.00')));
    expect(res.json().status).toBe('duplicate');

    res = await app.inject({ method: 'GET', url: '/orders/5745289543874' });
    expect(res.json()).toMatchObject({
      attribution: { creatorId: 'ana', source: 'coupon' },
      refundedCents: 5000,
      netCents: 5000,
    });
    expect(res.json().entries).toHaveLength(3);

    res = await app.inject({ method: 'GET', url: '/creators/ana/sales' });
    expect(res.json().totals).toEqual([{ currency: 'BRL', orders: 1, grossCents: 10000, refundedCents: 5000, netCents: 5000 }]);
    expect((await app.inject({ method: 'GET', url: '/creators/zeca/sales' })).statusCode).toBe(404);
  });

  it('payload inválido responde 400 com mensagem em português', async () => {
    const app = buildApp({ sales: setup().sales });
    const res = await app.inject(post('/webhooks/orders', orderPayload({ total_price: 100.5 })));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/total_price deve ser string decimal/);
    const bad = await app.inject({ method: 'POST', url: '/webhooks/orders', payload: '{', headers: { 'content-type': 'application/json' } });
    expect(bad.json()).toEqual({ error: 'JSON inválido' });
  });

  it('HMAC: com segredo configurado, rejeita assinatura ausente ou errada e aceita a assinatura do corpo cru', async () => {
    const secret = 'segredo';
    const app = buildApp({ sales: setup().sales, webhookSecret: secret });
    const body = JSON.stringify(orderPayload());
    const sign = (b: string) => createHmac('sha256', secret).update(b).digest('base64');
    const req = (hmac?: string) =>
      app.inject({ method: 'POST', url: '/webhooks/orders', payload: body, headers: { 'content-type': 'application/json', ...(hmac && { 'x-shopify-hmac-sha256': hmac }) } });

    expect((await req()).statusCode).toBe(401);
    expect((await req(sign(body + ' '))).statusCode).toBe(401);
    expect((await req(sign(body))).statusCode).toBe(200);
  });
});
