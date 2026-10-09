import { describe, expect, it } from 'vitest';
import { attribute } from '../src/attribution';
import { creators } from './fixtures';

describe('attribute(order, creators): regra única de atribuição', () => {
  it('cupom e UTM de criadores diferentes: o cupom vence e o motivo diz que a UTM foi ignorada', () => {
    const a = attribute({ discountCodes: ['ANA10'], utmCampaign: 'conty-bruno' }, creators);
    expect(a).toEqual({
      creatorId: 'ana',
      source: 'coupon',
      reason: 'cupom ANA10 pertence a ana; cupom vence a UTM conty-bruno (de bruno)',
    });
  });

  it('só cupom: atribui ao dono do cupom', () => {
    expect(attribute({ discountCodes: ['BRUNO15'], utmCampaign: null }, creators)).toMatchObject({ creatorId: 'bruno', source: 'coupon' });
  });

  it('só UTM: atribui ao dono da utm_campaign', () => {
    expect(attribute({ discountCodes: [], utmCampaign: 'conty-ana' }, creators)).toMatchObject({ creatorId: 'ana', source: 'utm' });
  });

  it('nem cupom nem UTM de criador: venda fica sem criador', () => {
    expect(attribute({ discountCodes: [], utmCampaign: 'black-friday' }, creators)).toEqual({
      creatorId: null,
      source: 'none',
      reason: 'nenhum cupom ou UTM de criador',
    });
  });

  it('cupom desconhecido com UTM válida: atribui pela UTM', () => {
    expect(attribute({ discountCodes: ['FRETEGRATIS'], utmCampaign: 'conty-bruno' }, creators)).toEqual({
      creatorId: 'bruno',
      source: 'utm',
      reason: 'utm_campaign conty-bruno pertence a bruno; cupom FRETEGRATIS não é de nenhum criador',
    });
  });

  it('dois cupons de criadores diferentes: vale o primeiro da lista discount_codes', () => {
    const a = attribute({ discountCodes: ['FRETEGRATIS', 'BRUNO15', 'ANA10'], utmCampaign: null }, creators);
    expect(a).toMatchObject({ creatorId: 'bruno', source: 'coupon' });
    expect(a.reason).toContain('ignorados: ANA10');
  });

  it('cupom e UTM são comparados sem diferenciar maiúsculas e espaços', () => {
    expect(attribute({ discountCodes: [' ana10 '], utmCampaign: null }, creators).creatorId).toBe('ana');
    expect(attribute({ discountCodes: [], utmCampaign: 'Conty-Bruno' }, creators).creatorId).toBe('bruno');
  });
});
