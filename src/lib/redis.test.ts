import { redis, connectRedis } from './redis';

jest.mock('../config', () => ({
  config: { redis: { url: 'redis://localhost:6379' } },
}));

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

function setStatus(status: typeof redis.status): void {
  // ioredis exposes status as writable at runtime but its value is managed
  // internally; setting it here lets us exercise each connection state without
  // requiring a live Redis server.
  redis.status = status;
}

describe('connectRedis', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    setStatus('wait');
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('does not reconnect an already-ready client', async () => {
    setStatus('ready');
    const connect = jest.spyOn(redis, 'connect');

    await connectRedis();

    expect(connect).not.toHaveBeenCalled();
  });

  it('waits when another module has already started connecting', async () => {
    setStatus('connecting');
    const connect = jest.spyOn(redis, 'connect');

    const connected = connectRedis();
    setStatus('ready');
    redis.emit('ready');
    await connected;

    expect(connect).not.toHaveBeenCalled();
  });

  it('coalesces concurrent explicit connection attempts', async () => {
    setStatus('wait');
    let finishConnect: (() => void) | undefined;
    const connect = jest.spyOn(redis, 'connect').mockImplementation(
      () => new Promise<void>((resolve) => {
        finishConnect = resolve;
      }),
    );

    const first = connectRedis();
    const second = connectRedis();

    expect(second).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);

    setStatus('ready');
    finishConnect?.();
    await first;
  });
});
