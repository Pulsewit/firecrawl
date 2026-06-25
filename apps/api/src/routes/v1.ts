import express from "express";
import { config } from "../config";
import { crawlController } from "../controllers/v1/crawl";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import { scrapeController } from "../../src/controllers/v1/scrape";
import { crawlStatusController } from "../controllers/v1/crawl-status";
import { mapController } from "../controllers/v1/map";
import { RequestWithAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { SEARCH_CREDITS_FEATURE_ID } from "../services/autumn/autumn.service";
import expressWs from "express-ws";
import { crawlStatusWSController } from "../controllers/v1/crawl-status-ws";
import { crawlCancelController } from "../controllers/v1/crawl-cancel";
import { scrapeStatusController } from "../controllers/v1/scrape-status";
import { concurrencyCheckController } from "../controllers/v1/concurrency-check";
import { batchScrapeController } from "../controllers/v1/batch-scrape";
import { extractController } from "../controllers/v1/extract";
import { extractStatusController } from "../controllers/v1/extract-status";
import { creditUsageController } from "../controllers/v1/credit-usage";
import { searchController } from "../controllers/v1/search";
import { x402SearchController } from "../controllers/v1/x402-search";
import { linkedinSearchController } from "../controllers/v1/linkedin-search";
import { crawlErrorsController } from "../controllers/v1/crawl-errors";
import { generateLLMsTextController } from "../controllers/v1/generate-llmstxt";
import { generateLLMsTextStatusController } from "../controllers/v1/generate-llmstxt-status";
import { deepResearchController } from "../controllers/v1/deep-research";
import { deepResearchStatusController } from "../controllers/v1/deep-research-status";
import { tokenUsageController } from "../controllers/v1/token-usage";
import { ongoingCrawlsController } from "../controllers/v1/crawl-ongoing";
import { fireclawController } from "../controllers/v1/fireclaw";
import {
  authMiddleware,
  checkCreditsMiddleware,
  blocklistMiddleware,
  countryCheck,
  idempotencyMiddleware,
  requestTimingMiddleware,
  validateJobIdParam,
  wrap,
} from "./shared";
import { queueStatusController } from "../controllers/v1/queue-status";
import { creditUsageHistoricalController } from "../controllers/v1/credit-usage-historical";

import { tokenUsageHistoricalController } from "../controllers/v1/token-usage-historical";
import {
  paymentMiddleware,
  getX402ResourceServer,
  createX402RouteConfig,
  isX402Enabled,
} from "../lib/x402";
import { deprecationMiddleware } from "../lib/deprecations";

expressWs(express());

export const v1Router = express.Router();

// Add timing middleware to all v1 routes
v1Router.use(requestTimingMiddleware("v1"));

// Configure payment middleware to enable micropayment-protected endpoints
// This middleware handles payment verification and processing for premium API features
// x402 payments protocol - https://github.com/coinbase/x402
// v1Router.use(
//   paymentMiddleware(
//     (config.X402_PAY_TO_ADDRESS as `0x${string}`) ||
//       "0x0000000000000000000000000000000000000000",
//     {
//       "POST /x402/search": {
//         price: config.X402_ENDPOINT_PRICE_USD as string,
//         network: config.X402_NETWORK as
//           | "base-sepolia"
//           | "base"
//           | "avalanche-fuji"
//           | "avalanche"
//           | "iotex",
//         config: {
//           discoverable: true,
//           description:
//             "The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol",
//           mimeType: "application/json",
//           maxTimeoutSeconds: 120,
//           inputSchema: {
//             body: {
//               query: {
//                 type: "string",
//                 description: "Search query to find relevant web pages",
//                 required: true,
//               },
//               limit: {
//                 type: "number",
//                 description: "Maximum number of results to return (max 10)",
//                 required: false,
//               },
//               scrapeOptions: {
//                 type: "object",
//                 description: "Options for scraping the found pages",
//                 required: false,
//               },
//             },
//           },
//           outputSchema: {
//             type: "object",
//             properties: {
//               success: { type: "boolean" },
//               data: {
//                 type: "array",
//                 items: {
//                   type: "object",
//                   properties: {
//                     url: { type: "string" },
//                     title: { type: "string" },
//                     description: { type: "string" },
//                     markdown: { type: "string" },
//                   },
//                 },
//               },
//             },
//           },
//         },
//       },
//     },
//     facilitator,
//   ),
// );

v1Router.post(
  "/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(scrapeController),
);

v1Router.post(
  "/crawl",
  authMiddleware(RateLimiterMode.Crawl),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  idempotencyMiddleware,
  wrap(crawlController),
);

v1Router.post(
  "/batch/scrape",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(),
  blocklistMiddleware,
  idempotencyMiddleware,
  wrap(batchScrapeController),
);

v1Router.post(
  "/search",
  authMiddleware(RateLimiterMode.Search),
  countryCheck,
  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID),
  wrap(searchController),
);

