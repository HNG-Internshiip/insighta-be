/**
 * CSV Import Controller
 *
 * Two upload modes:
 *
 * 1. Sync mode (default, files < 10k rows):
 *    Processes inline and returns the result directly.
 *    Works within Netlify's 10-second execution limit.
 *
 * 2. Async mode (?async=true, files up to 500k rows):
 *    Saves the file to a temp buffer, starts processing in the background,
 *    and immediately returns a job ID. Client polls GET /api/profiles/import/:jobId
 *    for status. This sidesteps the serverless timeout entirely.
 *
 * Why two modes:
 *    A 500k-row file at optimal throughput takes 3-6 seconds of pure DB time.
 *    Netlify Functions hard-kill at 10 seconds including all overhead.
 *    Async mode is the only reliable path for large files on serverless.
 */

import { Request, Response } from "express";
import { ingestCSV }         from "../services/ingestion.service";
import { Readable, PassThrough } from "stream";
import busboy                from "busboy";

// ── In-memory job store ───────────────────────────────────────────────────────
// Sufficient for single-instance deployments.
// For multi-instance: move to Redis or a jobs table.

export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface ImportJob {
  id:         string;
  status:     JobStatus;
  created_at: string;
  completed_at?: string;
  result?:    object;
  error?:     string;
}

const jobs = new Map<string, ImportJob>();

function makeJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Sync upload handler ───────────────────────────────────────────────────────

async function handleSync(req: Request, res: Response): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    res.status(400).json({ status: "error", message: "Expected multipart/form-data" });
    return;
  }

  let fileReceived = false;

  const bb = busboy({
    headers: req.headers,
    limits: { files: 1, fileSize: 50 * 1024 * 1024 }, // 50MB for sync
  });

  bb.on("file", async (_field, fileStream, info) => {
    const { mimeType } = info;
    if (!["text/csv","application/octet-stream","text/plain"].includes(mimeType)) {
      fileStream.resume();
      res.status(400).json({ status: "error", message: "File must be a CSV" });
      return;
    }

    fileReceived = true;

    try {
      const result = await ingestCSV(fileStream as unknown as Readable);
      res.json({ status: "success", mode: "sync", ...result });
    } catch (e) {
      console.error("Sync ingestion error:", e);
      res.status(500).json({ status: "error", message: "Ingestion failed" });
    }
  });

  bb.on("filesLimit", () => {
    res.status(400).json({ status: "error", message: "Only one file per upload" });
  });

  bb.on("finish", () => {
    if (!fileReceived) {
      res.status(400).json({ status: "error", message: "No file field found. Use field name: file" });
    }
  });

  bb.on("error", (e: Error) => {
    console.error("Busboy error:", e);
    if (!res.headersSent) {
      res.status(500).json({ status: "error", message: "Upload processing failed" });
    }
  });

  req.pipe(bb);
}

// ── Async upload handler ──────────────────────────────────────────────────────

async function handleAsync(req: Request, res: Response): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    res.status(400).json({ status: "error", message: "Expected multipart/form-data" });
    return;
  }

  const jobId = makeJobId();
  const job: ImportJob = {
    id:         jobId,
    status:     "pending",
    created_at: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  let fileReceived = false;

  const bb = busboy({
    headers: req.headers,
    limits: { files: 1, fileSize: 200 * 1024 * 1024 }, // 200MB for async
  });

  bb.on("file", (_field, fileStream, info) => {
    const { mimeType } = info;
    if (!["text/csv","application/octet-stream","text/plain"].includes(mimeType)) {
      fileStream.resume();
      jobs.delete(jobId);
      res.status(400).json({ status: "error", message: "File must be a CSV" });
      return;
    }

    fileReceived = true;

    // Buffer the stream into a PassThrough so we can respond immediately
    // then process in the background
    const buffer = new PassThrough();
    fileStream.pipe(buffer);

    // Respond immediately with job ID
    res.status(202).json({
      status:  "accepted",
      job_id:  jobId,
      poll_url: `/api/profiles/import/${jobId}`,
      message: "Upload received. Poll poll_url for status.",
    });

    // Process in background — intentionally not awaited
    void (async () => {
      job.status = "processing";
      try {
        const result = await ingestCSV(buffer);
        job.status       = "done";
        job.completed_at = new Date().toISOString();
        job.result       = result;
      } catch (e) {
        job.status       = "failed";
        job.completed_at = new Date().toISOString();
        job.error        = e instanceof Error ? e.message : "Unknown error";
        console.error("Async ingestion error:", e);
      }
    })();
  });

  bb.on("filesLimit", () => {
    jobs.delete(jobId);
    res.status(400).json({ status: "error", message: "Only one file per upload" });
  });

  bb.on("finish", () => {
    if (!fileReceived) {
      jobs.delete(jobId);
      if (!res.headersSent) {
        res.status(400).json({ status: "error", message: "No file field found. Use field name: file" });
      }
    }
  });

  bb.on("error", (e: Error) => {
    console.error("Busboy error:", e);
    jobs.delete(jobId);
    if (!res.headersSent) {
      res.status(500).json({ status: "error", message: "Upload processing failed" });
    }
  });

  req.pipe(bb);
}

// ── POST /api/profiles/import ─────────────────────────────────────────────────

export async function importProfiles(req: Request, res: Response): Promise<void> {
  const asyncMode = req.query.async === "true";
  if (asyncMode) {
    await handleAsync(req, res);
  } else {
    await handleSync(req, res);
  }
}

// ── GET /api/profiles/import/:jobId ──────────────────────────────────────────

export async function getImportJob(req: Request, res: Response): Promise<void> {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ status: "error", message: "Job not found" });
    return;
  }

  if (job.status === "done") {
    res.json({ status: "success", job_id: job.id, ...job.result });
    return;
  }

  if (job.status === "failed") {
    res.status(500).json({
      status:  "error",
      job_id:  job.id,
      message: job.error ?? "Ingestion failed",
    });
    return;
  }

  // Still processing
  res.json({
    status:     "processing",
    job_id:     job.id,
    created_at: job.created_at,
    message:    "Upload is still being processed. Poll again shortly.",
  });
}