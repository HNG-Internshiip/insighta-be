"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
function requestLogger(req, res, next) {
    const start = Date.now();
    res.on("finish", () => {
        const ms = Date.now() - start;
        const user = req.user?.username ?? "unauthenticated";
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ` +
            `${res.statusCode} ${ms}ms user=${user}`);
    });
    next();
}
