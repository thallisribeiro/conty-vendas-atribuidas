# Vendas atribuídas ao criador

API que recebe webhooks de pedido e de estorno no formato essencial da Shopify e atribui cada venda a no máximo um criador (por cupom ou UTM).
Pedido repetido não soma de novo, estorno vira lançamento rastreável (nunca passa do valor da venda) e estorno que chega antes do pedido fica pendente até o pedido chegar.

## Como rodar e testar

Node >= 22.12 (exigência do vitest 5).

```bash
npm ci
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm start           # sobe em http://localhost:3000 (PORT muda a porta)
```

Dados em memória. Os criadores ficam fixos em `src/server.ts`: `ana` (cupom `ANA10`, `utm_campaign=conty-ana`) e `bruno` (cupom `BRUNO15`, `utm_campaign=conty-bruno`).
Com `SHOPIFY_WEBHOOK_SECRET` definido, os webhooks exigem o header `X-Shopify-Hmac-Sha256` (ver Regras).

## Exemplos (executados contra a API, nesta ordem)

**1. Estorno chega antes do pedido: fica pendente, com motivo**

```bash
curl -s -X POST localhost:3000/webhooks/refunds -H 'content-type: application/json' \
  -d '{"id":900,"order_id":5745289543874,"transactions":[{"amount":"30.00","currency":"BRL","kind":"refund","status":"success"}]}'
```

```json
{
  "status": "pending",
  "refund": {
    "id": "900", "orderId": "5745289543874", "requestedCents": 3000,
    "receivedAt": "2026-10-09T17:59:11.670Z", "status": "pending",
    "pendingReason": "pedido 5745289543874 ainda não recebido; aplicado quando o pedido chegar",
    "appliedCents": null, "appliedAt": null
  }
}
```

**2. Pedido (cupom de `ana`, UTM de `bruno`): cupom vence, e o estorno pendente é aplicado**

```bash
curl -s -X POST localhost:3000/webhooks/orders -H 'content-type: application/json' -d '{
  "id": 5745289543874,
  "name": "#1001",
  "total_price": "199.90",
  "currency": "BRL",
  "financial_status": "paid",
  "discount_codes": [{ "code": "ANA10", "amount": "19.99", "type": "percentage" }],
  "note_attributes": [],
  "landing_site": "/products/tenis?utm_source=conty&utm_campaign=conty-bruno"
}'
```

```json
{
  "status": "created",
  "order": {
    "id": "5745289543874", "currency": "BRL", "totalCents": 19990, "financialStatus": "paid",
    "attribution": {
      "creatorId": "ana", "source": "coupon",
      "reason": "cupom ANA10 pertence a ana; cupom vence a UTM conty-bruno (de bruno)"
    },
    "receivedAt": "2026-10-09T17:59:11.913Z",
    "entries": [
      { "type": "sale", "id": "order:5745289543874", "amountCents": 19990, "at": "2026-10-09T17:59:11.913Z" },
      { "type": "refund", "id": "900", "amountCents": -3000, "requestedCents": 3000, "rejectedCents": 0,
        "receivedAt": "2026-10-09T17:59:11.670Z", "at": "2026-10-09T17:59:11.913Z",
        "pendingReason": "pedido 5745289543874 ainda não recebido; aplicado quando o pedido chegar" }
    ],
    "refundedCents": 3000,
    "netCents": 16990
  }
}
```

**3. O mesmo pedido de novo:** responde `200` com `"status": "duplicate"` e o mesmo `order`, sem novo lançamento.

**4. Estorno parcial, depois o mesmo estorno de novo**

```bash
curl -s -X POST localhost:3000/webhooks/refunds -H 'content-type: application/json' \
  -d '{"id":901,"order_id":5745289543874,"transactions":[{"amount":"50.00","currency":"BRL","kind":"refund","status":"success"}]}'
# 1ª vez: {"status":"applied","refund":{"id":"901",...,"requestedCents":5000,"status":"applied","appliedCents":5000,...}}
# 2ª vez: {"status":"duplicate","refund":{"id":"901",...,"appliedCents":5000,...}}  (nada muda)
```

**5. Estorno maior que o saldo: limitado ao saldo, excedente registrado**

```bash
curl -s -X POST localhost:3000/webhooks/refunds -H 'content-type: application/json' \
  -d '{"id":902,"order_id":5745289543874,"transactions":[{"amount":"200.00","currency":"BRL","kind":"refund","status":"success"}]}'
# {"status":"applied","refund":{"id":"902",...,"requestedCents":20000,"status":"applied","appliedCents":11990,...}}
```

**6. Consulta do pedido e do criador**

```bash
curl -s localhost:3000/orders/5745289543874
```

