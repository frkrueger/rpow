import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';

const WORKERS = Math.min(availableParallelism(), 4);

if (cluster.isPrimary) {
  console.log(`primary ${process.pid}: spawning ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.log(`worker ${worker.process.pid} exited (code ${code}), respawning`);
    cluster.fork();
  });
} else {
  await import('./server.js');
}
