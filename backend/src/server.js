'use strict';
const { createDb } = require('./db');
const { createApp } = require('./app');
const { seedBase, seedDemo } = require('./seed');
const service = require('./claimService');

async function main() {
  const db = await createDb();
  const fresh = await seedBase(db);
  if (fresh && process.env.SEED_DEMO !== '0') await seedDemo(db);
  await service.closeExpired(db);
  setInterval(() => service.closeExpired(db).catch(console.error), 60 * 60 * 1000).unref();

  const port = Number(process.env.PORT || 4000);
  createApp(db).listen(port, () => {
    console.log(`Claim system API running on http://localhost:${port}`);
    console.log(process.env.DATABASE_URL ? 'Database: PostgreSQL' : 'Database: in-memory (set DATABASE_URL to use PostgreSQL)');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
