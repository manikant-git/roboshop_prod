'use strict';

/*
 * Authentication helpers for the user service.
 *
 * Responsibilities:
 *  - password hashing / verification (bcrypt)
 *  - JWT signing / verification (access + refresh tokens)
 *  - express middleware for authentication and role based authorization
 *  - input validation for register / login / password reset
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'roboshop-dev-secret-change-me';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET + '-refresh';
const JWT_ISSUER = process.env.JWT_ISSUER || 'roboshop-user-service';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'roboshop-frontend';
// Short lived access token, long lived refresh token when "remember me" is used.
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';
const REFRESH_TTL_REMEMBER = process.env.JWT_REFRESH_TTL_REMEMBER || '30d';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{6,19}$/;
const NAME_RE = /^[\p{L}][\p{L}\s'.-]{0,49}$/u;

function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
    if (typeof hash !== 'string' || hash.length === 0) {
        return Promise.resolve(false);
    }
    return bcrypt.compare(plain, hash);
}

function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

function signAccessToken(user) {
    return jwt.sign(
        {
            sub: String(user._id),
            name: user.name,
            email: user.email,
            role: user.role || 'user',
            type: 'access'
        },
        JWT_SECRET,
        {
            expiresIn: ACCESS_TTL,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            jwtid: crypto.randomUUID()
        }
    );
}

function signRefreshToken(user, remember) {
    return jwt.sign(
        { sub: String(user._id), name: user.name, type: 'refresh' },
        JWT_REFRESH_SECRET,
        {
            expiresIn: remember ? REFRESH_TTL_REMEMBER : REFRESH_TTL,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE
        }
    );
}

function verifyAccessToken(token) {
    return jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
}

function verifyRefreshToken(token) {
    return jwt.verify(token, JWT_REFRESH_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
}

function decodeExpiry(token) {
    const payload = jwt.decode(token);
    return payload && payload.exp ? payload.exp : null;
}

function bearerToken(req) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
        return header.slice(7).trim();
    }
    return null;
}

/* Express middleware: rejects the request unless a valid access token is present. */
function requireAuth(req, res, next) {
    const token = bearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'authentication required' });
    }
    try {
        const claims = verifyAccessToken(token);
        if (claims.type !== 'access') {
            return res.status(401).json({ error: 'invalid token type' });
        }
        req.auth = claims;
        return next();
    } catch (e) {
        const expired = e && e.name === 'TokenExpiredError';
        return res.status(401).json({ error: expired ? 'token expired' : 'invalid token' });
    }
}

/* Express middleware factory: requires the caller to hold one of the given roles. */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ error: 'authentication required' });
        }
        if (!roles.includes(req.auth.role)) {
            return res.status(403).json({ error: 'insufficient privileges' });
        }
        return next();
    };
}

/* Express middleware: the caller must be the owner of :id (username) or an admin. */
function requireSelfOrAdmin(paramName) {
    return (req, res, next) => {
        if (!req.auth) {
            return res.status(401).json({ error: 'authentication required' });
        }
        if (req.auth.role === 'admin' || req.auth.name === req.params[paramName]) {
            return next();
        }
        return res.status(403).json({ error: 'insufficient privileges' });
    };
}

function passwordProblems(password) {
    const problems = [];
    if (typeof password !== 'string' || password.length < 8) {
        problems.push('password must be at least 8 characters');
    }
    if (typeof password === 'string') {
        if (password.length > 128) problems.push('password must be at most 128 characters');
        if (!/[a-z]/.test(password)) problems.push('password must contain a lowercase letter');
        if (!/[A-Z]/.test(password)) problems.push('password must contain an uppercase letter');
        if (!/[0-9]/.test(password)) problems.push('password must contain a digit');
        if (!/[^A-Za-z0-9]/.test(password)) problems.push('password must contain a symbol');
    }
    return problems;
}

function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/* Validates + normalises a registration payload. */
function validateRegistration(body) {
    const data = {
        firstName: str(body.firstName),
        lastName: str(body.lastName),
        name: str(body.name || body.username),
        email: str(body.email).toLowerCase(),
        phone: str(body.phone),
        password: typeof body.password === 'string' ? body.password : '',
        confirmPassword: typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
    };
    const errors = [];

    if (!NAME_RE.test(data.firstName)) errors.push('first name is required (letters only, max 50)');
    if (!NAME_RE.test(data.lastName)) errors.push('last name is required (letters only, max 50)');
    if (!USERNAME_RE.test(data.name)) {
        errors.push('username must be 3-30 characters (letters, digits, . _ -)');
    }
    if (!EMAIL_RE.test(data.email) || data.email.length > 254) errors.push('a valid email is required');
    if (!PHONE_RE.test(data.phone)) errors.push('a valid phone number is required');
    errors.push(...passwordProblems(data.password));
    if (data.confirmPassword && data.password !== data.confirmPassword) {
        errors.push('passwords do not match');
    }
    if (!data.confirmPassword) errors.push('please confirm your password');

    return { data, errors };
}

/* Validates a login payload. Accepts email or username in the `email` field. */
function validateLogin(body) {
    const data = {
        identifier: str(body.email || body.username || body.name),
        password: typeof body.password === 'string' ? body.password : '',
        remember: body.remember === true || body.remember === 'true'
    };
    const errors = [];
    if (!data.identifier) errors.push('email or username is required');
    if (!data.password) errors.push('password is required');
    return { data, errors };
}

/* Password reset tokens: random value returned to the caller, only the hash is stored. */
function createResetToken() {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, hash: hashToken(token) };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/* Removes every sensitive field before a user document leaves the service. */
function publicUser(user) {
    if (!user) return null;
    return {
        id: String(user._id),
        name: user.name,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email,
        phone: user.phone || '',
        role: user.role || 'user',
        createdAt: user.createdAt || null
    };
}

module.exports = {
    ACCESS_TTL,
    EMAIL_RE,
    USERNAME_RE,
    bearerToken,
    createResetToken,
    decodeExpiry,
    hashPassword,
    hashToken,
    isBcryptHash,
    passwordProblems,
    publicUser,
    requireAuth,
    requireRole,
    requireSelfOrAdmin,
    signAccessToken,
    signRefreshToken,
    validateLogin,
    validateRegistration,
    verifyAccessToken,
    verifyPassword,
    verifyRefreshToken
};