v1Router.post(
  "/linkedin/search",
  authMiddleware(RateLimiterMode.Search),
  countryCheck,
  wrap(linkedinSearchController),
);

v1Router.post(
  "/map",
  authMiddleware(RateLimiterMode.Map),
  checkCreditsMiddleware(1),
  blocklistMiddleware,
  wrap(mapController),
);

v1Router.get(
  "/crawl/ongoing",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

// Public facing, same as ongoing
v1Router.get(
  "/crawl/active",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(ongoingCrawlsController),
);

v1Router.get(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  wrap(crawlStatusController),
);

v1Router.get(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  validateJobIdParam,
  // Yes, it uses the same controller as the normal crawl status controller
  wrap((req: any, res): any => crawlStatusController(req, res, true)),
);

v1Router.get(
  "/crawl/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(crawlErrorsController),
);

v1Router.get(
  "/batch/scrape/:jobId/errors",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(crawlErrorsController),
);

v1Router.get(
  "/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(scrapeStatusController),
);

v1Router.get(
  "/concurrency-check",
  authMiddleware(RateLimiterMode.CrawlStatus),
  wrap(concurrencyCheckController),
);

v1Router.ws("/crawl/:jobId", crawlStatusWSController);

v1Router.post(
  "/extract",
  authMiddleware(RateLimiterMode.Extract),
  deprecationMiddleware("v1_extract"),
  countryCheck,
  checkCreditsMiddleware(20),
  wrap(extractController),
);

v1Router.get(
  "/extract/:jobId",
  authMiddleware(RateLimiterMode.ExtractStatus),
  deprecationMiddleware("v1_extract_status"),
  wrap(extractStatusController),
);

v1Router.post(
  "/llmstxt",
  authMiddleware(RateLimiterMode.Scrape),
  deprecationMiddleware("v1_llmstxt"),
  countryCheck,
  blocklistMiddleware,
  wrap(generateLLMsTextController),
);

v1Router.get(
  "/llmstxt/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  deprecationMiddleware("v1_llmstxt_status"),
  wrap(generateLLMsTextStatusController),
);

v1Router.post(
  "/deep-research",
  authMiddleware(RateLimiterMode.Crawl),
  deprecationMiddleware("v1_deep_research"),
  countryCheck,
  checkCreditsMiddleware(1),
  wrap(deepResearchController),
);

v1Router.get(
  "/deep-research/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  deprecationMiddleware("v1_deep_research_status"),
  wrap(deepResearchStatusController),
);

// v1Router.post("/crawlWebsitePreview", crawlPreviewController);

v1Router.delete(
  "/crawl/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  crawlCancelController,
);

v1Router.delete(
  "/batch/scrape/:jobId",
  authMiddleware(RateLimiterMode.CrawlStatus),
  crawlCancelController,
);
// v1Router.get("/checkJobStatus/:jobId", crawlJobStatusPreviewController);

// // Auth route for key based authentication
// v1Router.get("/keyAuth", keyAuthController);

// // Search routes
// v0Router.post("/search", searchController);

// Health/Probe routes
// v1Router.get("/health/liveness", livenessController);
// v1Router.get("/health/readiness", readinessController);

v1Router.post(
  "/fireclaw",
  authMiddleware(RateLimiterMode.Scrape),
  checkCreditsMiddleware(100),
  wrap(fireclawController),
);

v1Router.get(
  "/team/credit-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageController),
);

v1Router.get(
  "/team/credit-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(creditUsageHistoricalController),
);

v1Router.get(
  "/team/token-usage",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageController),
);

