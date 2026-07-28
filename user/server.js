'use strict';

// Instana tracing is optional - the service must still start cleanly
// when no Instana agent/backend is configured (e.g. local/dev/CI).
let instana = null;
try {
    if (process.env.INSTANA_AGENT_HOST || process.env.INSTANA_ENDPOINT_URL) {
        instana = require('@instana/collector')({
            tracing: { enabled: true }
        });
    }
} catch (e) {
    instana = null;
}

const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const auth = require('./auth');

// MongoDB
let usersCollection;
let ordersCollection;
let mongoConnected = false;

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
        paths: [
            'req.headers.authorization',
            'req.body.password',
            'req.body.confirmPassword',
            'body.password',
            'body.confirmPassword'
        ],
        censor: '[redacted]'
    }
});
const httpLogger = pinoHttp({ logger });

const app = express();
const router = express.Router();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

app.use(httpLogger);

const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes('*')) {
        res.set('Access-Control-Allow-Origin', '*');
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Timing-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    return next();
});

app.use((req, res, next) => {
    if (instana) {
        const dcs = [
            'asia-northeast2',
            'asia-south1',
            'europe-west3',
            'us-east1',
            'us-west1'
        ];
        const span = instana.currentSpan();
        if (span) {
            span.annotate('custom.sdk.tags.datacenter', dcs[Math.floor(Math.random() * dcs.length)]);
        }
    }
    next();
});

app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));

// Brute force protection on the credential endpoints.
const authLimiter = rateLimit({
    windowMs: parseInt(process.env.AUTH_RATE_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.AUTH_RATE_MAX || '20', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many attempts, please try again later' }
});

/* ------------------------------------------------------------------ *
 * Token denylist (logout / auto-logout) backed by Redis.
 * ------------------------------------------------------------------ */
async function denylistToken(jti, exp) {
    if (!jti || !exp) return;
    const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000));
    try {
        await redisClient.setEx('denylist:' + jti, ttl, '1');
    } catch (e) {
        logger.error({ err: e }, 'failed to denylist token');
    }
}

async function isDenylisted(jti) {
    if (!jti) return false;
    try {
        return (await redisClient.get('denylist:' + jti)) !== null;
    } catch (e) {
        logger.error({ err: e }, 'denylist lookup failed');
        return false;
    }
}

// requireAuth + revocation check
const authenticate = [
    auth.requireAuth,
    async (req, res, next) => {
        if (await isDenylisted(req.auth.jti)) {
            return res.status(401).json({ error: 'session ended, please sign in again' });
        }
        return next();
    }
];

function dbReady(req, res, next) {
    if (!mongoConnected) {
        req.log.error('database not available');
        return res.status(503).json({ error: 'database not available' });
    }
    return next();
}

/* ------------------------------------------------------------------ *
 * Public endpoints
 * ------------------------------------------------------------------ */

app.get('/health', (req, res) => {
    res.json({
        app: 'OK',
        mongo: mongoConnected,
        redis: redisClient.isReady === true
    });
});

// use REDIS INCR to track anonymous users
router.get('/uniqueid', async (req, res) => {
    try {
        const r = await redisClient.incr('anonymous-counter');
        res.json({ uuid: 'anonymous-' + r });
    } catch (err) {
        req.log.error({ err }, 'redis incr failed');
        res.status(500).json({ error: 'internal error' });
    }
});

// check user exists - used server side by the payment service
router.get('/check/:id', dbReady, async (req, res) => {
    try {
        const user = await usersCollection.findOne({ name: req.params.id });
        if (user) {
            res.send('OK');
        } else {
            res.status(404).send('user not found');
        }
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).json({ error: 'internal error' });
    }
});

// availability checks used by the register form
router.get('/available/username/:name', dbReady, async (req, res) => {
    try {
        const exists = await usersCollection.findOne({ name: req.params.name });
        res.json({ available: !exists });
    } catch (e) {
        req.log.error({ err: e }, 'availability check failed');
        res.status(500).json({ error: 'internal error' });
    }
});

