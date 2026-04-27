"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const token_service_1 = require("../services/token.service");
const db_1 = require("../config/db");
async function requireAuth(req, res, next) {
    try {
        // Support both Bearer token (CLI) and HTTP-only cookie (web)
        let token;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
            token = authHeader.slice(7);
        }
        else if (req.cookies?.access_token) {
            token = req.cookies.access_token;
        }
        if (!token) {
            res.status(401).json({ status: "error", message: "Authentication required" });
            return;
        }
        const payload = (0, token_service_1.verifyAccessToken)(token);
        if (payload.type !== "access") {
            res.status(401).json({ status: "error", message: "Invalid token type" });
            return;
        }
        const { rows } = await db_1.pool.query(`SELECT * FROM users WHERE id = $1`, [payload.sub]);
        if (!rows.length) {
            res.status(401).json({ status: "error", message: "User not found" });
            return;
        }
        if (!rows[0].is_active) {
            res.status(403).json({ status: "error", message: "Account disabled" });
            return;
        }
        req.user = rows[0];
        next();
    }
    catch {
        res.status(401).json({ status: "error", message: "Invalid or expired token" });
    }
}
