export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function format(scope: string, level: LogLevel, message: string, fields?: Record<string, unknown>) {
  const base = `[${scope}] ${level.toUpperCase()}: ${message}`;
  if (!fields || Object.keys(fields).length === 0) return base;
  return `${base} ${JSON.stringify(fields)}`;
}

export function createLogger(scope: string, minLevel: LogLevel = 'info'): Logger {
  const enabled = (level: LogLevel) => LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minLevel];

  const logger: Logger = {
    debug: (message, fields) => {
      if (enabled('debug')) console.debug(format(scope, 'debug', message, fields));
    },
    info: (message, fields) => {
      if (enabled('info')) console.info(format(scope, 'info', message, fields));
    },
    warn: (message, fields) => {
      if (enabled('warn')) console.warn(format(scope, 'warn', message, fields));
    },
    error: (message, fields) => {
      if (enabled('error')) console.error(format(scope, 'error', message, fields));
    },
    child: (nested) => createLogger(`${scope}:${nested}`, minLevel),
  };

  return logger;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
