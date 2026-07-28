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
    // instrumentation is best-effort only
    instana = null;
}

const redis = require('redis');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
// Prometheus
const promClient = require('prom-client');
const Registry = promClient.Registry;
const register = new Registry();
const counter = new promClient.Counter({
    name: 'items_added',
    help: 'running count of items added to cart',
    registers: [register]
});

let redisConnected = false;

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = process.env.REDIS_PORT || '6379';
const catalogueHost = process.env.CATALOGUE_HOST || 'catalogue';
const cataloguePort = process.env.CATALOGUE_PORT || '8080';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const httpLogger = pinoHttp({ logger });

const app = express();
const router = express.Router();

app.use(httpLogger);

app.use((req, res, next) => {
    res.set('Timing-Allow-Origin', '*');
    res.set('Access-Control-Allow-Origin', '*');
    next();
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({
        app: 'OK',
        redis: redisConnected
    });
});

// Prometheus
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
});

// get cart with id
router.get('/cart/:id', async (req, res) => {
    try {
        const data = await redisClient.get(req.params.id);
        if (data == null) {
            res.status(404).send('cart not found');
        } else {
            res.set('Content-Type', 'application/json');
            res.send(data);
        }
    } catch (err) {
        req.log.error({ err }, 'redis get failed');
        res.status(500).send('internal error');
    }
});

// delete cart with id
router.delete('/cart/:id', async (req, res) => {
    try {
        const removed = await redisClient.del(req.params.id);
        if (removed === 1) {
            res.send('OK');
        } else {
            res.status(404).send('cart not found');
        }
    } catch (err) {
        req.log.error({ err }, 'redis del failed');
        res.status(500).send('internal error');
    }
});

// rename cart i.e. at login
router.get('/rename/:from/:to', async (req, res) => {
    try {
        const data = await redisClient.get(req.params.from);
        if (data == null) {
            res.status(404).send('cart not found');
            return;
        }
        const cart = JSON.parse(data);
        await saveCart(req.params.to, cart);
        res.json(cart);
    } catch (err) {
        req.log.error({ err }, 'rename failed');
        res.status(500).send('internal error');
    }
});

// update/create cart
router.get('/add/:id/:sku/:qty', async (req, res) => {
    const qty = parseInt(req.params.qty, 10);
    if (isNaN(qty)) {
        req.log.warn('quantity not a number');
        res.status(400).send('quantity must be a number');
        return;
    } else if (qty < 1) {
        req.log.warn('quantity less than one');
        res.status(400).send('quantity has to be greater than zero');
        return;
    }

    try {
        const product = await getProduct(req.params.sku);
        if (!product) {
            res.status(404).send('product not found');
            return;
        }
        if (product.instock === 0) {
            res.status(404).send('out of stock');
            return;
        }

        const data = await redisClient.get(req.params.id);
        let cart;
        if (data == null) {
            cart = { total: 0, tax: 0, items: [] };
        } else {
            cart = JSON.parse(data);
        }

        const item = {
            qty,
            sku: req.params.sku,
            name: product.name,
            price: product.price,
            subtotal: qty * product.price
        };
        cart.items = mergeList(cart.items, item, qty);
        cart.total = calcTotal(cart.items);
        cart.tax = calcTax(cart.total);

        await saveCart(req.params.id, cart);
        counter.inc(qty);
        res.json(cart);
    } catch (err) {
        req.log.error({ err }, 'add to cart failed');
        res.status(500).send('internal error');
    }
});

// update quantity - remove item when qty == 0
router.get('/update/:id/:sku/:qty', async (req, res) => {
    const qty = parseInt(req.params.qty, 10);
    if (isNaN(qty)) {
        req.log.warn('quantity not a number');
        res.status(400).send('quantity must be a number');
        return;
    } else if (qty < 0) {
        req.log.warn('quantity less than zero');
        res.status(400).send('negative quantity not allowed');
        return;
    }

    try {
        const data = await redisClient.get(req.params.id);
        if (data == null) {
            res.status(404).send('cart not found');
            return;
        }
        const cart = JSON.parse(data);
        const idx = cart.items.findIndex((i) => i.sku === req.params.sku);
        if (idx === -1) {
            res.status(404).send('not in cart');
            return;
        }
        if (qty === 0) {
            cart.items.splice(idx, 1);
        } else {
            cart.items[idx].qty = qty;
            cart.items[idx].subtotal = cart.items[idx].price * qty;
        }
        cart.total = calcTotal(cart.items);
        cart.tax = calcTax(cart.total);
        await saveCart(req.params.id, cart);
        res.json(cart);
    } catch (err) {
        req.log.error({ err }, 'update cart failed');
        res.status(500).send('internal error');
    }
});

// add shipping
router.post('/shipping/:id', async (req, res) => {
    const shipping = req.body;
    if (shipping.distance === undefined || shipping.cost === undefined || shipping.location === undefined) {
        req.log.warn({ shipping }, 'shipping data missing');
        res.status(400).send('shipping data missing');
        return;
    }

    try {
        const data = await redisClient.get(req.params.id);
        if (data == null) {
            res.status(404).send('cart not found');
            return;
        }
        const cart = JSON.parse(data);
        const item = {
            qty: 1,
            sku: 'SHIP',
            name: 'shipping to ' + shipping.location,
            price: shipping.cost,
            subtotal: shipping.cost
        };
        const idx = cart.items.findIndex((i) => i.sku === item.sku);
        if (idx === -1) {
            cart.items.push(item);
        } else {
            cart.items[idx] = item;
        }
        cart.total = calcTotal(cart.items);
        cart.tax = calcTax(cart.total);
        await saveCart(req.params.id, cart);
        res.json(cart);
    } catch (err) {
        req.log.error({ err }, 'add shipping failed');
        res.status(500).send('internal error');
    }
});

function mergeList(list, product, qty) {
    const idx = list.findIndex((i) => i.sku === product.sku);
    if (idx !== -1) {
        list[idx].qty += qty;
        list[idx].subtotal = list[idx].price * list[idx].qty;
    } else {
        list.push(product);
    }
    return list;
}

function calcTotal(list) {
    return list.reduce((total, item) => total + item.subtotal, 0);
}

function calcTax(total) {
    // tax @ 20%
    return total - (total / 1.2);
}

// Register cart routes
app.use(router);
app.use('/api/cart', router);

async function getProduct(sku) {
    const url = `http://${catalogueHost}:${cataloguePort}/product/${encodeURIComponent(sku)}`;
    const response = await fetch(url);
    if (response.status !== 200) {
        return null;
    }
    return response.json();
}

async function saveCart(id, cart) {
    logger.info({ id }, 'saving cart');
    return redisClient.setEx(id, 3600, JSON.stringify(cart));
}

// connect to Redis
const redisClient = redis.createClient({
    socket: {
        host: redisHost,
        port: parseInt(redisPort, 10),
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
    }
});

redisClient.on('error', (e) => {
    redisConnected = false;
    logger.error({ err: e }, 'Redis ERROR');
});
redisClient.on('ready', () => {
    logger.info('Redis READY');
    redisConnected = true;
});
redisClient.on('end', () => {
    redisConnected = false;
});

redisClient.connect().catch((e) => {
    logger.error({ err: e }, 'Redis initial connection failed');
});

// fire it up!
const port = process.env.CART_SERVER_PORT || '8080';
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
