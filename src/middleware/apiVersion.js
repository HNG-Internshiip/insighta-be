"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireApiVersion = requireApiVersion;
function requireApiVersion(req, res, next) {
    const v = req.headers["x-api-version"];
    if (!v || v !== "1") {
        res.status(400).json({ status: "error", message: "API version header required" });
        return;
    }
    next();
}