router.get('/available/email/:email', dbReady, async (req, res) => {
    try {
        const exists = await usersCollection.findOne({ email: String(req.params.email).toLowerCase() });
        res.json({ available: !exists });
    } catch (e) {
        req.log.error({ err: e }, 'availability check failed');
        res.status(500).json({ error: 'internal error' });
    }
});

router.post('/register', authLimiter, dbReady, async (req, res) => {
    const { data, errors } = auth.validateRegistration(req.body || {});
    if (errors.length) {
        return res.status(400).json({ error: errors[0], errors });
    }
    try {
        const clash = await usersCollection.findOne({
            $or: [{ name: data.name }, { email: data.email }]
        });
        if (clash) {
            const field = clash.email === data.email ? 'email' : 'username';
            return res.status(409).json({ error: `that ${field} is already registered`, field });
        }

        const now = new Date();
        const doc = {
            name: data.name,
            firstName: data.firstName,
            lastName: data.lastName,
            email: data.email,
            phone: data.phone,
            password: await auth.hashPassword(data.password),
            role: 'user',
            createdAt: now,
            updatedAt: now
        };
        const r = await usersCollection.insertOne(doc);
        doc._id = r.insertedId;
        req.log.info({ insertedId: r.insertedId }, 'user registered');

        return res.status(201).json({
            user: auth.publicUser(doc),
            accessToken: auth.signAccessToken(doc),
            refreshToken: auth.signRefreshToken(doc, false),
            tokenType: 'Bearer'
        });
    } catch (e) {
        if (e && e.code === 11000) {
            return res.status(409).json({ error: 'that username or email is already registered' });
        }
        req.log.error({ err: e }, 'register failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.post('/login', authLimiter, dbReady, async (req, res) => {
    const { data, errors } = auth.validateLogin(req.body || {});
    if (errors.length) {
        return res.status(400).json({ error: errors[0], errors });
    }
    try {
        const identifier = data.identifier;
        const user = await usersCollection.findOne({
            $or: [{ email: identifier.toLowerCase() }, { name: identifier }]
        });
        if (!user) {
            return res.status(401).json({ error: 'invalid credentials' });
        }

        let ok;
        if (auth.isBcryptHash(user.password)) {
            ok = await auth.verifyPassword(data.password, user.password);
        } else {
            // Legacy seeded accounts stored plaintext passwords. Accept once,
            // then transparently upgrade the stored value to a bcrypt hash.
            ok = user.password === data.password;
            if (ok) {
                await usersCollection.updateOne(
                    { _id: user._id },
                    { $set: { password: await auth.hashPassword(data.password), updatedAt: new Date() } }
                );
                req.log.info({ user: user.name }, 'upgraded legacy password to bcrypt');
            }
        }
        if (!ok) {
            return res.status(401).json({ error: 'invalid credentials' });
        }

        return res.json({
            user: auth.publicUser(user),
            accessToken: auth.signAccessToken(user),
            refreshToken: auth.signRefreshToken(user, data.remember),
            tokenType: 'Bearer'
        });
    } catch (e) {
        req.log.error({ err: e }, 'login failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.post('/refresh', dbReady, async (req, res) => {
    const token = (req.body && req.body.refreshToken) || '';
    if (!token) {
        return res.status(400).json({ error: 'refresh token required' });
    }
    try {
        const claims = auth.verifyRefreshToken(token);
        if (claims.type !== 'refresh') {
            return res.status(401).json({ error: 'invalid token type' });
        }
        if (await isDenylisted(claims.jti)) {
            return res.status(401).json({ error: 'session ended, please sign in again' });
        }
        const user = await usersCollection.findOne({ name: claims.name });
        if (!user) {
            return res.status(401).json({ error: 'user no longer exists' });
        }
        return res.json({
            user: auth.publicUser(user),
            accessToken: auth.signAccessToken(user),
            tokenType: 'Bearer'
        });
    } catch (e) {
        return res.status(401).json({ error: 'invalid or expired refresh token' });
    }
});

router.post('/logout', authenticate, async (req, res) => {
    await denylistToken(req.auth.jti, req.auth.exp);
    res.json({ status: 'logged out' });
});

/* Password reset. No mail transport is configured in this stack, so the
 * reset token is returned to the caller; wire it into your mail provider by
 * consuming the same value server side. The token itself is never stored -
 * only its SHA-256 hash, with a hard expiry. */
router.post('/forgot-password', authLimiter, dbReady, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!auth.EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'a valid email is required' });
    }
    try {
        const user = await usersCollection.findOne({ email });
        // Always answer identically so the endpoint cannot enumerate accounts.
        const response = {
            status: 'if that email is registered, a reset link has been issued'
        };
        if (!user) {
            return res.json(response);
        }
        const { token, hash } = auth.createResetToken();
        const expires = new Date(Date.now() + 30 * 60 * 1000);
        await usersCollection.updateOne(
            { _id: user._id },
            { $set: { resetTokenHash: hash, resetTokenExpires: expires, updatedAt: new Date() } }
        );
        response.resetToken = token;
        response.expiresAt = expires.toISOString();
        return res.json(response);
    } catch (e) {
        req.log.error({ err: e }, 'forgot password failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.post('/reset-password', authLimiter, dbReady, async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const password = (req.body && req.body.password) || '';
    if (!token) {
        return res.status(400).json({ error: 'reset token required' });
    }
    const problems = auth.passwordProblems(password);
    if (problems.length) {
        return res.status(400).json({ error: problems[0], errors: problems });
    }
    try {
        const user = await usersCollection.findOne({
            resetTokenHash: auth.hashToken(token),
            resetTokenExpires: { $gt: new Date() }
        });
        if (!user) {
            return res.status(400).json({ error: 'reset token is invalid or has expired' });
        }
        await usersCollection.updateOne(
            { _id: user._id },
            {
                $set: { password: await auth.hashPassword(password), updatedAt: new Date() },
                $unset: { resetTokenHash: '', resetTokenExpires: '' }
            }
        );
        return res.json({ status: 'password updated' });
    } catch (e) {
        req.log.error({ err: e }, 'reset password failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

/* ------------------------------------------------------------------ *
 * Protected endpoints
 * ------------------------------------------------------------------ */

router.get('/me', authenticate, dbReady, async (req, res) => {
    try {
        const user = await usersCollection.findOne({ name: req.auth.name });
        if (!user) {
            return res.status(404).json({ error: 'user not found' });
        }
        return res.json({ user: auth.publicUser(user) });
    } catch (e) {
        req.log.error({ err: e }, 'profile lookup failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.put('/me', authenticate, dbReady, async (req, res) => {
    const body = req.body || {};
    const update = {};
    if (typeof body.firstName === 'string' && body.firstName.trim()) update.firstName = body.firstName.trim();
    if (typeof body.lastName === 'string' && body.lastName.trim()) update.lastName = body.lastName.trim();
    if (typeof body.phone === 'string' && body.phone.trim()) update.phone = body.phone.trim();
    if (!Object.keys(update).length) {
        return res.status(400).json({ error: 'nothing to update' });
    }
    update.updatedAt = new Date();
    try {
        await usersCollection.updateOne({ name: req.auth.name }, { $set: update });
        const user = await usersCollection.findOne({ name: req.auth.name });
        return res.json({ user: auth.publicUser(user) });
    } catch (e) {
        req.log.error({ err: e }, 'profile update failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.post('/change-password', authenticate, dbReady, async (req, res) => {
    const current = (req.body && req.body.currentPassword) || '';
    const next = (req.body && req.body.newPassword) || '';
    const problems = auth.passwordProblems(next);
    if (problems.length) {
        return res.status(400).json({ error: problems[0], errors: problems });
    }
    try {
        const user = await usersCollection.findOne({ name: req.auth.name });
        if (!user) {
            return res.status(404).json({ error: 'user not found' });
        }
        const ok = auth.isBcryptHash(user.password)
            ? await auth.verifyPassword(current, user.password)
            : user.password === current;
        if (!ok) {
            return res.status(401).json({ error: 'current password is incorrect' });
        }
        await usersCollection.updateOne(
            { _id: user._id },
            { $set: { password: await auth.hashPassword(next), updatedAt: new Date() } }
        );
        await denylistToken(req.auth.jti, req.auth.exp);
        return res.json({ status: 'password updated' });
    } catch (e) {
        req.log.error({ err: e }, 'change password failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

// order history of the authenticated user
router.get('/orders', authenticate, dbReady, async (req, res) => {
    try {
        const history = await ordersCollection.findOne({ name: req.auth.name });
        return res.json({ history: (history && history.history) || [] });
    } catch (e) {
        req.log.error({ err: e }, 'history lookup failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

// admin only - full user listing
router.get('/users', authenticate, auth.requireRole('admin'), dbReady, async (req, res) => {
    try {
        const users = await usersCollection.find({}).toArray();
        return res.json(users.map(auth.publicUser));
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

/* ------------------------------------------------------------------ *
 * Service-to-service endpoints (called by the payment service)
 * ------------------------------------------------------------------ */

router.post('/order/:id', dbReady, async (req, res) => {
    try {
        const user = await usersCollection.findOne({ name: req.params.id });
        if (!user) {
            return res.status(404).send('name not found');
        }
        const entry = Object.assign({ placedAt: new Date().toISOString() }, req.body);
        await ordersCollection.updateOne(
            { name: req.params.id },
            { $push: { history: entry }, $setOnInsert: { name: req.params.id } },
            { upsert: true }
        );
        return res.send('OK');
    } catch (e) {
        req.log.error({ err: e }, 'order save failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

router.get('/history/:id', authenticate, auth.requireSelfOrAdmin('id'), dbReady, async (req, res) => {
    try {
        const history = await ordersCollection.findOne({ name: req.params.id });
        if (history) {
            return res.json(history);
        }
        return res.status(404).json({ error: 'history not found' });
    } catch (e) {
        req.log.error({ err: e }, 'history lookup failed');
        return res.status(500).json({ error: 'internal error' });
    }
});

// Register user-service routes
app.use(router);
app.use('/api/user', router);

// JSON 404 + error handler so clients never receive an HTML error body
app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal error' });
});

// connect to Redis
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
    }
});

redisClient.on('error', (e) => {
    logger.error({ err: e }, 'Redis ERROR');
});
redisClient.on('connect', () => {
    logger.info('Redis connected');
});
redisClient.connect().catch((e) => {
    logger.error({ err: e }, 'Redis initial connection failed');
});

// set up Mongo
async function mongoConnect() {
    const mongoURL = process.env.MONGO_URL || 'mongodb://mongodb:27017/users';
    const client = new MongoClient(mongoURL, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(process.env.MONGO_DB || 'users');
    usersCollection = db.collection('users');
    ordersCollection = db.collection('orders');
    // Enforce uniqueness at the database layer as well as in the handler.
    await usersCollection.createIndex({ name: 1 }, { unique: true });
    await usersCollection.createIndex({ email: 1 }, { unique: true, sparse: true });
    await ordersCollection.createIndex({ name: 1 });
    mongoConnected = true;
    logger.info('MongoDB connected');
    client.on('close', () => {
        mongoConnected = false;
        logger.warn('MongoDB connection closed, retrying');
        setTimeout(mongoLoop, 2000);
    });
}

function mongoLoop() {
    mongoConnect().catch((e) => {
        mongoConnected = false;
        logger.error({ err: e }, 'MongoDB connection failed');
        setTimeout(mongoLoop, 2000);
    });
}

if (!process.env.JWT_SECRET) {
    logger.warn('JWT_SECRET is not set - falling back to the development secret. Set JWT_SECRET in production.');
}

mongoLoop();

// fire it up!
const port = process.env.USER_SERVER_PORT || '8080';
const server = app.listen(port, () => {
    logger.info(`Started on port ${port}`);
});

async function shutdown() {
    logger.info('Shutting down');
    server.close(() => process.exit(0));
    try {
        await redisClient.quit();
    } catch (e) {
        // ignore
    }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
