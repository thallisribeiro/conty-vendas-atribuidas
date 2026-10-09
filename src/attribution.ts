export type Creator = { id: string; coupons: string[]; utmCampaign: string };

export type AttributionInput = { discountCodes: string[]; utmCampaign: string | null };

export type Attribution = {
  creatorId: string | null;
  source: 'coupon' | 'utm' | 'none';
  reason: string;
};

/**
 * The only attribution rule. At most one creator per order:
 * 1. Coupon wins: the first code in `discount_codes` that belongs to a creator.
 *    The buyer typed it at checkout; a UTM may come from an old click or another creator's link.
 * 2. Otherwise utm_campaign, if it belongs to a creator.
 * 3. Otherwise nobody.
 * Coupons and UTMs are compared trimmed and case-insensitive.
 */
export function attribute(order: AttributionInput, creators: Creator[]): Attribution {
  const norm = (s: string) => s.trim().toLowerCase();
  const couponOwner = (code: string) => creators.find((c) => c.coupons.some((k) => norm(k) === norm(code)));
  const utm = order.utmCampaign ? norm(order.utmCampaign) : null;
  const utmOwner = utm ? creators.find((c) => norm(c.utmCampaign) === utm) : undefined;

  const couponHits = order.discountCodes.flatMap((code) => {
    const creator = couponOwner(code);
    return creator ? [{ code, creator }] : [];
  });

  if (couponHits.length > 0) {
    const { code, creator } = couponHits[0];
    const notes = [`cupom ${code} pertence a ${creator.id}`];
    const others = couponHits.filter((h) => h.creator.id !== creator.id).map((h) => h.code);
    if (others.length) notes.push(`vale o primeiro cupom de criador; ignorados: ${others.join(', ')}`);
    if (utmOwner && utmOwner.id !== creator.id) notes.push(`cupom vence a UTM ${utm} (de ${utmOwner.id})`);
    return { creatorId: creator.id, source: 'coupon', reason: notes.join('; ') };
  }

  if (utmOwner) {
    const notes = [`utm_campaign ${utm} pertence a ${utmOwner.id}`];
    if (order.discountCodes.length) notes.push(`cupom ${order.discountCodes.join(', ')} não é de nenhum criador`);
    return { creatorId: utmOwner.id, source: 'utm', reason: notes.join('; ') };
  }

  return { creatorId: null, source: 'none', reason: 'nenhum cupom ou UTM de criador' };
}
