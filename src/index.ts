#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated, checkSession } from "./auth.js";
import { ensureBrowser, getFirstPage } from "./browser.js";
import { search, searchWithSources, SearchResult, DEFAULT_TIMEOUT_MS, KNOWN_MODELS } from "./search.js";

const MODEL_DESCRIPTION =
  `Model to use for this message, matched case-insensitively against Perplexity's model picker ` +
  `(exact match preferred, falls back to substring match — e.g. "claude opus" matches "Claude Opus 5 Max"). ` +
  `Known models as of the 2026-09 UI: ${KNOWN_MODELS.join(", ")}. If the name isn't found, the current ` +
  `model is left in place and this is noted in the result rather than failing the search. Omit to use ` +
  `whichever model is currently selected in the account (no picker interaction at all).`;

function formatResult(result: SearchResult): string {
  const threadLine = `\n\nThread: ${result.threadUrl}` +
    ` (pass this as threadUrl to continue this exact conversation instead of starting a new one)`;
  const modelLine = `\nModel: ${result.activeModel ?? "(picker not found — could not confirm which model answered)"}`;
  if (!result.answer) {
    return "No answer found. Perplexity may have changed its structure." + modelLine + threadLine;
  }
  const sourcesText = result.sources.length > 0
    ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
    : "";
  return result.answer + sourcesText + modelLine + threadLine;
}

// --- CLI args ---
const args = process.argv.slice(2);

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_MS = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) * 1000 : DEFAULT_TIMEOUT_MS;

// --- MCP server ---
const mcp = new FastMCP({
  name: "perplexity-web",
  version: "1.2.0",
});

mcp.addTool({
  name: "search",
  description:
    "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources. " +
    "Uses default Perplexity settings. Every call starts a brand-new conversation thread unless " +
    "threadUrl is given, in which case the query is sent as a follow-up in that existing thread " +
    "instead — pass back the 'Thread:' URL from a previous result to keep talking in the same " +
    "conversation (e.g. one that already has context you gave it). Pass model to pick which " +
    "underlying model answers, instead of whatever is currently selected in the Perplexity UI.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    threadUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "A perplexity.ai/search/<id> thread URL from a previous result's 'Thread:' line. " +
        "When given, the query is sent as a follow-up in that thread instead of starting a new " +
        "one. Omit to start a fresh thread."
      ),
    model: z.string().optional().describe(MODEL_DESCRIPTION),
  }),
  execute: async ({ query, threadUrl, model }) => {
    await ensureBrowser();
    const result = await search(query, TIMEOUT_MS, threadUrl ?? null, model ?? null);
    return formatResult(result);
  },
});

mcp.addTool({
  name: "search_advanced",
  description:
    "Search Perplexity.ai with specific source selection. Lets you combine multiple sources (e.g. web + academic). " +
    "Use this when source control matters; prefer `search` for general queries. Supports threadUrl the same way `search` does.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    sources: z
      .array(z.enum(["web", "academic", "social"]))
      .min(1)
      .describe("Sources to search: 'web' (general web), 'academic' (scholarly articles), 'social' (Reddit & forums). Can combine multiple."),
    threadUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "A perplexity.ai/search/<id> thread URL from a previous result's 'Thread:' line, to " +
        "continue that conversation instead of starting a new one."
      ),
    model: z.string().optional().describe(MODEL_DESCRIPTION),
  }),
  execute: async ({ query, sources, threadUrl, model }) => {
    await ensureBrowser();
    const result = await searchWithSources(query, TIMEOUT_MS, sources, threadUrl ?? null, model ?? null);
    return formatResult(result);
  },
});

mcp.addTool({
  name: "login",
  description:
    "Check if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.",
  parameters: z.object({}),
  execute: async () => {
    await ensureBrowser();
    const page = await getFirstPage();
    const authenticated = await checkSession(page);
    if (authenticated) {
      return "Already authenticated on Perplexity.ai.";
    }
    await ensureAuthenticated();
    return "Login successful. You are now authenticated on Perplexity.ai.";
  },
});

// --- Startup ---
async function main() {
  console.error(`[perplexity-web-mcp] Starting (timeout=${TIMEOUT_MS}ms)...`);
  console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
  mcp.start({ transportType: "stdio" });
}

main().catch((err) => {
  console.error("[perplexity-web-mcp] Fatal error:", err);
  process.exit(1);
});
