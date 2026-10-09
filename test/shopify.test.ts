import { describe, expect, it } from 'vitest';
import { parseOrder, parseRefund, toCents } from '../src/shopify';
import { orderPayload, refundPayload } from './fixtures';

describe('payload Shopify', () => {
  it('converte a string decimal do webhook em centavos inteiros sem passar por float', () => {
    expect(toCents('199.90', 'x')).toBe(19990);
    expect(toCents('0.29', 'x')).toBe(29); // 0.29 * 100 em float dá 28.999999999999996
    expect(toCents('1.1', 'x')).toBe(110);
    expect(toCents('10', 'x')).toBe(1000);
    expect(toCents('1234567.89', 'x')).toBe(123456789);
  });

  it('rejeita valor negativo, com 3 casas, com vírgula ou numérico em vez de string', () => {
    for (const bad of ['-1.00', '1.999', '1,50', '', 19.9]) expect(() => toCents(bad, 'total_price')).toThrow(/total_price/);
  });

  it('lê cupom e utm_campaign do landing_site; note_attributes tem prioridade quando existe', () => {
    expect(parseOrder(orderPayload())).toMatchObject({ id: '5745289543874', totalCents: 10000, currency: 'BRL', discountCodes: ['ANA10'], utmCampaign: 'conty-bruno' });
    const withNote = orderPayload({ note_attributes: [{ name: 'utm_campaign', value: 'conty-ana' }] });
    expect(parseOrder(withNote).utmCampaign).toBe('conty-ana');
  });

  it('rejeita pedido sem moeda ISO e id grande demais para número JSON', () => {
    expect(() => parseOrder(orderPayload({ currency: 'real' }))).toThrow(/currency/);
    expect(() => parseOrder(orderPayload({ id: 820982911946154508 }))).toThrow(/id/);
    expect(parseOrder(orderPayload({ id: '820982911946154508' })).id).toBe('820982911946154508');
  });

  it('valor do estorno é a soma das transações refund com sucesso', () => {
    const body = refundPayload(1, '30.00');
    body.transactions.push(
      { id: 2, amount: '20.00', currency: 'BRL', kind: 'refund', status: 'success' },
      { id: 3, amount: '99.00', currency: 'BRL', kind: 'refund', status: 'failure' },
    );
    expect(parseRefund(body)).toEqual({ id: '1', orderId: '5745289543874', amountCents: 5000 });
  });

  it('rejeita estorno cuja soma passa do maior inteiro seguro', () => {
    const body = refundPayload(1, '90071992547409.91');
    body.transactions.push({ id: 2, amount: '90071992547409.91', currency: 'BRL', kind: 'refund', status: 'success' });
    expect(() => parseRefund(body)).toThrow(/grande demais/);
  });
});
