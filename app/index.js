require('./tracing');

const express = require('express');
const client = require('prom-client');
const winston = require('winston');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('observable-app');

// Logger setup (JSON format for Promtail/Loki)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

const app = express();

// Metrics middleware
app.use((req, res, next) => {
  if (req.path === '/metrics') return next();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = { method: req.method, route: req.path, status: res.statusCode };
    httpRequestCounter.inc(labels);
    end(labels);
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
    });
  });
  next();
});

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Hello, Observable!' });
});

app.get('/slow', async (req, res) => {
  const delay = Math.random() * 2000 + 500;
  await new Promise((resolve) => setTimeout(resolve, delay));
  logger.warn('slow request processed', { delay_ms: Math.round(delay) });
  res.json({ message: 'Slow response', delay_ms: Math.round(delay) });
});

// Service 계층 시뮬레이션 — 수동 계측 예시
async function validateRequest(req) {
  return tracer.startActiveSpan('ErrorService.validateRequest', async (span) => {
    try {
      span.setAttribute('request.path', req.path);
      await new Promise((r) => setTimeout(r, 20));
      span.setStatus({ code: SpanStatusCode.OK });
      return true;
    } finally {
      span.end();
    }
  });
}

// Repository 계층 시뮬레이션 — 의도적으로 실패시키는 수동 계측
async function fetchFromDatabase() {
  return tracer.startActiveSpan('ErrorRepository.fetchFromDatabase', async (span) => {
    try {
      span.setAttribute('db.system', 'simulated');
      span.setAttribute('db.operation', 'SELECT');
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('DB connection refused');
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

app.get('/error', async (req, res) => {
  await tracer.startActiveSpan('ErrorController.handle', async (rootSpan) => {
    try {
      await validateRequest(req);
      await fetchFromDatabase();
      res.json({ message: 'ok' });
    } catch (err) {
      rootSpan.recordException(err);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      logger.error('intentional error triggered', { error: err.message });
      res.status(500).json({ error: 'Something went wrong!' });
    } finally {
      rootSpan.end();
    }
  });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
