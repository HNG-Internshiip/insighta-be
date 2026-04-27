import { Request, Response, NextFunction } from "express";
import type { Role } from "../types";

/**
 * requireRole("admin") — only admins pass
 * requireRole("analyst") — both analysts and admins pass (analyst is baseline)
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
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