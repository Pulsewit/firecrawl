import { Response } from "express";
import axios, { AxiosError } from "axios";
import { z } from "zod";
import { RequestWithAuth } from "./types";
import { logger as _logger } from "../../lib/logger";

const PLAYWRIGHT_STEALTH_URL =
  "http://playwright-stealth.railway.internal:3003";

const linkedinSearchRequestSchema = z.object({
  keyword: z
    .string()
    .min(2, "keyword must be at least 2 characters")
    .max(120, "keyword must be at most 120 characters"),
  limit: z.number().int().positive().max(50).optional(),
  country: z.string().optional(),
  sinceDays: z.number().int().positive().optional(),
});

type LinkedinSearchRequest = z.infer<typeof linkedinSearchRequestSchema>;

interface LinkedinSearchItem {
  url: string;
  title?: string;
  snippet?: string;
  author?: string;
  publishedDate?: string;
  [key: string]: unknown;
}

interface LinkedinSearchSuccessResponse {
  success: true;
  data: {
    items: LinkedinSearchItem[];
    serpEngine: string;
    fetched: number;
    kept: number;
    latency_ms: number;
  };
}

interface LinkedinSearchErrorResponse {
  success: false;
  error: string;
  details?: unknown;
}

type LinkedinSearchResponse =
  | LinkedinSearchSuccessResponse
  | LinkedinSearchErrorResponse;

export async function linkedinSearchController(
  req: RequestWithAuth<{}, LinkedinSearchRequest, LinkedinSearchResponse>,
  res: Response<LinkedinSearchResponse>,
): Promise<void> {
  const logger = _logger.child({
    teamId: req.auth.team_id,
    module: "linkedin-search",
    method: "linkedinSearchController",
  });

  let body: LinkedinSearchRequest;
  try {
    body = linkedinSearchRequestSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid request body for linkedin search", {
        issues: error.issues,
      });
      res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
      });
      return;
    }
    throw error;
  }

  const internalWorkerToken = process.env.INTERNAL_WORKER_TOKEN;
  if (!internalWorkerToken) {
    logger.error("INTERNAL_WORKER_TOKEN is not configured");
    res.status(500).json({
      success: false,
      error: "Internal configuration error",
    });
    return;
  }

  const startTime = Date.now();

  try {
    logger.info("Proxying linkedin search to playwright-stealth", {
      keyword: body.keyword.slice(0, 60),
      limit: body.limit,
      country: body.country,
      sinceDays: body.sinceDays,
    });

    const response = await axios.post(
      `${PLAYWRIGHT_STEALTH_URL}/linkedin/search`,
      {
        keyword: body.keyword,
        limit: body.limit,
        country: body.country,
        sinceDays: body.sinceDays,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${internalWorkerToken}`,
        },
        timeout: 60_000,
      },
    );

    const latency_ms = Date.now() - startTime;

    logger.info("LinkedIn search completed", {
      latency_ms,
      itemCount: response.data?.items?.length ?? 0,
      serpEngine: response.data?.serpEngine,
    });

    res.status(200).json({
      success: true,
      data: {
        items: response.data?.items ?? [],
        serpEngine: response.data?.serpEngine ?? "unknown",
        fetched: response.data?.fetched ?? 0,
        kept: response.data?.kept ?? 0,
        latency_ms: response.data?.latency_ms ?? latency_ms,
      },
    });
  } catch (error) {
    const latency_ms = Date.now() - startTime;

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      if (axiosError.code === "ECONNREFUSED" || axiosError.code === "ENOTFOUND") {
        logger.error("playwright-stealth service is unreachable", {
          code: axiosError.code,
          url: `${PLAYWRIGHT_STEALTH_URL}/linkedin/search`,
          latency_ms,
        });
        res.status(503).json({
          success: false,
          error: "LinkedIn search service is currently unavailable",
        });
        return;
      }

      if (status === 401 || status === 403) {
        logger.error("playwright-stealth auth error", {
          status,
          latency_ms,
        });
        res.status(500).json({
          success: false,
          error: "Internal authentication error",
        });
        return;
      }

      logger.error("playwright-stealth returned an error", {
        status,
        message: axiosError.message,
        latency_ms,
      });
      res.status(status ?? 500).json({
        success: false,
        error:
          (axiosError.response?.data as any)?.error ??
          axiosError.message ??
          "LinkedIn search failed",
      });
      return;
    }

    logger.error("Unexpected error in linkedin search", { error, latency_ms });
    res.status(500).json({
      success: false,
      error: (error as Error).message ?? "An unexpected error occurred",
    });
  }
}

