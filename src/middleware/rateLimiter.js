"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiLimiter = exports.authLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const errorBody = { status: "error", message: "Too many requests, please slow down" };
// 10 req/min for auth endpoints
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(errorBody),
});
// 60 req/min per authenticated user (falls back to IP)
exports.apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60000,
    max: 60,
    keyGenerator: (req) => (req.user?.id ?? req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json(errorBody),
});
