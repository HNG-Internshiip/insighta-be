import { Router } from "express";
import { requireAuth }                       from "../middleware/auth";
import { requireRole }                       from "../middleware/requireRole";
import { requireApiVersion }                 from "../middleware/apiVersion";
import { apiLimiter }                        from "../middleware/rateLimiter";
import { validateProfileQuery,
         validateSearchQuery }               from "../middleware/validate";
import { getProfiles, searchProfiles,
         exportProfiles, getProfileById,
         createProfile, deleteProfile }      from "../controllers/profiles.controller";

const router = Router();

// All profile routes require auth + API version header + rate limit
router.use(requireAuth, requireApiVersion, apiLimiter);

// Read-only (analyst + admin)
router.get("/",        validateProfileQuery, getProfiles);
router.get("/search",  validateSearchQuery,  searchProfiles);
router.get("/export",  validateProfileQuery, exportProfiles);
router.get("/:id",     getProfileById);

// Admin only
router.post  ("/",    requireRole("admin"), createProfile);
router.delete("/:id", requireRole("admin"), deleteProfile);

export default router;