import { Request, Response, NextFunction } from "express";

export function requireApiVersion(req: Request, res: Response, next: NextFunction): void {
  const v = req.headers["x-api-version"];
  if (!v || v !== "1") {
    res.status(400).json({ status: "error", message: "API version header required" });
    return;
  }
  next();
}