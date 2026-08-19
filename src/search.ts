import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 90_000;

// Maps source name to its SVG icon id in the Perplexity UI — locale-independent
const SOURCE_ICON: Record<string, string> = {
  web:      "#pplx-icon-world",
  academic: "#pplx-icon-books",
  social:   "#pplx-icon-social",
};

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult {
  answer: string;
  sources: Source[];
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

export async function search(query: string, timeoutMs: number): Promise<SearchResult> {
  log(`Search: "${query}" (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, null);
}

export async function searchWithSources(query: string, timeoutMs: number, sources: string[]): Promise<SearchResult> {
  log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, sources);
}

async function runSearch(query: string, timeoutMs: number, sources: string[] | null): Promise<SearchResult> {
  const page = await newSearchPage();

  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 10_000 });

    if (sources) {
      log(`Selecting sources: [${sources.join(", ")}]...`);
      await selectSources(page, sources);
    }

    log("Typing query...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const searchBox = page.locator("#ask-input").first();
    await searchBox.waitFor({ state: "visible", timeout: 10_000 }).catch(async (err) => {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
      log(`DOM dump (first 5000 chars):\n${bodyHtml}`);
      throw err;
    });
    await searchBox.click();
    // Source selection inserts @mention chips (e.g. "Academic") into the composer;
    // fill() does not clear them, which corrupted queries into "@Academic <query>".
    // Select-all + delete clears the composer reliably, chips included.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await searchBox.fill(query);
    await searchBox.press("Enter");
    await dismissDialogs(page);

    // Perplexity sometimes answers with a clarifying question (numbered options +
    // a "Skip" button) instead of a direct answer; skip it so the search proceeds
    // with Perplexity's default interpretation. Also checked inside the wait loop
    // in case the prompt appears late.
    await page.waitForTimeout(1500);
    await skipClarification(page);

    // NOTE: there is deliberately no hard wait for the "N sources" button here anymore.
    // Live-data answers (weather, stocks, current time, ...) render as widgets outside
    // [role=tabpanel] and never show a source count, so gating on it made every such
    // query hang until timeout. waitForStableAnswer below is the single source of truth:
    // it polls for any answer content (widget or text) and decides when it is done.
    log("Waiting for answer text to stabilize...");
    const answer = await waitForStableAnswer(page, query, timeoutMs);

    log("Extracting sources...");
    const citedSources = await extractSources(page);

    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}`);
    return { answer, sources: citedSources };
  } finally {
    await page.close();
  }
}

// Ticking live data (stock clocks, weather "updated at" stamps, current time) would
// otherwise reset the stability counter forever. Normalize those away before comparing
// so only real content changes (a streaming text answer growing) reset stability.
// The returned answer is always the raw, unstripped text.
function stabilitySignature(text: string): string {
  const normalized = text
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|EDT|EST|PDT|PST|JST|CET|UTC(?:[+-]\d{1,2})?)?\b/gi,
      ""
    )
    .replace(/\s+/g, " ");
  return `${normalized.length}:${normalized.slice(0, 120)}`;
}

// Waits until the answer text is non-empty and stable (3 identical reads, 1s apart),
// so the tool does not return while a text answer is still streaming. Widget answers
// (weather, stocks, current time) render as a block, so they settle within the same
// window — the old hard wait for a "N sources" button is gone. Bounded by the timeout.
async function waitForStableAnswer(page: Page, query: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSig = "";
  let stable = 0;
  let lastAnswer = "";
  while (Date.now() < deadline) {
    const ans = await extractAnswer(page, query);
    if (ans.length >= 20) {
      const sig = stabilitySignature(ans);
      if (sig === lastSig) {
        stable += 1;
        if (stable >= 3) return ans;
      } else {
        stable = 0;
        lastSig = sig;
      }
      lastAnswer = ans;
    } else {
      stable = 0;
      lastSig = "";
      await skipClarification(page);
    }
    await page.waitForTimeout(1000);
  }
  return lastAnswer;
}

