import type { AttributionInput } from './attribution';

// Parsing of the essential fields of Shopify's orders/create and refunds/create webhooks.

export class ValidationError extends Error {}

export type ParsedOrder = AttributionInput & {
  id: string;
  totalCents: number;
  currency: string;
  financialStatus: string;
};

export type ParsedRefund = { id: string; orderId: string; amountCents: number };

type Json = Record<string, any>;

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/** "199.90" -> 19990. Never goes through float: integer part and cents are parsed separately. */
export function toCents(value: unknown, field: string): number {
  if (typeof value !== 'string' || !AMOUNT.test(value)) {
    throw new ValidationError(`${field} deve ser string decimal não negativa com até 2 casas, ex.: "199.90"`);
  }
  const [int, frac = ''] = value.split('.');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new ValidationError(`${field} grande demais`);
  return cents;
}

function toId(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new ValidationError(`${field} deve ser inteiro positivo (até 2^53) ou string`);
}

function asObject(body: unknown): Json {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('corpo deve ser um objeto JSON');
  return body as Json;
}

/** utm_campaign from note_attributes (captured at checkout) or, failing that, from landing_site's query string. */
function utmCampaign(o: Json): string | null {
  const attrs: unknown[] = Array.isArray(o.note_attributes) ? o.note_attributes : [];
  const fromNote = (attrs.find((a: any) => a?.name === 'utm_campaign') as Json | undefined)?.value;
  if (typeof fromNote === 'string' && fromNote.trim()) return fromNote.trim();
  if (typeof o.landing_site !== 'string') return null;
  try {
    return new URL(o.landing_site, 'https://loja.invalid').searchParams.get('utm_campaign') || null;
  } catch {
    return null;
  }
}

export function parseOrder(body: unknown): ParsedOrder {
  const o = asObject(body);
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) {
    throw new ValidationError('currency deve ser código ISO 4217, ex.: "BRL"');
  }
  if (typeof o.financial_status !== 'string') throw new ValidationError('financial_status é obrigatório');
  const codes = o.discount_codes ?? [];
  if (!Array.isArray(codes)) throw new ValidationError('discount_codes deve ser uma lista');
  return {
    id: toId(o.id, 'id'),
    totalCents: toCents(o.total_price, 'total_price'),
    currency: o.currency,
    financialStatus: o.financial_status,
    discountCodes: codes.map((d: any) => d?.code).filter((c): c is string => typeof c === 'string' && c.trim() !== ''),
    utmCampaign: utmCampaign(o),
  };
}

/** Refund amount = sum of successful refund transactions, in the order's currency. */
export function parseRefund(body: unknown): ParsedRefund {
  const r = asObject(body);
  if (!Array.isArray(r.transactions)) throw new ValidationError('transactions deve ser uma lista');
  const amountCents = r.transactions
    .filter((t: any) => t?.kind === 'refund' && t?.status === 'success')
    .reduce((sum: number, t: Json) => sum + toCents(t.amount, 'transactions[].amount'), 0);
  if (!Number.isSafeInteger(amountCents)) throw new ValidationError('valor do estorno grande demais');
  if (amountCents <= 0) throw new ValidationError('estorno precisa de transação kind "refund", status "success" e valor maior que zero');
  return { id: toId(r.id, 'id'), orderId: toId(r.order_id, 'order_id'), amountCents };
}