v1Router.get(
  "/team/token-usage/historical",
  authMiddleware(RateLimiterMode.Account),
  wrap(tokenUsageHistoricalController),
);

v1Router.get(
  "/team/queue-status",
  authMiddleware(RateLimiterMode.Account),
  wrap(queueStatusController),
);

// Only register x402 routes if X402_PAY_TO_ADDRESS is configured
if (isX402Enabled()) {
  v1Router.post(
    "/x402/search",
    authMiddleware(RateLimiterMode.Search),
    countryCheck,
    paymentMiddleware(
      createX402RouteConfig(
        "POST /x402/search",
        "The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol",
        {},
        {},
      ),
      getX402ResourceServer(),
    ),
    wrap(x402SearchController),
  );
}
import express from \"express\";\nimport { config } from \"../config\";\nimport { crawlController } from \"../controllers/v1/crawl\";\n// import { crawlStatusController } from \"../../src/controllers/v1/crawl-status\";\nimport { scrapeController } from \"../../src/controllers/v1/scrape\";\nimport { crawlStatusController } from \"../controllers/v1/crawl-status\";\nimport { mapController } from \"../controllers/v1/map\";\nimport { RequestWithAuth } from \"../controllers/v1/types\";\nimport { RateLimiterMode } from \"../types\";\nimport { SEARCH_CREDITS_FEATURE_ID } from \"../services/autumn/autumn.service\";\nimport expressWs from \"express-ws\";\nimport { crawlStatusWSController } from \"../controllers/v1/crawl-status-ws\";\nimport { crawlCancelController } from \"../controllers/v1/crawl-cancel\";\nimport { scrapeStatusController } from \"../controllers/v1/scrape-status\";\nimport { concurrencyCheckController } from \"../controllers/v1/concurrency-check\";\nimport { batchScrapeController } from \"../controllers/v1/batch-scrape\";\nimport { extractController } from \"../controllers/v1/extract\";\nimport { extractStatusController } from \"../controllers/v1/extract-status\";\nimport { creditUsageController } from \"../controllers/v1/credit-usage\";\nimport { searchController } from \"../controllers/v1/search\";\nimport { linkedinSearchController } from \"../controllers/v1/linkedin-search\";\nimport { x402SearchController } from \"../controllers/v1/x402-search\";\nimport { crawlErrorsController } from \"../controllers/v1/crawl-errors\";\nimport { generateLLMsTextController } from \"../controllers/v1/generate-llmstxt\";\nimport { generateLLMsTextStatusController } from \"../controllers/v1/generate-llmstxt-status\";\nimport { deepResearchController } from \"../controllers/v1/deep-research\";\nimport { deepResearchStatusController } from \"../controllers/v1/deep-research-status\";\nimport { tokenUsageController } from \"../controllers/v1/token-usage\";\nimport { ongoingCrawlsController } from \"../controllers/v1/crawl-ongoing\";\nimport { fireclawController } from \"../controllers/v1/fireclaw\";\nimport {\n  authMiddleware,\n  checkCreditsMiddleware,\n  blocklistMiddleware,\n  countryCheck,\n  idempotencyMiddleware,\n  requestTimingMiddleware,\n  validateJobIdParam,\n  wrap,\n} from \"./shared\";\nimport { queueStatusController } from \"../controllers/v1/queue-status\";\nimport { creditUsageHistoricalController } from \"../controllers/v1/credit-usage-historical\";\n\nimport { tokenUsageHistoricalController } from \"../controllers/v1/token-usage-historical\";\nimport {\n  paymentMiddleware,\n  getX402ResourceServer,\n  createX402RouteConfig,\n  isX402Enabled,\n} from \"../lib/x402\";\nimport { deprecationMiddleware } from \"../lib/deprecations\";\n\nexpressWs(express());\n\nexport const v1Router = express.Router();\n\n// Add timing middleware to all v1 routes\nv1Router.use(requestTimingMiddleware(\"v1\"));\n\n// Configure payment middleware to enable micropayment-protected endpoints\n// This middleware handles payment verification and processing for premium API features\n// x402 payments protocol - https://github.com/coinbase/x402\n// v1Router.use(\n//   paymentMiddleware(\n//     (config.X402_PAY_TO_ADDRESS as `0x${string}`) ||\n//       \"0x0000000000000000000000000000000000000000\",\n//     {\n//       \"POST /x402/search\": {\n//         price: config.X402_ENDPOINT_PRICE_USD as string,\n//         network: config.X402_NETWORK as\n//           | \"base-sepolia\"\n//           | \"base\"\n//           | \"avalanche-fuji\"\n//           | \"avalanche\"\n//           | \"iotex\",\n//         config: {\n//           discoverable: true,\n//           description:\n//             \"The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol\",\n//           mimeType: \"application/json\",\n//           maxTimeoutSeconds: 120,\n//           inputSchema: {\n//             body: {\n//               query: {\n//                 type: \"string\",\n//                 description: \"Search query to find relevant web pages\",\n//                 required: true,\n//               },\n//               limit: {\n//                 type: \"number\",\n//                 description: \"Maximum number of results to return (max 10)\",\n//                 required: false,\n//               },\n//               scrapeOptions: {\n//                 type: \"object\",\n//                 description: \"Options for scraping the found pages\",\n//                 required: false,\n//               },\n//             },\n//           },\n//           outputSchema: {\n//             type: \"object\",\n//             properties: {\n//               success: { type: \"boolean\" },\n//               data: {\n//                 type: \"array\",\n//                 items: {\n//                   type: \"object\",\n//                   properties: {\n//                     url: { type: \"string\" },\n//                     title: { type: \"string\" },\n//                     description: { type: \"string\" },\n//                     markdown: { type: \"string\" },\n//                   },\n//                 },\n//               },\n//             },\n//           },\n//         },\n//       },\n//     },\n//     facilitator,\n//   ),\n// );\n\nv1Router.post(\n  \"/scrape\",\n  authMiddleware(RateLimiterMode.Scrape),\n  countryCheck,\n  checkCreditsMiddleware(1),\n  blocklistMiddleware,\n  wrap(scrapeController),\n);\n\nv1Router.post(\n  \"/crawl\",\n  authMiddleware(RateLimiterMode.Crawl),\n  countryCheck,\n  checkCreditsMiddleware(),\n  blocklistMiddleware,\n  idempotencyMiddleware,\n  wrap(crawlController),\n);\n\nv1Router.post(\n  \"/batch/scrape\",\n  authMiddleware(RateLimiterMode.Scrape),\n  countryCheck,\n  checkCreditsMiddleware(),\n  blocklistMiddleware,\n  idempotencyMiddleware,\n  wrap(batchScrapeController),\n);\n\nv1Router.post(\n  \"/search\",\n  authMiddleware(RateLimiterMode.Search),\n  countryCheck,\n  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID),\n  wrap(searchController),\n);\n\nv1Router.post(\n  \"/linkedin/search\",\n  authMiddleware(RateLimiterMode.Search),\n  countryCheck,\n  checkCreditsMiddleware(undefined, SEARCH_CREDITS_FEATURE_ID),\n  wrap(linkedinSearchController),\n);\n\nv1Router.post(\n  \"/map\",\n  authMiddleware(RateLimiterMode.Map),\n  checkCreditsMiddleware(1),\n  blocklistMiddleware,\n  wrap(mapController),\n);\n\nv1Router.get(\n  \"/crawl/ongoing\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(ongoingCrawlsController),\n);\n\n// Public facing, same as ongoing\nv1Router.get(\n  \"/crawl/active\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(ongoingCrawlsController),\n);\n\nv1Router.get(\n  \"/crawl/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  validateJobIdParam,\n  wrap(crawlStatusController),\n);\n\nv1Router.get(\n  \"/batch/scrape/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  validateJobIdParam,\n  // Yes, it uses the same controller as the normal crawl status controller\n  wrap((req: any, res): any => crawlStatusController(req, res, true)),\n);\n\nv1Router.get(\n  \"/crawl/:jobId/errors\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(crawlErrorsController),\n);\n\nv1Router.get(\n  \"/batch/scrape/:jobId/errors\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(crawlErrorsController),\n);\n\nv1Router.get(\n  \"/scrape/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(scrapeStatusController),\n);\n\nv1Router.get(\n  \"/concurrency-check\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  wrap(concurrencyCheckController),\n);\n\nv1Router.ws(\"/crawl/:jobId\", crawlStatusWSController);\n\nv1Router.post(\n  \"/extract\",\n  authMiddleware(RateLimiterMode.Extract),\n  deprecationMiddleware(\"v1_extract\"),\n  countryCheck,\n  checkCreditsMiddleware(20),\n  wrap(extractController),\n);\n\nv1Router.get(\n  \"/extract/:jobId\",\n  authMiddleware(RateLimiterMode.ExtractStatus),\n  deprecationMiddleware(\"v1_extract_status\"),\n  wrap(extractStatusController),\n);\n\nv1Router.post(\n  \"/llmstxt\",\n  authMiddleware(RateLimiterMode.Scrape),\n  deprecationMiddleware(\"v1_llmstxt\"),\n  countryCheck,\n  blocklistMiddleware,\n  wrap(generateLLMsTextController),\n);\n\nv1Router.get(\n  \"/llmstxt/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  deprecationMiddleware(\"v1_llmstxt_status\"),\n  wrap(generateLLMsTextStatusController),\n);\n\nv1Router.post(\n  \"/deep-research\",\n  authMiddleware(RateLimiterMode.Crawl),\n  deprecationMiddleware(\"v1_deep_research\"),\n  countryCheck,\n  checkCreditsMiddleware(1),\n  wrap(deepResearchController),\n);\n\nv1Router.get(\n  \"/deep-research/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  deprecationMiddleware(\"v1_deep_research_status\"),\n  wrap(deepResearchStatusController),\n);\n\n// v1Router.post(\"/crawlWebsitePreview\", crawlPreviewController);\n\nv1Router.delete(\n  \"/crawl/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  crawlCancelController,\n);\n\nv1Router.delete(\n  \"/batch/scrape/:jobId\",\n  authMiddleware(RateLimiterMode.CrawlStatus),\n  crawlCancelController,\n);\n// v1Router.get(\"/checkJobStatus/:jobId\", crawlJobStatusPreviewController);\n\n// // Auth route for key based authentication\n// v1Router.get(\"/keyAuth\", keyAuthController);\n\n// // Search routes\n// v0Router.post(\"/search\", searchController);\n\n// Health/Probe routes\n// v1Router.get(\"/health/liveness\", livenessController);\n// v1Router.get(\"/health/readiness\", readinessController);\n\nv1Router.post(\n  \"/fireclaw\",\n  authMiddleware(RateLimiterMode.Scrape),\n  checkCreditsMiddleware(100),\n  wrap(fireclawController),\n);\n\nv1Router.get(\n  \"/team/credit-usage\",\n  authMiddleware(RateLimiterMode.Account),\n  wrap(creditUsageController),\n);\n\nv1Router.get(\n  \"/team/credit-usage/historical\",\n  authMiddleware(RateLimiterMode.Account),\n  wrap(creditUsageHistoricalController),\n);\n\nv1Router.get(\n  \"/team/token-usage\",\n  authMiddleware(RateLimiterMode.Account),\n  wrap(tokenUsageController),\n);\n\nv1Router.get(\n  \"/team/token-usage/historical\",\n  authMiddleware(RateLimiterMode.Account),\n  wrap(tokenUsageHistoricalController),\n);\n\nv1Router.get(\n  \"/team/queue-status\",\n  authMiddleware(RateLimiterMode.Account),\n  wrap(queueStatusController),\n);\n\n// Only register x402 routes if X402_PAY_TO_ADDRESS is configured\nif (isX402Enabled()) {\n  v1Router.post(\n    \"/x402/search\",\n    authMiddleware(RateLimiterMode.Search),\n    countryCheck,\n    paymentMiddleware(\n      createX402RouteConfig(\n        \"POST /x402/search\",\n        \"The search endpoint combines web search (SERP) with Firecrawl's scraping capabilities to return full page content for any query. Requires micropayment via X402 protocol\",\n        {},\n        {},\n      ),\n      getX402ResourceServer(),\n    ),\n    wrap(x402SearchController),\n  );\n}\n
