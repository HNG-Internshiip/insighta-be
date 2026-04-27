import "dotenv/config";
import express, { Request, Response } from "express";
import cors          from "cors";
import cookieParser  from "cookie-parser";
import { initDB }        from "./config/db";
import { requestLogger } from "./middleware/logger";
import authRoutes        from "./routes/auth.routes";
import profileRoutes     from "./routes/profiles.routes";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);

// Force HTTPS in production
app.use((req: Request, res: Response, next) => {
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

app.use("/auth",         authRoutes);
app.use("/api/profiles", profileRoutes);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use((_req: Request, res: Response) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);

initDB()
  .then(() => app.listen(PORT, () => console.log(`Insighta API on port ${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });