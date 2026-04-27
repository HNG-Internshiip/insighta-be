"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const requireRole_1 = require("../middleware/requireRole");
const apiVersion_1 = require("../middleware/apiVersion");
const rateLimiter_1 = require("../middleware/rateLimiter");
const validate_1 = require("../middleware/validate");
const profiles_controller_1 = require("../controllers/profiles.controller");
const router = (0, express_1.Router)();
// All profile routes require auth + API version header + rate limit
router.use(auth_1.requireAuth, apiVersion_1.requireApiVersion, rateLimiter_1.apiLimiter);
// Read-only (analyst + admin)
router.get("/", validate_1.validateProfileQuery, profiles_controller_1.getProfiles);
router.get("/search", validate_1.validateSearchQuery, profiles_controller_1.searchProfiles);
router.get("/export", validate_1.validateProfileQuery, profiles_controller_1.exportProfiles);
router.get("/:id", profiles_controller_1.getProfileById);
// Admin only
router.post("/", (0, requireRole_1.requireRole)("admin"), profiles_controller_1.createProfile);
router.delete("/:id", (0, requireRole_1.requireRole)("admin"), profiles_controller_1.deleteProfile);
exports.default = router;
