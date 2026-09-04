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
  threadUrl: string;
  activeModel: string | null;
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

// A thread URL looks like https://www.perplexity.ai/search/<uuid>[?...]. Reject
// anything else so a stray non-Perplexity URL can't be navigated to.
const THREAD_URL_RE = /^https:\/\/(www\.)?perplexity\.ai\/search\/[a-zA-Z0-9-]+/;
function resolveStartUrl(threadUrl: string | null | undefined): string {
  if (threadUrl && THREAD_URL_RE.test(threadUrl)) return threadUrl;
  return PERPLEXITY_HOME;
}

export async function search(query: string, timeoutMs: number, threadUrl?: string | null, model?: string | null): Promise<SearchResult> {
  log(`Search: "${query}" (timeout: ${timeoutMs}ms)${threadUrl ? ` [continuing ${threadUrl}]` : ""}${model ? ` [model: ${model}]` : ""}`);
  return runSearch(query, timeoutMs, null, threadUrl, model);
}

export async function searchWithSources(query: string, timeoutMs: number, sources: string[], threadUrl?: string | null, model?: string | null): Promise<SearchResult> {
  log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${timeoutMs}ms)${threadUrl ? ` [continuing ${threadUrl}]` : ""}${model ? ` [model: ${model}]` : ""}`);
  return runSearch(query, timeoutMs, sources, threadUrl, model);
}

// Perplexity virtualizes the message list inside .scrollable-container: turns outside
// the current scroll window keep their [data-workflow-final-text] wrapper element in
// the DOM but with its text content emptied out, rather than being removed entirely.
// This was the actual root cause behind the stale/wrong-turn answers, more fundamental
// than the hydration-timing fixes above — the page loaded with scrollTop at 0 (never
// scrolled), so only the OLDEST few turns stayed "hot" and rendered; every turn sent
// during this session, including brand-new ones, mounted as an empty placeholder until
// this container was actually scrolled toward the bottom. Confirmed directly: dumping
// every matching element showed the true latest answer sitting fully populated at the
// end of the list the moment this scroll ran, previously invisible as an empty node.
// The single in-page reader used for BOTH the pre-send baseline and the post-send
// candidate, so the two are always directly comparable. Returns the newest block that
// actually holds content — skipping empty virtualized-out placeholders and small
// metadata pills (a bare "1 source" label carries the same attribute) — normalized so
// whitespace differences can never make identical text compare as different.
const newestAnswerTextFn = () => {
  const read = (el: Element): string => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("button, [role='button'], [class*='cursor-pointer'], nav, aside, header").forEach((n) => n.remove());
    return ((clone.innerText ?? "")).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  };
  const blocks = Array.from(document.querySelectorAll("[data-workflow-final-text]"));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = read(blocks[i]);
    if (t.length >= 20) return t;
  }
  return "";
};

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector(".scrollable-container");
    if (el) el.scrollTop = el.scrollHeight;
  }).catch(() => {});
}

async function runSearch(query: string, timeoutMs: number, sources: string[] | null, threadUrl?: string | null, model?: string | null): Promise<SearchResult> {
  const page = await newSearchPage();

  try {
    const startUrl = resolveStartUrl(threadUrl);
    log(`Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 10_000 });

    // On a long, heavily-reused thread, the composer toolbar (model picker) and the
    // prior turns' [data-workflow-final-text] blocks can take several seconds to mount
    // AFTER #ask-input itself becomes visible/interactive — the two are not the same
    // readiness signal. Proceeding before this settles caused two real bugs: the model
    // picker button not being found yet (selectModel silently no-ops), and priorCount
    // below being snapshotted too low, which then let the stale-answer extraction bug
    // resurface (grabbing an old turn's answer as if it were new). Poll for the block
    // count to stop changing rather than a blind fixed delay, so a fresh/short thread
    // (already stable at 0) pays ~0 cost while a long thread gets exactly the time it
    // needs, capped so a genuinely stuck page still proceeds rather than hanging.
    await waitForHydration(page, startUrl !== PERPLEXITY_HOME);

    if (model) {
      log(`Selecting model: ${model}...`);
      await selectModel(page, model);
    }
    // Read back whatever the picker actually shows now, regardless of whether a model
    // was requested — this is the only ground truth for whether selectModel's click
    // sequence really took effect, since it can silently no-op on a UI change.
    const activeModel = await getCurrentPickerLabel(page).catch(() => null);
    log(`Active model per picker: ${activeModel ?? "(picker not found)"}`);

    // Snapshot the CONTENT of the newest existing answer, not how many blocks exist.
    // A count is unusable here: virtualization creates and destroys these wrapper
    // elements as the scroll window moves, so the number changes between this snapshot
    // and the polling below for reasons that have nothing to do with a new reply — which
    // is what left extraction returning the *previous* turn's answer. Comparing against
    // the actual text is immune to that churn: the answer to this message is simply the
    // newest populated block whose content differs from what was here beforehand.
    // Both this baseline and the candidate compared against it below MUST be produced
    // by the same reader and the same normalization. An earlier version snapshotted raw
    // innerText here while extraction used the button-stripping reader, so the two
    // strings could never be equal, the "is this still the old answer?" guard never
    // fired, and the previous turn's text was handed back as if it were new.
    // Poll until it settles, too: right after the scroll, the newest turns may still be
    // repopulating, and a baseline taken from a half-mounted list points at an older
    // block than the one actually on screen.
    let priorLastAnswer = "";
    {
      let stableReads = 0;
      const baselineDeadline = Date.now() + 8_000;
      while (Date.now() < baselineDeadline) {
        await scrollToBottom(page);
        const current = await page.evaluate(newestAnswerTextFn);
        if (current === priorLastAnswer) {
          stableReads += 1;
          if (stableReads >= 2) break;
        } else {
          stableReads = 0;
          priorLastAnswer = current;
        }
        await page.waitForTimeout(300);
      }
    }
    log(`Prior newest answer baseline: ${priorLastAnswer ? `"${priorLastAnswer.slice(0, 60)}..."` : "(none)"}`);

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
    // Keep the newly-created turn inside the render window; otherwise its answer
    // mounts as an empty placeholder and extraction reads an older turn instead.
    await scrollToBottom(page);

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
    const answer = await waitForStableAnswer(page, query, timeoutMs, priorLastAnswer);

    log("Extracting sources...");
    const citedSources = await extractSources(page);

    // page.url() after the exchange completes is the thread's real URL — Perplexity
    // assigns it once the first message in a new thread is sent, so a bare-homepage
    // start also ends up here with a resolvable thread URL for the caller to reuse.
    const finalThreadUrl = page.url();
    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}, thread: ${finalThreadUrl}`);
    return { answer, sources: citedSources, threadUrl: finalThreadUrl, activeModel };
  } finally {
    await page.close();
  }
}

// Waits for the composer toolbar to actually mount, using the model-picker button's
// own presence as the readiness signal — a real yes/no fact, not a guess. (Two earlier
// versions of this function polled [data-workflow-final-text].length for two identical
// back-to-back reads and returned as soon as they matched — but on a page that hasn't
// started re-hydrating its history yet, two consecutive reads of 0 look exactly as
// "stable" as a page that's genuinely done, so it kept exiting instantly and fixing
// nothing, on this exact thread, twice.)
//
// isExistingThread tells the second phase whether that ambiguity can even arise: a
// brand-new thread's block count is authentically 0 from the very first read — there
// is no prior history to hydrate, so nothing here can be mistaken for "not started
// yet". Only a continuing thread carries that risk, so only that case pays the extra
// wait: require the count to be *nonzero* and stable for two reads, which a genuinely
// unstarted page can never satisfy (it reads 0), closing the false-stability trap
// instead of just moving it earlier.
async function waitForHydration(page: Page, isExistingThread: boolean, maxWaitMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const label = await getCurrentPickerLabel(page);
    if (label) break;
    await page.waitForTimeout(250);
  }

  if (!isExistingThread) return;

  // Bring the newest turns into the render window before measuring anything — until
  // this runs, recent turns exist only as empty placeholder nodes and the count below
  // reflects whichever old turns happen to be mounted, not reality.
  await scrollToBottom(page);

  // Count-only stability isn't enough: the last block can exist (count already
  // settled) while its own text is still finalizing — citations/formatting attach
  // shortly after the base text renders — so also track the last block's text
  // length, and require BOTH to hold across several consecutive reads spanning a
  // longer real quiet window before trusting the snapshot. This is what let a call
  // fired shortly after a prior answer finished grab that still-settling answer
  // instead of recognizing it as "old" once the new one arrived.
  let lastCount = -1;
  let lastTextLen = -1;
  let sameStreak = 0;
  const REQUIRED_STREAK = 4; // ~1.2s of continuous quiet at 300ms/read
  const confirmDeadline = Date.now() + 12_000;
  while (Date.now() < confirmDeadline) {
    await scrollToBottom(page);
    const [count, textLen] = await page.evaluate(() => {
      const blocks = document.querySelectorAll("[data-workflow-final-text]");
      const last = blocks[blocks.length - 1];
      return [blocks.length, last ? (last.textContent || "").length : 0];
    });
    if (count === lastCount && textLen === lastTextLen) {
      sameStreak += 1;
      if (count > 0 && sameStreak >= REQUIRED_STREAK) return;
    } else {
      sameStreak = 0;
      lastCount = count;
      lastTextLen = textLen;
    }
    await page.waitForTimeout(300);
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

// Waits until the answer text is non-empty and stable (3 identical reads, 500ms apart),
// so the tool does not return while a text answer is still streaming. Widget answers
// (weather, stocks, current time) render as a block, so they settle within the same
// window — the old hard wait for a "N sources" button is gone. Bounded by the timeout.
//
// Only the strong selectors (data-workflow-final-text / data-renderer="lm") are
// polled here. A multi-step research answer can take 20+ seconds to populate them,
// during which the weak fallback selectors (see extractAnswer) can find small,
// unrelated, but perfectly *stable* UI text elsewhere on the page — e.g. a footer
// snippet — and lock onto it after 3 identical reads, long before the real answer
// exists. The weak fallback is therefore held back and tried exactly once, after
// the loop below exhausts the full timeout with no strong answer at all.
async function waitForStableAnswer(page: Page, query: string, timeoutMs: number, priorLastAnswer: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSig = "";
  let stable = 0;
  let lastAnswer = "";
  while (Date.now() < deadline) {
    // Stay pinned to the bottom as the answer streams in — the growing content can
    // otherwise push the new turn back out of the virtualized render window.
    await scrollToBottom(page);
    const ans = await extractAnswer(page, query, false, priorLastAnswer);
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
    await page.waitForTimeout(500);
  }
  // Deadline reached with no stable strong answer at all (not even an unstable one).
  // Last resort: allow the weak fallback selectors for widget-style answers that may
  // never populate the strong containers. Tried exactly once, never during polling.
  if (!lastAnswer) {
    const weak = await extractAnswer(page, query, true, priorLastAnswer);
    if (weak) return weak;
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

// Known Perplexity model-picker entries, as of the 2026-09 UI. The picker button's
// own label is always the *currently selected* model's name, so it can't be matched
// by a fixed selector — instead this list is used both to find the button (whichever
// aria-haspopup="menu" button's text matches one of these) and to find the requested
// item inside the opened menu. If Perplexity adds or renames a model, matching falls
// through to a case-insensitive substring match against whatever the menu actually
// contains, so a close enough name (e.g. "claude opus") still has a chance to work.
export const KNOWN_MODELS = [
  "Best", "Sonar 2", "GPT-5.6 Terra", "GPT-5.6 SolMax", "Gemini 3.7 Flash",
  "Claude Sonnet 5", "Claude Opus 5 Max", "Kimi K3 Thinking", "GLM 5.3 Thinking",
  "Grok 4.6", "Nemotron 3 Ultra Thinking",
];

// Switches the model used for this message via the model picker next to the composer.
// Degrades gracefully (logs and leaves the current model in place) if the picker or the
// requested entry can't be found, rather than failing the whole search over a UI change.
//
// This menu (role="menuitemradio", data-state) is a Radix-style component that listens
// for real pointer events to open/select, not just a "click" DOM event — a JS-synthesized
// element.click() from inside page.evaluate() silently does nothing here. So, matching the
// working pattern in selectSources below: read text/labels inside evaluate (fine, read-only),
// but perform every actual click through a real Playwright locator .click() outside it.
// Reads the model picker button's current label — whatever model is presently active,
// regardless of whether this call is selecting one. Used both to locate the button
// (its text is the only way to find it — it has no stable id/class) and, after any
// selection attempt, to report back what actually ended up active, since the picker's
// own click/menu interactions can silently no-op on a UI change and we'd otherwise have
// no way to tell a successful switch from a silent failure.
async function getCurrentPickerLabel(page: Page): Promise<string | null> {
  return page.evaluate((knownModels: string[]) => {
    const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const btn = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((b) => {
      const text = n(b.textContent || "");
      // "model" (no model actively picked yet, generic label) is a valid resolved
      // state too — a fresh thread's picker reads this, not a specific model name.
      return text === "model" || knownModels.some((m) => text === n(m)) || /^(gpt|claude|gemini|sonar|grok|kimi|glm|nemotron|best)\b/i.test(text);
    });
    return btn ? (btn.textContent || "").trim() : null;
  }, KNOWN_MODELS);
}

async function selectModel(page: Page, model: string): Promise<void> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const target = norm(model);

  const currentLabel = await getCurrentPickerLabel(page);

  if (!currentLabel) {
    log(`WARNING: could not find the model picker button — leaving the current model in place.`);
    return;
  }

  await page.locator('button[aria-haspopup="menu"]').filter({ hasText: currentLabel }).first().click();
  const menuVisible = await page
    .locator('[role="menuitemradio"], [role="menuitem"]')
    .first()
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!menuVisible) {
    log(`WARNING: model picker menu did not open — leaving the current model in place.`);
    return;
  }

  const matchedText = await page.locator('[role="menuitemradio"], [role="menuitem"]').evaluateAll(
    (items, wanted) => {
      const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const candidates = items.map((el) => (el.textContent || "").trim()).filter(Boolean);

      // 1. Exact match.
      const exact = candidates.find((raw) => n(raw) === wanted);
      if (exact) return exact;

      // 2. Item text contains the wanted string (wanted is a substring of a longer label).
      const containsWanted = candidates.find((raw) => n(raw).includes(wanted));
      if (containsWanted) return containsWanted;

      // 3. Wanted string contains the item text — covers e.g. requesting "X Thinking"
      // when the menu only lists the base name "X" (a separate reasoning-mode toggle,
      // not part of the model's own label). Prefer the longest/most specific item so a
      // short generic label doesn't win over a closer one.
      const containedInWanted = candidates
        .filter((raw) => n(raw).length > 0 && wanted.includes(n(raw)))
        .sort((a, b) => b.length - a.length)[0];
      if (containedInWanted) return containedInWanted;

      // 4. Strip a trailing " thinking" modifier from the wanted string and retry both
      // directions — covers a picker that names the item "X" while the wanted string
      // was "X Thinking", or vice versa, without either containing the other verbatim.
      const bareWanted = wanted.replace(/\s+thinking$/, "").trim();
      if (bareWanted !== wanted) {
        const exactBare = candidates.find((raw) => n(raw) === bareWanted);
        if (exactBare) return exactBare;
        const containsBare = candidates.find((raw) => n(raw).includes(bareWanted));
        if (containsBare) return containsBare;
      }

      return null;
    },
    target
  );

  if (!matchedText) {
    log(`WARNING: model "${model}" not found in the picker menu — leaving the current model in place. Known models: ${KNOWN_MODELS.join(", ")}`);
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  await page.locator('[role="menuitemradio"], [role="menuitem"]').filter({ hasText: matchedText }).first().click();
  log(`Selected model: ${matchedText}`);
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape").catch(() => {});
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

async function extractAnswer(page: Page, query: string, allowWeakFallback: boolean, priorLastAnswer: string): Promise<string> {
  return page.evaluate(({ q, allowWeak, priorText }) => {
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

    // Primary strategy: Perplexity marks the rendered final answer with
    // data-workflow-final-text (as of the 2026-09 UI). It is unique, semantic, and
    // excludes tool-call disclosures ("1 step"), reasoning traces and UI chrome, so
    // prefer it over every panel-guessing heuristic below.
    //
    // When continuing an existing thread, earlier turns already have their own stable
    // data-workflow-final-text blocks on the page before the new message is even sent —
    // joining every block, or reading the first one, would silently return a previous
    // turn's answer instead of the new one. priorCount is how many such blocks existed
    // right before this message was sent; only a block appearing after that point is
    // this turn's answer, and only the newest one (last in DOM order) is used, since a
    // second block belongs to the next reply-in-progress, not this one.
    // Not every match is an answer body: small metadata labels (e.g. a bare "1 source"
    // pill) carry this attribute too and can sit last in DOM order, and virtualized-out
    // turns leave behind empty wrapper nodes. Scan backwards past those for the newest
    // block that actually holds content, rather than trusting the final element blindly.
    const norm = (t: string) => t.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const finalTextBlocks = Array.from(document.querySelectorAll("[data-workflow-final-text]"));
    let text = "";
    for (let i = finalTextBlocks.length - 1; i >= 0; i--) {
      const candidate = readText(finalTextBlocks[i]);
      if (norm(candidate).length < 20) continue; // empty placeholder or a metadata pill
      // The newest populated block is this turn's answer only once it differs from the
      // baseline captured before sending. Compared under the same normalization the
      // baseline used, otherwise whitespace alone defeats the check.
      if (priorText && norm(candidate) === priorText) break;
      text = candidate;
      break;
    }

    // Second strategy: the markdown renderer for the answer prose, if the wrapper
    // attribute above is ever absent but the renderer itself is still present. Same
    // reasoning as above: take the newest match, not the first, so a continued thread
    // doesn't fall back to an earlier turn's rendered prose.
    if (!text || text.length < 20) {
      const lmBlocks = Array.from(document.querySelectorAll('[data-renderer="lm"]'));
      const lmCandidate = readText(lmBlocks[lmBlocks.length - 1] ?? null);
      // Same baseline guard as strategy 1. Without it this fallback silently undoes
      // that check: strategy 1 correctly reports "no new answer yet" by returning
      // empty, and this would immediately overwrite that with the previous turn's
      // prose, which the stability loop then locks onto as if it were the reply.
      if (!priorText || norm(lmCandidate) !== priorText) text = lmCandidate;
    }

    // Third strategy (weak — see waitForStableAnswer for why this is gated): the old
    // tabpanel-based heuristic, kept for older/alternate UI states — Perplexity has
    // changed this markup more than once.
    if (allowWeak && (!text || text.length < 20)) {
      text = readText(selectAnswerPanel(Array.from(document.querySelectorAll('[role="tabpanel"]'))));
    }

    // Last resort (weak) — widget answers (weather, stocks, current time, ...) that
    // render outside any of the above and never show a "N sources" button. Fall back
    // to the smallest container inside <main> that holds meaningful text beyond the
    // echoed query. This is the least reliable strategy: it can match small unrelated
    // UI text, so the caller only allows it once the strong strategies above have had
    // the full timeout budget to appear and still found nothing.
    if (allowWeak && (!text || text.length < 20)) {
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
    // Belt and braces across every strategy above, weak fallbacks included: if what we
    // ended up with is just the answer that was already newest before this message was
    // sent, then the reply has not rendered yet — report nothing and let the caller
    // keep polling rather than hand back the previous turn.
    if (priorText && norm(text) === priorText) return "";

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
  }, { q: query, allowWeak: allowWeakFallback, priorText: priorLastAnswer });
}

async function extractSources(page: Page): Promise<Source[]> {
  // Widget answers (weather, stocks, time) have no "N sources" button — only attempt
  // the click when it exists, and bound it tightly (default click timeout is 30s and
  // would otherwise be silently wasted on every widget query).
  const srcBtn = page.locator("button").filter({ hasText: /sources/i }).filter({ hasText: /\d/ }).first();
  if (await srcBtn.count().then((c) => c > 0).catch(() => false)) {
    await srcBtn.click({ timeout: 5_000 }).catch(() => {});
    // Poll for external links to actually appear rather than a blind 2s sleep — the
    // sources panel usually renders well under that; exits as soon as it does, capped
    // at 2s for the rare slow case.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const found = await page.evaluate(
        () => document.querySelectorAll('a[href^="http"]:not([href*="perplexity.ai"])').length > 0
      );
      if (found) break;
      await page.waitForTimeout(150);
    }
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
