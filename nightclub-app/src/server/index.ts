import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
console.log(`api listening on http://${config.host}:${config.port}`);
