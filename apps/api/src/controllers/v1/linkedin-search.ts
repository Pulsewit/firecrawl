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
import { Response } from \"express\";\nimport { config } from \"../../config\";\nimport {\n  Document,\n  RequestWithAuth,\n  SearchResponse,\n  searchRequestSchema,\n} from \"./types\";\nimport { billTeam } from \"../../services/billing/credit_billing\";\nimport { v7 as uuidv7 } from \"uuid\";\nimport { logSearch, logRequest } from \"../../services/logging/log_job\";\nimport { logger as _logger } from \"../../lib/logger\";\nimport type { Logger } from \"winston\";\nimport { ScrapeJobTimeoutError } from \"../../lib/error\";\nimport { captureExceptionWithZdrCheck } from \"../../services/sentry\";\nimport { z } from \"zod\";\nimport { executeSearch } from \"../../search/execute\";\nimport {\n  DocumentWithCostTracking,\n  scrapeSearchResults,\n} from \"../../search/scrape\";\nimport {\n  transformToV1Response,\n  filterDocumentsWithContent,\n} from \"../../search/transform\";\nimport { fromV1ScrapeOptions } from \"../v2/types\";\nimport { getSearchForcedKind } from \"../../lib/zdr-helpers\";\n\n// LinkedIn search request schema - extends the base search schema\nconst linkedinSearchRequestSchema = searchRequestSchema.extend({\n  // LinkedIn-specific parameters\n  searchType: z\n    .enum([\"people\", \"companies\", \"jobs\", \"posts\"])\n    .optional()\n    .prefault(\"people\"),\n  location: z.string().optional(),\n  industry: z.string().optional(),\n  experience: z.string().optional(),\n  skills: z.array(z.string()).optional(),\n});\n\nexport type LinkedinSearchRequest = z.infer<typeof linkedinSearchRequestSchema>;\n\nexport async function linkedinSearchController(\n  req: RequestWithAuth<{}, SearchResponse, LinkedinSearchRequest>,\n  res: Response<SearchResponse>,\n) {\n  const middlewareStartTime =\n    (req as any).requestTiming?.startTime || new Date().getTime();\n  const controllerStartTime = new Date().getTime();\n\n  const jobId = uuidv7();\n  const teamForcedKind = getSearchForcedKind(req.acuc?.flags);\n  const zeroDataRetention = teamForcedKind !== null;\n  const teamEnterprise = teamForcedKind ? [teamForcedKind] : undefined;\n  let logger = _logger.child({\n    jobId,\n    teamId: req.auth.team_id,\n    module: \"linkedin-search\",\n    method: \"linkedinSearchController\",\n    zeroDataRetention,\n    teamForcedKind,\n    searchQuery: req.body.query.slice(0, 100),\n  });\n\n  let responseData: SearchResponse = {\n    success: true,\n    data: [],\n    id: jobId,\n  };\n  const middlewareTime = controllerStartTime - middlewareStartTime;\n  const isSearchPreview =\n    config.SEARCH_PREVIEW_TOKEN !== undefined &&\n    config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;\n\n  try {\n    req.body = linkedinSearchRequestSchema.parse(req.body);\n\n    logger = logger.child({\n      version: \"v1\",\n      query: req.body.query,\n      origin: req.body.origin,\n      searchType: req.body.searchType,\n    });\n\n    await logRequest({\n      id: jobId,\n      kind: \"linkedin-search\",\n      api_version: \"v1\",\n      team_id: req.auth.team_id,\n      origin: req.body.origin ?? \"api\",\n      integration: req.body.integration,\n      target_hint: req.body.query,\n      zeroDataRetention,\n      api_key_id: req.acuc?.api_key_id ?? null,\n    });\n\n    // Convert v1 scrape options to v2 format\n    const { scrapeOptions } = fromV1ScrapeOptions(\n      req.body.scrapeOptions,\n      req.body.timeout,\n      req.auth.team_id,\n    );\n\n    // Check if scraping is requested\n    const shouldScrape =\n      req.body.scrapeOptions.formats &&\n      req.body.scrapeOptions.formats.length > 0;\n\n    // Build LinkedIn-specific search query\n    const linkedinQuery = buildLinkedInQuery(\n      req.body.query,\n      req.body.searchType,\n      {\n        location: req.body.location,\n        industry: req.body.industry,\n        experience: req.body.experience,\n        skills: req.body.skills,\n      },\n    );\n\n    // Execute search using v2 logic with LinkedIn source\n    const result = await executeSearch(\n      {\n        query: linkedinQuery,\n        limit: req.body.limit,\n        sources: [{ type: \"linkedin\", searchType: req.body.searchType }],\n        scrapeOptions: shouldScrape ? scrapeOptions : undefined,\n        timeout: req.body.timeout,\n        enterprise: teamEnterprise,\n      },\n      {\n        teamId: req.auth.team_id,\n        origin: req.body.origin,\n        apiKeyId: req.acuc?.api_key_id ?? null,\n        flags: req.acuc?.flags ?? null,\n        requestId: jobId,\n        jobId,\n        apiVersion: \"v1\",\n        bypassBilling: false,\n        zeroDataRetention,\n        agentIndexOnly: (req as any).agentIndexOnly ?? false,\n      },\n      logger,\n    );\n\n    // Transform v2 response to v1 format (flat array)\n    const docs = transformToV1Response(result.response);\n\n    if (docs.length === 0) {\n      logger.info(\"No LinkedIn search results found\");\n      responseData.warning = \"No LinkedIn search results found\";\n    } else if (shouldScrape) {\n      // Filter documents that have content\n      const filteredDocs = filterDocumentsWithContent(docs);\n\n      if (filteredDocs.length === 0) {\n        responseData.data = docs;\n        responseData.warning = \"No content found in LinkedIn search results\";\n      } else {\n        responseData.data = filteredDocs;\n      }\n    } else {\n      // No scraping - just return basic info\n      responseData.data = docs.map(d => ({\n        url: d.url,\n        title: d.title,\n        description: d.description,\n      })) as Document[];\n    }\n\n    // Bill team for search credits\n    if (!isSearchPreview) {\n      billTeam(\n        req.auth.team_id,\n        req.acuc?.sub_id ?? undefined,\n        result.searchCredits,\n        req.acuc?.api_key_id ?? null,\n        { endpoint: \"linkedin-search\", jobId },\n      ).catch(error => {\n        logger.error(\n          `Failed to bill team ${req.auth.team_id} for ${result.searchCredits} credits: ${error}`,\n        );\n      });\n    }\n\n    const endTime = new Date().getTime();\n    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;\n\n    logSearch(\n      {\n        id: jobId,\n        request_id: jobId,\n        query: req.body.query,\n        is_successful: true,\n        error: undefined,\n        results: responseData.data,\n        num_results: responseData.data.length,\n        time_taken: timeTakenInSeconds,\n        team_id: req.auth.team_id,\n        options: {\n          ...req.body,\n          query: undefined,\n          scrapeOptions: undefined,\n        },\n        credits_cost: result.searchCredits,\n        zeroDataRetention,\n      },\n      false,\n    );\n\n    const totalRequestTime = new Date().getTime() - middlewareStartTime;\n    const controllerTime = new Date().getTime() - controllerStartTime;\n\n    logger.info(\"Request metrics\", {\n      version: \"v1\",\n      mode: \"linkedin-search\",\n      jobId,\n      middlewareStartTime,\n      controllerStartTime,\n      middlewareTime,\n      controllerTime,\n      totalRequestTime,\n      creditsUsed: result.searchCredits,\n      scrapeful: shouldScrape,\n    });\n\n    return res.status(200).json(responseData);\n  } catch (error) {\n    if (error instanceof z.ZodError) {\n      logger.warn(\"Invalid request body\", { error: error.issues });\n      return res.status(400).json({\n        success: false,\n        error: \"Invalid request body\",\n        details: error.issues,\n      });\n    }\n\n    if (error instanceof ScrapeJobTimeoutError) {\n      return res.status(408).json({\n        success: false,\n        code: error.code,\n        error: error.message,\n      });\n    }\n\n    captureExceptionWithZdrCheck(error, {\n      extra: { zeroDataRetention },\n    });\n    logger.error(\"Unhandled error occurred in LinkedIn search\", {\n      version: \"v1\",\n      error,\n    });\n    return res.status(500).json({\n      success: false,\n      error: error.message,\n    });\n  }\n}\n\n/**\n * Build a LinkedIn-specific search query based on search type and filters\n */\nfunction buildLinkedInQuery(\n  baseQuery: string,\n  searchType: string = \"people\",\n  filters: {\n    location?: string;\n    industry?: string;\n    experience?: string;\n    skills?: string[];\n  },\n): string {\n  let query = `site:linkedin.com ${baseQuery}`;\n\n  // Add search type specific prefixes\n  switch (searchType) {\n    case \"people\":\n      query = `site:linkedin.com/in ${baseQuery}`;\n      break;\n    case \"companies\":\n      query = `site:linkedin.com/company ${baseQuery}`;\n      break;\n    case \"jobs\":\n      query = `site:linkedin.com/jobs ${baseQuery}`;\n      break;\n    case \"posts\":\n      query = `site:linkedin.com/feed ${baseQuery}`;\n      break;\n  }\n\n  // Add location filter\n  if (filters.location) {\n    query += ` location:\"${filters.location}\"`;\n  }\n\n  // Add industry filter\n  if (filters.industry) {\n    query += ` industry:\"${filters.industry}\"`;\n  }\n\n  // Add experience filter\n  if (filters.experience) {\n    query += ` experience:\"${filters.experience}\"`;\n  }\n\n  // Add skills filter\n  if (filters.skills && filters.skills.length > 0) {\n    const skillsQuery = filters.skills.map(s => `\"${s}\"`).join(\" OR \");\n    query += ` (${skillsQuery})`;\n  }\n\n  return query;\n}\n
