import pino from "pino";

const _logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true
    }
  }
});

export const logger = {
  debug: (msg: string, ...args: any[]) => _logger.debug(args, msg),
  info: (msg: string, ...args: any[]) => _logger.info(args, msg),
  warn: (msg: string, ...args: any[]) => _logger.warn(args, msg),
  error: (msg: string, ...args: any[]) => _logger.error(args, msg),
  child: _logger.child
};