```json
{
  "id": "5745289543874", "currency": "BRL", "totalCents": 19990, "financialStatus": "paid",
  "attribution": { "creatorId": "ana", "source": "coupon", "reason": "cupom ANA10 pertence a ana; cupom vence a UTM conty-bruno (de bruno)" },
  "receivedAt": "2026-10-09T17:59:11.913Z",
  "entries": [
    { "type": "sale", "id": "order:5745289543874", "amountCents": 19990, "at": "2026-10-09T17:59:11.913Z" },
    { "type": "refund", "id": "900", "amountCents": -3000, "requestedCents": 3000, "rejectedCents": 0, "receivedAt": "2026-10-09T17:59:11.670Z", "at": "2026-10-09T17:59:11.913Z", "pendingReason": "pedido 5745289543874 ainda não recebido; aplicado quando o pedido chegar" },
    { "type": "refund", "id": "901", "amountCents": -5000, "requestedCents": 5000, "rejectedCents": 0, "receivedAt": "2026-10-09T17:59:12.456Z", "at": "2026-10-09T17:59:12.456Z", "pendingReason": null },
    { "type": "refund", "id": "902", "amountCents": -11990, "requestedCents": 20000, "rejectedCents": 8010, "receivedAt": "2026-10-09T17:59:12.935Z", "at": "2026-10-09T17:59:12.935Z", "pendingReason": null }
  ],
  "refundedCents": 19990,
  "netCents": 0
}
```

```bash
curl -s localhost:3000/creators/ana/sales
```

```json
{
  "creatorId": "ana",
  "totals": [{ "currency": "BRL", "orders": 1, "grossCents": 19990, "refundedCents": 19990, "netCents": 0 }],
  "orders": [{ "orderId": "5745289543874", "currency": "BRL", "totalCents": 19990, "refundedCents": 19990, "netCents": 0, "source": "coupon" }]
}
```

Erros: payload inválido responde `400` com `{"error":"total_price deve ser string decimal não negativa com até 2 casas, ex.: \"199.90\""}`; pedido inexistente responde `404` com `{"error":"pedido não encontrado","pendingRefunds":[...]}` (mostra os estornos esperando por ele).

## Regras e decisões

- **Atribuição, num lugar só:** `attribute(order, creators)` em `src/attribution.ts`, função pura. No máximo um criador:
  1. **Cupom vence UTM.** O cupom foi digitado pelo comprador no checkout; a UTM pode ser de um clique antigo ou do link de outro criador. Com mais de um cupom de criador, vale o primeiro de `discount_codes`.
  2. Sem cupom de criador, vale `utm_campaign` (de `note_attributes`; na falta, da query de `landing_site`). Cupom que não é de criador (ex.: `FRETEGRATIS`) não atrapalha a UTM.
  3. Nenhum dos dois: venda sem criador (`creatorId: null`).
  Comparação sem diferenciar maiúsculas nem espaços nas pontas. O `reason` explica a decisão, inclusive o que foi ignorado. A atribuição é congelada na chegada do pedido.
- **Dinheiro:** centavos inteiros. `"199.90"` é lido como string e separado em parte inteira e centavos, sem float (`toCents` em `src/shopify.ts`). `total_price` numérico, negativo ou com 3 casas é rejeitado. A moeda vem de `currency` e fica no pedido; totais do criador são separados por moeda.
- **Pedido idempotente por `id`:** o segundo webhook do mesmo pedido responde `200 {"status":"duplicate"}` e não cria lançamento. Vale o primeiro payload.
- **`financial_status`:** só `paid`, `partially_refunded` e `refunded` viram venda. `pending`, `authorized`, `voided` etc. respondem `200 {"status":"ignored"}` sem guardar nada, então o mesmo pedido entra quando chegar como pago.
- **Estorno idempotente pelo `id` do estorno.** Valor = soma das `transactions` com `kind: "refund"` e `status: "success"`, na moeda do pedido.
- **Histórico não se apaga:** a venda e cada estorno são lançamentos (`entries`); `refundedCents` e `netCents` são derivados deles. Estorno total deixa o líquido em zero; venda e atribuição continuam lá.
- **Soma dos estornos nunca passa da venda: o excedente é limitado, não rejeitado.** O estorno é aplicado até o saldo; `requestedCents`, `amountCents` e `rejectedCents` ficam no lançamento para auditoria. Escolhi limitar porque o mesmo caso acontece com estorno pendente, quando o pedido chega e não há a quem responder 4xx.
- **Estorno antes do pedido:** guardado como `pending` com `pendingReason`; quando o pedido chega, os pendentes são aplicados na ordem de chegada (com o mesmo limite). O motivo continua no lançamento depois de aplicado.
- **HMAC opcional, como na Shopify:** com `SHOPIFY_WEBHOOK_SECRET`, o webhook precisa de `X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(segredo, corpo cru))`, comparado em tempo constante; senão `401`. Sem o segredo (desenvolvimento), não verifica.
- **Tempo:** `Clock` injetado (`now()`); os testes usam relógio controlado. Não há espera no fluxo, então não há `sleep`.
- **Concorrência:** cada webhook é processado de forma síncrona do começo ao fim, então em um processo Node dois webhooks não se intercalam. Com banco real, o repositório (`Repository` em `src/sales.ts`) daria:
  - `PRIMARY KEY` em `orders.id` e `refunds.id` com `INSERT ... ON CONFLICT DO NOTHING` decidindo o duplicado de forma atômica (com várias lojas, chave `(shop_id, id)`);
  - uma transação por webhook com trava por pedido (`SELECT ... FOR UPDATE` na linha do pedido ou `pg_advisory_xact_lock(order_id)` quando ele ainda não existe), para que dois estornos simultâneos não passem do valor e para que estorno e pedido chegando juntos não deixem o estorno pendente para sempre;
  - índices em `refunds(order_id)` e `orders(creator_id)` (hoje são varreduras em memória).

