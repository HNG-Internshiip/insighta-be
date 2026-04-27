import rateLimit from "express-rate-limit";

const errorBody = { status: "error", message: "Too many requests, please slow down" };

// 10 req/min for auth endpoints
export const authLimiter = rateLimit({
  windowMs:          60_000,
  max:               10,
  standardHeaders:   true,
  legacyHeaders:     false,
  handler: (_req, res) => res.status(429).json(errorBody),
});

// 60 req/min per authenticated user (falls back to IP)
export const apiLimiter = rateLimit({
  windowMs:          60_000,
  max:               60,
  keyGenerator:      (req) => (req.user?.id ?? req.ip) as string,
  standardHeaders:   true,
  legacyHeaders:     false,
  handler: (_req, res) => res.status(429).json(errorBody),
});