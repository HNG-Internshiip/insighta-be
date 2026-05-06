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
import { importProfiles,
         getImportJob }                      from "../controllers/ingestion.controller";

const router = Router();

router.use(requireAuth, requireApiVersion, apiLimiter);

// ── Read (analyst + admin) ─────────────────────────────────────────────────────
// Specific paths must come before /:id
router.get("/search",        validateSearchQuery,  searchProfiles);
router.get("/export",        validateProfileQuery, exportProfiles);
router.get("/import/:jobId", requireRole("admin"), getImportJob);
router.get("/",              validateProfileQuery, getProfiles);
router.get("/:id",           getProfileById);

// ── Write (admin only) ────────────────────────────────────────────────────────
router.post  ("/",       requireRole("admin"), createProfile);
router.delete("/:id",    requireRole("admin"), deleteProfile);
router.post  ("/import", requireRole("admin"), importProfiles);

export default router;