## Critério de avaliação → teste que cobre

| Critério | Teste |
|---|---|
| Webhook repetido não soma a venda de novo | `test/sales.test.ts`: "webhook de pedido repetido não soma a venda de novo e responde duplicado"; `test/api.test.ts`: "fluxo HTTP: estorno antes do pedido, pedido duplicado, estorno repetido e consultas" |
| Estorno rastreável | `test/sales.test.ts`: "estorno parcial vira lançamento negativo e reduz o líquido sem apagar a venda"; "estorno total deixa o líquido do criador em zero, mas a venda e a atribuição continuam no histórico" |
| Soma dos estornos nunca passa da venda | `test/sales.test.ts`: "soma dos estornos nunca passa do valor da venda: excedente é limitado ao saldo e fica registrado"; "pendentes que passam do valor do pedido são limitados ao saldo quando o pedido chega" |
| Estorno parcial | `test/sales.test.ts`: "estorno parcial vira lançamento negativo e reduz o líquido sem apagar a venda"; "vários estornos parciais com ids diferentes somam" |
| Estorno repetido | `test/sales.test.ts`: "estorno repetido com o mesmo id não é aplicado duas vezes"; "pendente repetido continua um só e é aplicado uma vez" |
| Estorno antes do pedido não se perde | `test/sales.test.ts`: "fica pendente com motivo e é aplicado quando o pedido chega"; "pedido repetido depois do estorno pendente não aplica o estorno de novo"; `test/api.test.ts`: "fluxo HTTP: estorno antes do pedido, pedido duplicado, estorno repetido e consultas" (o 404 mostra o pendente) |
| Regra de atribuição num lugar só, com teste | `src/attribution.ts` `attribute()`; `test/attribution.test.ts`: os 7 testes |
| Desempate cupom × UTM de criadores diferentes | `test/attribution.test.ts`: "cupom e UTM de criadores diferentes: o cupom vence e o motivo diz que a UTM foi ignorada" |
| Só cupom / só UTM / nenhum / cupom desconhecido + UTM válida | `test/attribution.test.ts`: "só cupom: atribui ao dono do cupom", "só UTM: atribui ao dono da utm_campaign", "nem cupom nem UTM de criador: venda fica sem criador", "cupom desconhecido com UTM válida: atribui pela UTM" |
| Dinheiro em centavos, sem float, com moeda | `test/shopify.test.ts`: "converte a string decimal do webhook em centavos inteiros sem passar por float"; `test/sales.test.ts`: "venda guarda moeda e valor em centavos e a atribuição com o motivo" |
| `financial_status` não pago | `test/sales.test.ts`: "pedido ainda não pago (financial_status pending) é ignorado e entra quando chega como paid" |
| Payload inválido | `test/api.test.ts`: "payload inválido responde 400 com mensagem em português" |
| HMAC | `test/api.test.ts`: "HMAC: com segredo configurado, rejeita assinatura ausente ou errada e aceita a assinatura do corpo cru" |

## O que ficou de fora / com mais tempo

- Persistência real (ver Concorrência acima). Hoje tudo some ao reiniciar.
- `orders/updated` e edição de pedido: vale o primeiro payload pago; mudança de total depois não é refletida.
- Mesmo id de estorno com corpo diferente é tratado como duplicado (vale o primeiro), sem alerta.
- Moeda do estorno é assumida igual à do pedido; moedas com 3 casas decimais (KWD, BHD) são rejeitadas pelo parser de 2 casas.
- Estorno pendente cujo pedido nunca chega fica pendente para sempre; faria um relatório/alerta por idade.
- Cadastro de criadores e de cupons por API; aqui são configuração fixa.
- Estorno sem dinheiro (só devolução ao estoque, sem transação `refund` com sucesso) responde `400`; o certo seria `200` ignorado.
- Com segredo HMAC, o corpo é lido antes da assinatura, então JSON inválido sem assinatura recebe `400` e não `401`.
- Payload inválido responde `400`, o que faz a Shopify reenviar; em produção eu guardaria o corpo cru numa fila de rejeitados e responderia `200`.

## Uso de IA

Feito com IA: todo o código, os testes e este texto foram escritos pelo Claude Code (modelo Claude Opus 5.5), um agente de programação, a partir do enunciado. O Thallis escolheu a abordagem de trabalho e decidiu enviar.

Revisado: cada critério de "Como avaliamos" e cada teste pedido em "Entrega" tem um teste nomeado (tabela acima); suíte e typecheck rodados num clone limpo (`npm ci && npm test && npm run typecheck`); os exemplos de request/response deste README foram executados contra a API (`npm start`), com as respostas só reformatadas. Antes do envio, uma segunda passada de agente releu o diff contra o enunciado.
