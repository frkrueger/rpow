import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const WORKERS = parseInt(process.env.WORKER_COUNT || '0', 10) || availableParallelism();

if (cluster.isPrimary) {
  // Run migrations once from the primary before spawning workers.
  const { createPool, runMigrations } = await import('./db.js');
  const { parseEnv } = await import('./env.js');
  const env = parseEnv();
  const pool = createPool(env.DATABASE_URL);
  await runMigrations(pool);
  await pool.end();

  console.log(`primary ${process.pid}: migrations done, spawning ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.log(`worker ${worker.process.pid} exited (code ${code}), respawning`);
    cluster.fork();
  });
} else {
  await import('./server.js');
}
