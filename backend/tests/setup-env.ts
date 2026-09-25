// Deterministic env for every test run; nothing here may point at a real database.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.CORS_ORIGINS = 'http://localhost:5178';
process.env.THROTTLE_TTL_MS = '60000';
process.env.THROTTLE_LIMIT = '100';
process.env.THROTTLE_STRICT_TTL_MS = '60000';
process.env.THROTTLE_STRICT_LIMIT = '10';
