"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = requireRole;
/**
 * requireRole("admin") — only admins pass
 * requireRole("analyst") — both analysts and admins pass (analyst is baseline)
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ status: "error", message: "Authentication required" });
            return;
        }
        // admin always has access; otherwise check the role list
        if (req.user.role === "admin" || roles.includes(req.user.role)) {
            next();
            return;
        }
        res.status(403).json({ status: "error", message: "Insufficient permissions" });
    };
}
