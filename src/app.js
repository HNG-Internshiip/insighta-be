"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const db_1 = require("./config/db");
const logger_1 = require("./middleware/logger");
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const profiles_routes_1 = __importDefault(require("./routes/profiles.routes"));
const app = (0, express_1.default)();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin))
            return cb(null, true);
        cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
}));
app.use(express_1.default.json());
app.use((0, cookie_parser_1.default)());
app.use(logger_1.requestLogger);
// Force HTTPS in production
app.use((req, res, next) => {
    if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
        return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
});
app.use("/auth", auth_routes_1.default);
app.use("/api/profiles", profiles_routes_1.default);
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use((_req, res) => {
    res.status(404).json({ status: "error", message: "Route not found" });
});
const PORT = parseInt(process.env.PORT ?? "3000", 10);
(0, db_1.initDB)()
    .then(() => app.listen(PORT, () => console.log(`Insighta API on port ${PORT}`)))
    .catch((e) => { console.error(e); process.exit(1); });
