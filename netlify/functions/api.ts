import serverless from "serverless-http";
import express, { Request, Response } from "express";
import cors         from "cors";
import cookieParser from "cookie-parser";
import { initDB }        from "../../src/config/db";
import { requestLogger } from "../../src/middleware/logger";
import authRoutes        from "../../src/routes/auth.routes";
import profileRoutes     from "../../src/routes/profiles.routes";
import usersRoutes       from "../../src/routes/users.routes";
import testAuthRoutes    from "../../src/routes/testAuth.routes";

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
app.use("/api/profiles", profileRoutes);
app.use("/api/users",    usersRoutes);

if (process.env.TEST_SECRET) {
  app.use("/auth", testAuthRoutes);
}

app.get("/health", (_req: Request, res: Response) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.use((_req: Request, res: Response) =>
  res.status(404).json({ status: "error", message: "Route not found" })
);

let dbReady = false;
const wrappedHandler = serverless(app);

export const handler = async (event: any, context: any) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (!dbReady) {
    await initDB();
    dbReady = true;
  }
  return wrappedHandler(event, context);
};