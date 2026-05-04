import { Request, Response } from "express";
import { ingestCSV }         from "../services/ingestion.service";
import { Readable }          from "stream";
import busboy                from "busboy";

/**
 * POST /api/profiles/import
 *
 * Accepts a multipart/form-data upload with a CSV file field named "file".
 * Streams the file directly into the ingestion pipeline — never fully
 * buffered in memory.
 *
 * Admin only (enforced at route level).
 */
export async function importProfiles(req: Request, res: Response): Promise<void> {
  const contentType = req.headers["content-type"] ?? "";

  if (!contentType.includes("multipart/form-data")) {
    res.status(400).json({ status: "error", message: "Expected multipart/form-data" });
    return;
  }

  let fileReceived = false;

  const bb = busboy({
    headers: req.headers,
    limits: {
      files:    1,
      fileSize: 200 * 1024 * 1024, // 200MB max
    },
  });

  bb.on("file", async (_fieldname, fileStream, info) => {
    const { mimeType } = info;

    // Accept text/csv or application/octet-stream (some clients send this)
    if (mimeType !== "text/csv" && mimeType !== "application/octet-stream" && mimeType !== "text/plain") {
      fileStream.resume(); // drain the stream
      res.status(400).json({ status: "error", message: "File must be a CSV" });
      return;
    }

    fileReceived = true;

    try {
      const result = await ingestCSV(fileStream as unknown as Readable);
      res.json({ status: "success", ...result });
    } catch (e) {
      console.error("Ingestion error:", e);
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
    res.status(500).json({ status: "error", message: "Upload processing failed" });
  });

  req.pipe(bb);
}