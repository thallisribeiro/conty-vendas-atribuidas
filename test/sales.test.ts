import { describe, expect, it } from 'vitest';
import { orderPayload, refundPayload, setup } from './fixtures';

const ORDER = '5745289543874';

describe('pedido', () => {
  it('webhook de pedido repetido não soma a venda de novo e responde duplicado', () => {
    const { sales } = setup();
    expect(sales.receiveOrder(orderPayload()).status).toBe('created');
    expect(sales.receiveOrder(orderPayload()).status).toBe('duplicate');
    expect(sales.creatorSales('ana')!.totals).toEqual([{ currency: 'BRL', orders: 1, grossCents: 10000, refundedCents: 0, netCents: 10000 }]);
    expect(sales.order(ORDER)!.entries).toHaveLength(1);
  });

  it('pedido ainda não pago (financial_status pending) é ignorado e entra quando chega como paid', () => {
    const { sales } = setup();
    expect(sales.receiveOrder(orderPayload({ financial_status: 'pending' })).status).toBe('ignored');
    expect(sales.order(ORDER)).toBeUndefined();
    expect(sales.receiveOrder(orderPayload()).status).toBe('created');
  });

  it('venda guarda moeda e valor em centavos e a atribuição com o motivo', () => {
    const { sales } = setup();
    const { order } = sales.receiveOrder(orderPayload({ total_price: '199.90', currency: 'USD' }));
    expect(order).toMatchObject({ currency: 'USD', totalCents: 19990, netCents: 19990, attribution: { creatorId: 'ana', source: 'coupon' } });
  });
});

describe('estorno', () => {
  it('estorno parcial vira lançamento negativo e reduz o líquido sem apagar a venda', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload());
    expect(sales.receiveRefund(refundPayload(1, '30.00')).status).toBe('applied');
    const order = sales.order(ORDER)!;
    expect(order.entries.map((e) => [e.type, e.amountCents])).toEqual([['sale', 10000], ['refund', -3000]]);
    expect(order).toMatchObject({ refundedCents: 3000, netCents: 7000 });
  });

  it('estorno repetido com o mesmo id não é aplicado duas vezes', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload());
    sales.receiveRefund(refundPayload(1, '30.00'));
    expect(sales.receiveRefund(refundPayload(1, '30.00')).status).toBe('duplicate');
    expect(sales.order(ORDER)).toMatchObject({ refundedCents: 3000, netCents: 7000 });
  });

  it('vários estornos parciais com ids diferentes somam', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload());
    sales.receiveRefund(refundPayload(1, '30.00'));
    sales.receiveRefund(refundPayload(2, '25.50'));
    expect(sales.order(ORDER)).toMatchObject({ refundedCents: 5550, netCents: 4450 });
  });

  it('estorno total deixa o líquido do criador em zero, mas a venda e a atribuição continuam no histórico', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload());
    sales.receiveRefund(refundPayload(1, '100.00'));
    expect(sales.order(ORDER)).toMatchObject({ totalCents: 10000, netCents: 0, attribution: { creatorId: 'ana' } });
    expect(sales.creatorSales('ana')!.totals[0]).toMatchObject({ orders: 1, grossCents: 10000, refundedCents: 10000, netCents: 0 });
  });

  it('soma dos estornos nunca passa do valor da venda: excedente é limitado ao saldo e fica registrado', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload());
    sales.receiveRefund(refundPayload(1, '80.00'));
    const { refund } = sales.receiveRefund(refundPayload(2, '50.00'));
    expect(refund).toMatchObject({ requestedCents: 5000, appliedCents: 2000 });
    expect(sales.order(ORDER)!.entries[2]).toMatchObject({ amountCents: -2000, requestedCents: 5000, rejectedCents: 3000 });
    expect(sales.receiveRefund(refundPayload(3, '1.00')).refund.appliedCents).toBe(0);
    expect(sales.order(ORDER)).toMatchObject({ refundedCents: 10000, netCents: 0 });
  });
});

describe('estorno que chega antes do pedido', () => {
  it('fica pendente com motivo e é aplicado quando o pedido chega', () => {
    const { sales, clock } = setup();
    const r = sales.receiveRefund(refundPayload(1, '40.00'));
    expect(r.status).toBe('pending');
    expect(r.refund.pendingReason).toMatch(/ainda não recebido/);
    expect(sales.pendingRefunds(ORDER)).toHaveLength(1);

    clock.advanceDays(2);
    sales.receiveOrder(orderPayload());
    const order = sales.order(ORDER)!;
    expect(order).toMatchObject({ refundedCents: 4000, netCents: 6000 });
    expect(order.entries[1]).toMatchObject({ id: '1', receivedAt: '2026-10-01T12:00:00.000Z', at: '2026-10-03T12:00:00.000Z' });
    expect(sales.pendingRefunds(ORDER)).toHaveLength(0);
  });

  it('pendente repetido continua um só e é aplicado uma vez', () => {
    const { sales } = setup();
    sales.receiveRefund(refundPayload(1, '40.00'));
    expect(sales.receiveRefund(refundPayload(1, '40.00')).status).toBe('duplicate');
    expect(sales.pendingRefunds(ORDER)).toHaveLength(1);
    sales.receiveOrder(orderPayload());
    expect(sales.order(ORDER)).toMatchObject({ refundedCents: 4000, netCents: 6000 });
  });

  it('pendentes que passam do valor do pedido são limitados ao saldo quando o pedido chega', () => {
    const { sales } = setup();
    sales.receiveRefund(refundPayload(1, '70.00'));
    sales.receiveRefund(refundPayload(2, '70.00'));
    sales.receiveOrder(orderPayload());
    const order = sales.order(ORDER)!;
    expect(order.entries.slice(1).map((e) => [e.id, e.amountCents])).toEqual([['1', -7000], ['2', -3000]]);
    expect(order).toMatchObject({ refundedCents: 10000, netCents: 0 });
  });

  it('pedido repetido depois do estorno pendente não aplica o estorno de novo', () => {
    const { sales } = setup();
    sales.receiveRefund(refundPayload(1, '40.00'));
    sales.receiveOrder(orderPayload());
    sales.receiveOrder(orderPayload());
    expect(sales.order(ORDER)).toMatchObject({ refundedCents: 4000, netCents: 6000 });
  });
});

describe('vendas do criador', () => {
  it('soma bruto, estornado e líquido por moeda, só dos pedidos atribuídos a ele', () => {
    const { sales } = setup();
    sales.receiveOrder(orderPayload({ id: 1, total_price: '100.00' }));
    sales.receiveOrder(orderPayload({ id: 2, total_price: '50.00', currency: 'USD' }));
    sales.receiveOrder(orderPayload({ id: 3, discount_codes: [] })); // vai para bruno pela UTM
    sales.receiveRefund(refundPayload(9, '10.00', 1));
    const ana = sales.creatorSales('ana')!;
    expect(ana.totals).toEqual([
      { currency: 'BRL', orders: 1, grossCents: 10000, refundedCents: 1000, netCents: 9000 },
      { currency: 'USD', orders: 1, grossCents: 5000, refundedCents: 0, netCents: 5000 },
    ]);
    expect(sales.creatorSales('bruno')!.orders).toEqual([{ orderId: '3', currency: 'BRL', totalCents: 10000, refundedCents: 0, netCents: 10000, source: 'utm' }]);
    expect(sales.creatorSales('desconhecido')).toBeUndefined();
  });
});
