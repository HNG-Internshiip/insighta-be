"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProfileQuery = validateProfileQuery;
exports.validateSearchQuery = validateSearchQuery;
const VALID_GENDERS = new Set(["male", "female"]);
const VALID_AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);
const VALID_SORT_FIELDS = new Set(["age", "created_at", "gender_probability"]);
const VALID_ORDERS = new Set(["asc", "desc"]);
const KNOWN_PARAMS = new Set([
    "gender", "age_group", "country_id",
    "min_age", "max_age", "min_gender_probability", "min_country_probability",
    "sort_by", "order", "page", "limit",
]);
const errRes = (res, status, message) => {
    res.status(status).json({ status: "error", message });
};
function validateProfileQuery(req, res, next) {
    for (const key of Object.keys(req.query)) {
        if (!KNOWN_PARAMS.has(key)) {
            errRes(res, 400, "Invalid query parameters");
            return;
        }
    }
    const q = req.query;
    req.filters = {};
    if (q.gender !== undefined) {
        if (!VALID_GENDERS.has(q.gender)) {
            errRes(res, 422, "Invalid query parameters");
            return;
        }
        req.filters.gender = q.gender;
    }
    if (q.age_group !== undefined) {
        if (!VALID_AGE_GROUPS.has(q.age_group)) {
            errRes(res, 422, "Invalid query parameters");
            return;
        }
        req.filters.age_group = q.age_group;
    }
    if (q.country_id !== undefined) {
        if (!/^[A-Za-z]{2}$/.test(q.country_id)) {
            errRes(res, 422, "Invalid query parameters");
            return;
        }
        req.filters.country_id = q.country_id.toUpperCase();
    }
    for (const field of ["min_age", "max_age"]) {
        if (q[field] !== undefined) {
            const v = Number(q[field]);
            if (!Number.isInteger(v) || v < 0) {
                errRes(res, 422, "Invalid query parameters");
                return;
            }
            req.filters[field] = v;
        }
    }
    for (const field of ["min_gender_probability", "min_country_probability"]) {
        if (q[field] !== undefined) {
            const v = parseFloat(q[field]);
            if (isNaN(v) || v < 0 || v > 1) {
                errRes(res, 422, "Invalid query parameters");
                return;
            }
            req.filters[field] = v;
        }
    }
    const sort_by = (q.sort_by ?? "created_at");
    const order = (q.order ?? "asc");
    if (!VALID_SORT_FIELDS.has(sort_by)) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    if (!VALID_ORDERS.has(order)) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    req.sortBy = sort_by;
    req.sortOrder = order.toUpperCase();
    const page = parseInt(q.page ?? "1", 10);
    const limit = parseInt(q.limit ?? "10", 10);
    if (isNaN(page) || page < 1) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    if (isNaN(limit) || limit < 1 || limit > 50) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    req.pagination = { page, limit, offset: (page - 1) * limit };
    next();
}
function validateSearchQuery(req, res, next) {
    const { q, page, limit } = req.query;
    if (!q?.trim()) {
        errRes(res, 400, "Missing or empty query parameter: q");
        return;
    }
    const pg = parseInt(page ?? "1", 10);
    const lim = parseInt(limit ?? "10", 10);
    if (isNaN(pg) || pg < 1) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    if (isNaN(lim) || lim < 1 || lim > 50) {
        errRes(res, 422, "Invalid query parameters");
        return;
    }
    req.rawQuery = q.trim();
    req.pagination = { page: pg, limit: lim, offset: (pg - 1) * lim };
    next();
}
