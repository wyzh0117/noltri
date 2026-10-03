import 'dotenv/config';
import { createLogger } from '@noltri/shared';
import { serveAiService } from './service';

const logger = createLogger('ai-service');

const { server } = serveAiService();

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
