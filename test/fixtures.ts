import { MemoryRepository, Sales } from '../src/sales';

export const creators = [
  { id: 'ana', coupons: ['ANA10'], utmCampaign: 'conty-ana' },
  { id: 'bruno', coupons: ['BRUNO15'], utmCampaign: 'conty-bruno' },
];

/** Controlled clock: time only moves when the test says so. */
export function fakeClock(start = '2026-10-01T12:00:00.000Z') {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advanceDays: (d: number) => void (t += d * 86_400_000) };
}

export function setup() {
  const clock = fakeClock();
  return { clock, sales: new Sales(new MemoryRepository(), creators, clock) };
}

export function orderPayload(over: Record<string, unknown> = {}) {
  return {
    id: 5745289543874,
    name: '#1001',
    total_price: '100.00',
    currency: 'BRL',
    financial_status: 'paid',
    discount_codes: [{ code: 'ANA10', amount: '10.00', type: 'percentage' }],
    note_attributes: [],
    landing_site: '/products/tenis?utm_source=conty&utm_campaign=conty-bruno',
    ...over,
  };
}

export function refundPayload(id: number, amount: string, orderId = 5745289543874) {
  return {
    id,
    order_id: orderId,
    created_at: '2026-10-05T10:00:00-03:00',
    transactions: [{ id: id * 10, amount, currency: 'BRL', kind: 'refund', status: 'success' }],
  };
}
