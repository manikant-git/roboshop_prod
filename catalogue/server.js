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
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const httpLogger = pinoHttp({ logger });

// MongoDB
let collection;
let mongoConnected = false;

const app = express();

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
        mongo: mongoConnected
    });
});

// all products
app.get('/products', async (req, res) => {
    if (!mongoConnected) {
        req.log.error('database not available');
        res.status(500).send('database not available');
        return;
    }
    try {
        const products = await collection.find({}).toArray();
        res.json(products);
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).send('internal error');
    }
});

// product by SKU
app.get('/product/:sku', async (req, res) => {
    if (!mongoConnected) {
        req.log.error('database not available');
        res.status(500).send('database not available');
        return;
    }
    // optionally slow this down (used for demos/chaos testing)
    const delay = parseInt(process.env.GO_SLOW || '0', 10) || 0;
    if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
        const product = await collection.findOne({ sku: req.params.sku });
        if (product) {
            res.json(product);
        } else {
            res.status(404).send('SKU not found');
        }
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).send('internal error');
    }
});

// products in a category
app.get('/products/:cat', async (req, res) => {
    if (!mongoConnected) {
        req.log.error('database not available');
        res.status(500).send('database not available');
        return;
    }
    try {
        const products = await collection.find({ categories: req.params.cat }).sort({ name: 1 }).toArray();
        res.json(products);
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).send('internal error');
    }
});

// all categories
app.get('/categories', async (req, res) => {
    if (!mongoConnected) {
        req.log.error('database not available');
        res.status(500).send('database not available');
        return;
    }
    try {
        const categories = await collection.distinct('categories');
        res.json(categories);
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).send('internal error');
    }
});

// search name and description
app.get('/search/:text', async (req, res) => {
    if (!mongoConnected) {
        req.log.error('database not available');
        res.status(500).send('database not available');
        return;
    }
    try {
        const hits = await collection.find({ $text: { $search: req.params.text } }).toArray();
        res.json(hits);
    } catch (e) {
        req.log.error({ err: e }, 'query failed');
        res.status(500).send('internal error');
    }
});

// set up Mongo
async function mongoConnect() {
    try {
        const mongoURL = process.env.MONGO_URL || 'mongodb://mongodb:27017/catalogue';
        const client = new MongoClient(mongoURL, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        const db = client.db('catalogue');
        collection = db.collection('products');
        mongoConnected = true;
        logger.info('MongoDB connected');
        client.on('close', () => {
            mongoConnected = false;
            logger.warn('MongoDB connection closed, retrying');
            setTimeout(mongoLoop, 2000);
        });
    } catch (error) {
        mongoConnected = false;
        logger.error({ err: error }, 'MongoDB connection failed');
        setTimeout(mongoLoop, 2000);
    }
}

function mongoLoop() {
    mongoConnect().catch((e) => {
        logger.error({ err: e }, 'mongoLoop failed');
        setTimeout(mongoLoop, 2000);
    });
}

mongoLoop();

// fire it up!
const port = process.env.CATALOGUE_SERVER_PORT || '8080';
const server = app.listen(port, () => {
    logger.info(`Started on port ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = app;
