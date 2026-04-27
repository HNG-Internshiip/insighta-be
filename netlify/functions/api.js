"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const serverless_http_1 = __importDefault(require("serverless-http"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const db_1 = require("../../src/config/db");
const logger_1 = require("../../src/middleware/logger");
const auth_routes_1 = __importDefault(require("../../src/routes/auth.routes"));
const profiles_routes_1 = __importDefault(require("../../src/routes/profiles.routes"));
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
app.use("/auth", auth_routes_1.default);
app.use("/api/profiles", profiles_routes_1.default);
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use((_req, res) => res.status(404).json({ status: "error", message: "Route not found" }));
// Cache DB init across warm Lambda invocations
let dbReady = false;
const wrappedHandler = (0, serverless_http_1.default)(app);
const handler = async (event, context) => {
    context.callbackWaitsForEmptyEventLoop = false;
    if (!dbReady) {
        await (0, db_1.initDB)();
        dbReady = true;
    }
    return wrappedHandler(event, context);
};
exports.handler = handler;
