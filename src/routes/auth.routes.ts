import { Router } from "express";
import { authLimiter }                                           from "../middleware/rateLimiter";
import { requireAuth }                                           from "../middleware/auth";
import { githubRedirect, githubCallback,
         refresh, logout, me,
         githubAuthUrl }                                         from "../controllers/auth.controller";

const router = Router();

router.get ("/github/url",      authLimiter, githubAuthUrl);   // CLI uses this
router.get ("/github",          authLimiter, githubRedirect);
router.get ("/github/callback", authLimiter, githubCallback);
router.post("/refresh",         authLimiter, refresh);
router.post("/logout",          requireAuth, logout);
router.get ("/me",              requireAuth, me);

export default router;