// Perplexity's clarification prompt ("Which aspect are you interested in?" with
// numbered options) blocks the answer until a choice is made. The MCP tool cannot
// present options, so click "Skip" to get the default answer. Cheap when absent.
async function skipClarification(page: Page): Promise<void> {
  // The button renders as "Skip⌃Enter" (a "Skip" label plus a keyboard hint), so
  // match on the "Skip" prefix rather than the whole text.
  const skip = page.locator("button").filter({ hasText: /^skip/i }).first();
  const visible = await skip.isVisible({ timeout: 0 }).catch(() => false);
  if (visible) {
    log("Clarification prompt detected — clicking Skip.");
    await skip.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

// Selects the given sources in the Perplexity "Connectors" submenu.
// Icon IDs are locale-independent — they don't change with UI language.
// If the UI cannot be driven (Perplexity changes its menus), degrades gracefully
// to a plain search instead of failing the whole request.
async function selectSources(page: Page, sources: string[]): Promise<void> {
  const targetIcons = sources.map((s) => SOURCE_ICON[s]).filter(Boolean);
  if (targetIcons.length === 0) return;

  // Open the "+" menu. Current UI: "Add files or tools" (#pplx-icon-custom-plus-large);
  // older UI used #pplx-icon-plus. Resolve by icon first, aria-label as fallback.
  const addBtnLabel = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((b) => {
      const use = b.querySelector("use");
      const href = use ? (use.getAttribute("xlink:href") || use.getAttribute("href")) : "";
      if (href === "#pplx-icon-custom-plus-large" || href === "#pplx-icon-plus") return true;
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      return label.includes("add") || label.includes("ajouter");
    });
    return btn?.getAttribute("aria-label") ?? null;
  });
  if (!addBtnLabel) {
    log("WARNING: could not find the + (add) button — running plain search without source filters.");
    return;
  }
  await page.locator(`button[aria-label="${addBtnLabel}"]`).click();
  await page.waitForTimeout(300);

  // Open the "Connectors" submenu — located by its icon #pplx-icon-plug
  const connLabel = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => {
      const use = el.querySelector("use");
      const href = use ? (use.getAttribute("xlink:href") || use.getAttribute("href")) : "";
      return href === "#pplx-icon-plug" || (el.textContent || "").toLowerCase().includes("connector");
    });
    return item?.getAttribute("aria-label") ?? item?.textContent?.trim() ?? null;
  });
  if (!connLabel) {
    log("WARNING: could not find the 'Connectors' submenu — running plain search without source filters.");
    await page.keyboard.press("Escape");
    return;
  }
  await page.locator('[role="menuitem"]').filter({ hasText: connLabel.slice(0, 10) }).click();
  await page
    .locator('[role="menuitemcheckbox"]')
    .first()
    .waitFor({ state: "visible", timeout: 3_000 })
    .catch(() => {
      log("WARNING: source checkboxes did not appear — running plain search without source filters.");
    });

  // Read current state of all checkboxes
  const getCheckboxInfo = (iconId: string) => page.evaluate((id) => {
    const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find((el) => {
      const use = el.querySelector("use");
      return use && (use.getAttribute("xlink:href") === id || use.getAttribute("href") === id);
    });
    return item ? { label: item.getAttribute("aria-label") ?? item.textContent?.trim() ?? "", checked: item.getAttribute("aria-checked") === "true" } : null;
  }, iconId);

  // Build the desired state: check targets, uncheck everything else
  const allIcons = Object.values(SOURCE_ICON);
  for (const icon of allIcons) {
    const info = await getCheckboxInfo(icon);
    if (!info || !info.label) continue;
    const shouldBeChecked = targetIcons.includes(icon);
    if (info.checked !== shouldBeChecked) {
      await page.locator('[role="menuitemcheckbox"]').filter({ hasText: info.label }).click();
      await page.waitForTimeout(200);
    }
  }

  // Close menus
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function dismissDialogs(page: Page): Promise<void> {
  // Cookie banner — "Cookies nécessaires" / "Necessary cookies"
  const cookieBtn = page.locator(
    'button:has-text("Cookies nécessaires"), button:has-text("Necessary cookies")'
  ).first();
  if (await cookieBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing cookie banner...");
    await cookieBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Login/signup overlay — Perplexity renders this as a generic div, not a <dialog>.
  // The close button text is "Fermer" (FR) or has aria-label "Close" (EN).
  const closeBtn = page.locator(
    'button:has-text("Fermer"), button[aria-label="Close"], button[aria-label="Fermer"]'
  ).first();
  if (await closeBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing login overlay...");
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function extractAnswer(page: Page, query: string): Promise<string> {
  return page.evaluate((q) => {
    // Reads an element's text with interactive chrome (buttons, nav, headers) removed.
    const readText = (el: Element | null): string => {
      if (!el) return "";
      const clone = el.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll("button, [role='button'], [class*='cursor-pointer'], nav, aside, header")
        .forEach((n) => n.remove());
      return (clone.innerText ?? "").replace(/\u00a0/g, " ");
    };

    const selectAnswerPanel = (panels: Element[]): Element | null => {
      const queryText = (q || "").trim();
      // The answer panel echoes the user's query; prefer it over the "Sources"/"Shopping" panels.
      if (queryText) {
        const byQuery = panels.find((p) => (p.textContent || "").includes(queryText));
        if (byQuery) return byQuery;
      }
      return (
        panels.find((p) => /sources/i.test(p.textContent || "") && /\d/.test(p.textContent || "")) ??
        panels.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length)[0] ??
        null
      );
    };

    let text = readText(selectAnswerPanel(Array.from(document.querySelectorAll('[role="tabpanel"]'))));

    // Widget answers (weather, stocks, current time, ...) render outside [role=tabpanel]
    // and never show a "N sources" button. Fall back to the smallest container inside
    // <main> that holds meaningful text beyond the echoed query.
    if (!text || text.length < 20) {
      const main = document.querySelector("main");
      const queryText = (q || "").trim();
      let best: Element | null = null;
      let bestLen = Infinity;
      if (main) {
        // inline escape — this code runs inside the page, no module scope available
        const re = queryText ? new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : null;
        main.querySelectorAll("div, section, article").forEach((el) => {
          const raw = el.textContent || "";
          const rest = re ? raw.replace(re, "") : raw;
          const restLen = rest.trim().length;
          if (restLen >= 20 && restLen < bestLen) {
            bestLen = restLen;
            best = el;
          }
        });
      }
      if (best) text = readText(best);
    }

    if (!text) return "";

    // Normalize noise that is often glued onto the answer (no line breaks around it):
    // the "Searching the web" indicator and the echoed query.
    text = text
      .replace(/searching the web\.{0,3}/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const queryTrimmed = (q || "").trim();
    if (queryTrimmed && text.startsWith(queryTrimmed)) {
      text = text.slice(queryTrimmed.length).trim();
    }

    // Separate glued hour chips in weather/stock widgets ("3 PM4 PM5 PM") so the
    // noise filter below can drop them as standalone lines.
    text = text.replace(/(\d{1,2}\s?(?:AM|PM))\s*(?=\d{1,2}\s?(?:AM|PM))/gi, "$1\n");

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // Cut everything from a "Follow-ups" marker, even when it is glued onto the
    // last answer line ("...is Paris.Follow-ups").
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].search(/follow[- ]?ups?/i);
      if (idx !== -1) {
        const head = lines[i].slice(0, idx).trim();
        lines.length = i + (head ? 1 : 0);
        if (head) lines[i] = head;
        break;
      }
    }

    // Filter residual UI chrome: pure "Searching..." lines, source counts, hour chips
    // from weather/stock widgets, and the widget tab labels ("Answer", "Links", ...).
    return lines
      .filter((l) => (
        !/^searching( the web)?\.{0,3}$/i.test(l) &&
        !/^\d+\s*sources$/i.test(l) &&
        !/^\d{1,2}(?::\d{2})?\s*(?:AM|PM)$/i.test(l) &&
        !/^(answer|links|images|share|follow|new|computer|artifacts|connectors|customize|price alert)$/i.test(l)
      ))
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }, query);
}

async function extractSources(page: Page): Promise<Source[]> {
  // Widget answers (weather, stocks, time) have no "N sources" button — only attempt
  // the click when it exists, and bound it tightly (default click timeout is 30s and
  // would otherwise be silently wasted on every widget query).
  const srcBtn = page.locator("button").filter({ hasText: /sources/i }).filter({ hasText: /\d/ }).first();
  if (await srcBtn.count().then((c) => c > 0).catch(() => false)) {
    await srcBtn.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  return page.evaluate(() => {
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((link) => {
      const url = link.href;
      if (seen.has(url) || url.includes("perplexity.ai")) return;
      seen.add(url);
      const title = link.textContent?.trim() || new URL(url).hostname;
      sources.push({ title, url });
    });

    return sources.slice(0, 10);
  });
}
