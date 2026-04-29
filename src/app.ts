import "dotenv/config";
import express, { Request, Response } from "express";
import cors         from "cors";
import cookieParser from "cookie-parser";
import { initDB }        from "./config/db";
import { requestLogger } from "./middleware/logger";
import authRoutes        from "./routes/auth.routes";
import profileRoutes     from "./routes/profiles.routes";
import usersRoutes       from "./routes/users.routes";
import testAuthRoutes    from "./routes/testAuth.routes";

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*"))
      return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);

app.use("/auth",         authRoutes);
app.use("/api/users",    usersRoutes);    // mounted before profiles — no version header needed
app.use("/api/profiles", profileRoutes); // has requireApiVersion inside

// Only mounted when TEST_SECRET is set in env
if (process.env.TEST_SECRET) {
  app.use("/auth", testAuthRoutes);
  console.log("Test auth route enabled");
}

app.get("/health", (_req: Request, res: Response) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.use((_req: Request, res: Response) =>
  res.status(404).json({ status: "error", message: "Route not found" })
);

const PORT = parseInt(process.env.PORT ?? "3000", 10);

initDB()
  .then(() => app.listen(PORT, () => console.log(`Insighta API on port ${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });

export default app;