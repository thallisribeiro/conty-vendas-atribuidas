import { attribute, type Attribution, type Creator } from './attribution';
import { parseOrder, parseRefund } from './shopify';

export type Clock = { now(): Date };

/** The sale ledger line. Immutable once stored. */
export type Order = {
  id: string;
  currency: string;
  totalCents: number;
  financialStatus: string;
  attribution: Attribution;
  receivedAt: string;
};

/** The refund ledger line. Only transition: pending -> applied. Nothing is ever deleted. */
export type Refund = {
  id: string;
  orderId: string;
  requestedCents: number;
  receivedAt: string;
  status: 'pending' | 'applied';
  pendingReason: string | null; // why it waited; kept after it is applied
  appliedCents: number | null; // <= requestedCents: capped to what was left of the order
  appliedAt: string | null;
};

export interface Repository {
  getOrder(id: string): Order | undefined;
  addOrder(order: Order): void;
  getRefund(id: string): Refund | undefined;
  saveRefund(refund: Refund): void;
  refundsOf(orderId: string): Refund[]; // arrival order
  ordersOf(creatorId: string): Order[];
}

export class MemoryRepository implements Repository {
  private orders = new Map<string, Order>();
  private refunds = new Map<string, Refund>();
  getOrder = (id: string) => this.orders.get(id);
  addOrder = (order: Order) => void this.orders.set(order.id, order);
  getRefund = (id: string) => this.refunds.get(id);
  saveRefund = (refund: Refund) => void this.refunds.set(refund.id, refund);
  // ponytail: full scans; a database indexes refunds.order_id and orders.creator_id
  refundsOf = (orderId: string) => [...this.refunds.values()].filter((r) => r.orderId === orderId);
  ordersOf = (creatorId: string) => [...this.orders.values()].filter((o) => o.attribution.creatorId === creatorId);
}

// Statuses where money was captured. Others (pending, authorized, voided...) are not a sale yet.
const PAID = new Set(['paid', 'partially_refunded', 'refunded']);

export class Sales {
  constructor(
    private repo: Repository,
    private creators: Creator[],
    private clock: Clock,
  ) {}

  // Each method runs synchronously to the end, so in a single Node process webhooks never interleave.
  receiveOrder(body: unknown) {
    const p = parseOrder(body);
    const existing = this.repo.getOrder(p.id);
    if (existing) return { status: 'duplicate' as const, order: this.orderView(existing) };
    if (!PAID.has(p.financialStatus)) {
      return { status: 'ignored' as const, reason: `financial_status "${p.financialStatus}" não é venda paga; nada foi contabilizado` };
    }

    const order: Order = {
      id: p.id,
      currency: p.currency,
      totalCents: p.totalCents,
      financialStatus: p.financialStatus,
      attribution: attribute(p, this.creators),
      receivedAt: this.clock.now().toISOString(),
    };
    this.repo.addOrder(order);
    for (const refund of this.repo.refundsOf(order.id)) if (refund.status === 'pending') this.apply(order, refund);
    return { status: 'created' as const, order: this.orderView(order) };
  }

  receiveRefund(body: unknown) {
    const p = parseRefund(body);
    const existing = this.repo.getRefund(p.id);
    if (existing) return { status: 'duplicate' as const, refund: existing };

    const refund: Refund = {
      id: p.id,
      orderId: p.orderId,
      requestedCents: p.amountCents,
      receivedAt: this.clock.now().toISOString(),
      status: 'pending',
      pendingReason: null,
      appliedCents: null,
      appliedAt: null,
    };
    const order = this.repo.getOrder(p.orderId);
    if (order) this.apply(order, refund);
    else refund.pendingReason = `pedido ${p.orderId} ainda não recebido; aplicado quando o pedido chegar`;
    this.repo.saveRefund(refund);
    return { status: refund.status, refund };
  }

  /** Caps the refund to what is left, so refunds never add up to more than the sale. */
  private apply(order: Order, refund: Refund) {
    const left = order.totalCents - this.refundedCents(order.id);
    refund.appliedCents = Math.min(refund.requestedCents, left);
    refund.status = 'applied';
    refund.appliedAt = this.clock.now().toISOString();
    this.repo.saveRefund(refund);
  }

  private refundedCents(orderId: string) {
    return this.repo.refundsOf(orderId).reduce((sum, r) => sum + (r.appliedCents ?? 0), 0);
  }

  order(id: string) {
    const order = this.repo.getOrder(id);
    return order && this.orderView(order);
  }

  pendingRefunds(orderId: string) {
    return this.repo.refundsOf(orderId).filter((r) => r.status === 'pending');
  }

  private orderView(order: Order) {
    const refunds = this.repo.refundsOf(order.id).filter((r) => r.status === 'applied');
    const entries = [
      { type: 'sale', id: `order:${order.id}`, amountCents: order.totalCents, at: order.receivedAt },
      ...refunds.map((r) => ({
        type: 'refund',
        id: r.id,
        amountCents: -r.appliedCents!,
        requestedCents: r.requestedCents,
        rejectedCents: r.requestedCents - r.appliedCents!,
        receivedAt: r.receivedAt,
        at: r.appliedAt,
        pendingReason: r.pendingReason,
      })),
    ];
    const refundedCents = this.refundedCents(order.id);
    return { ...order, entries, refundedCents, netCents: order.totalCents - refundedCents };
  }

  creatorSales(creatorId: string) {
    if (!this.creators.some((c) => c.id === creatorId)) return undefined;
    const orders = this.repo.ordersOf(creatorId).map((o) => this.orderView(o));
    const totals = new Map<string, { currency: string; orders: number; grossCents: number; refundedCents: number; netCents: number }>();
    for (const o of orders) {
      const t = totals.get(o.currency) ?? { currency: o.currency, orders: 0, grossCents: 0, refundedCents: 0, netCents: 0 };
      t.orders += 1;
      t.grossCents += o.totalCents;
      t.refundedCents += o.refundedCents;
      t.netCents += o.netCents;
      totals.set(o.currency, t);
    }
    return {
      creatorId,
      totals: [...totals.values()],
      orders: orders.map((o) => ({
        orderId: o.id,
        currency: o.currency,
        totalCents: o.totalCents,
        refundedCents: o.refundedCents,
        netCents: o.netCents,
        source: o.attribution.source,
      })),
    };
  }
}
