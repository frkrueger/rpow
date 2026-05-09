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
  const lastSpawn = new Map<number, number>();
  cluster.on('exit', (worker, code) => {
    console.log(`worker ${worker.process.pid} exited (code ${code}), respawning`);
    const now = Date.now();
    const prev = lastSpawn.get(worker.id) ?? 0;
    const delay = (now - prev < 5000) ? 3000 : 0;
    setTimeout(() => {
      const w = cluster.fork();
      lastSpawn.set(w.id, Date.now());
    }, delay);
  });
} else {
  await import('./server.js');
}
