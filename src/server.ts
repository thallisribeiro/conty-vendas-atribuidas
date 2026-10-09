import { buildApp } from './app';
import { MemoryRepository, Sales } from './sales';

// Creators are fixed config in this exercise (no CRUD route).
const creators = [
  { id: 'ana', coupons: ['ANA10'], utmCampaign: 'conty-ana' },
  { id: 'bruno', coupons: ['BRUNO15'], utmCampaign: 'conty-bruno' },
];

const sales = new Sales(new MemoryRepository(), creators, { now: () => new Date() });
const app = buildApp({ sales, webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });
console.log(`API em http://localhost:${port}`);
