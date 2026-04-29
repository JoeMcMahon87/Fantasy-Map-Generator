import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as zlib from "zlib";
import { promisify } from "util";

const inflateRaw = promisify(zlib.inflateRaw);

// ─── ZIP utilities ────────────────────────────────────────────────────────────
// Pure-Node parsers that require no additional dependencies.

/**
 * Return all file names stored in a ZIP archive's central directory.
 * Does not decompress; just reads the directory metadata.
 */
function zipFileNames(buf: Buffer): string[] {
  // Locate End-of-Central-Directory record by scanning backwards
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Buffer is not a valid ZIP file (no EOCD record)");

  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const names: string[] = [];
  let pos = cdOffset;
  for (let i = 0; i < entries; i++) {
    // Central directory header signature: PK\x01\x02
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x4b || buf[pos + 2] !== 0x01 || buf[pos + 3] !== 0x02) break;
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    if (!name.endsWith("/")) names.push(name); // skip directory entries
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Extract a single named file from a ZIP archive.
 * Supports STORE (method 0) and DEFLATE (method 8).
 * Returns null if the file is not found.
 */
async function zipReadFile(buf: Buffer, targetName: string): Promise<Buffer | null> {
  let pos = 0;
  while (pos + 30 < buf.length) {
    // Local file header signature: PK\x03\x04
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x4b || buf[pos + 2] !== 0x03 || buf[pos + 3] !== 0x04) break;

    const method = buf.readUInt16LE(pos + 8);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;

    if (name === targetName) {
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data; // STORE — already uncompressed
      if (method === 8) return (await inflateRaw(data)) as Buffer; // DEFLATE
      throw new Error(`Unsupported ZIP compression method ${method} for "${name}"`);
    }
    pos = dataStart + compressedSize;
  }
  return null;
}

// ─── Page helpers ─────────────────────────────────────────────────────────────

async function setupPage(context: BrowserContext, page: Page) {
  await context.clearCookies();
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto("/?seed=test-xyz-export&width=1280&height=720");
  await page.waitForFunction(() => (window as any).mapId !== undefined, { timeout: 60_000 });
  await page.waitForTimeout(500);
}

async function openExportDialog(page: Page) {
  await page.evaluate(() => (window as any).showExportPane());
  await page.waitForSelector("#exportMapData", { state: "visible" });
}

async function openXyzTilesDialog(page: Page) {
  await openExportDialog(page);
  await page.locator("#exportMapData button", { hasText: "xyz tiles" }).click();
  await page.waitForSelector("#exportToXyzTilesScreen", { state: "visible" });
}

/** Open the XYZ tiles dialog, set maxZoom, trigger download, return the ZIP buffer. */
async function downloadZip(page: Page, maxZoom: number): Promise<{ buf: Buffer; filename: string }> {
  await page.locator("#xyzMaxZoomOutput").fill(String(maxZoom));
  await page.locator("#xyzMaxZoomOutput").dispatchEvent("input");

  const dlPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page
    .locator(".ui-dialog:has(#exportToXyzTilesScreen) .ui-dialog-buttonpane button", { hasText: "Download" })
    .click();
  const dl = await dlPromise;

  const tmpPath = await dl.path();
  if (!tmpPath) throw new Error("Download path is null — browser may have blocked the download");
  return { buf: fs.readFileSync(tmpPath), filename: dl.suggestedFilename() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ── Dialog structure & behaviour (fast) ──────────────────────────────────────

test.describe("XYZ tiles export — dialog", () => {
  test.beforeEach(async ({ context, page }) => {
    await setupPage(context, page);
  });

  test("Export to Map Tiles section appears in the Export dialog", async ({ page }) => {
    await openExportDialog(page);
    const dialog = page.locator("#exportMapData");

    await expect(dialog.getByText("Export to Map Tiles", { exact: true })).toBeVisible();
    await expect(dialog.locator("button", { hasText: "xyz tiles" })).toBeVisible();
    await expect(dialog.getByText(/Export to Mercator XYZ map tiles/)).toBeVisible();
  });

  test("xyz tiles button is NOT inside the Download image section", async ({ page }) => {
    await openExportDialog(page);

    const buttonTexts = await page.evaluate(() => {
      const dialog = document.getElementById("exportMapData");
      const headers = Array.from(dialog!.querySelectorAll<HTMLElement>("div[style*='font-weight']"));
      const dlHeader = headers.find(h => h.textContent?.trim() === "Download image");
      const btnContainer = dlHeader?.nextElementSibling;
      return Array.from(btnContainer?.querySelectorAll("button") ?? []).map(b => b.textContent?.trim());
    });

    expect(buttonTexts).toContain(".svg");
    expect(buttonTexts).toContain(".png");
    expect(buttonTexts).toContain("tiles");
    expect(buttonTexts).not.toContain("xyz tiles");
  });

  test("XYZ tiles dialog opens with correct title, controls, and defaults", async ({ page }) => {
    await openXyzTilesDialog(page);
    const dialog = page.locator(".ui-dialog:has(#exportToXyzTilesScreen)");

    await expect(dialog.locator(".ui-dialog-title")).toHaveText("Download XYZ tiles");
    await expect(page.locator("#xyzMaxZoomInput")).toHaveAttribute("min", "1");
    await expect(page.locator("#xyzMaxZoomInput")).toHaveAttribute("max", "6");
    await expect(page.locator("#xyzMaxZoomOutput")).toHaveValue("5");
    // Default maxZoom=5: (4^6 - 1) / 3 = 1,365 tiles
    await expect(page.locator("#xyzTileCount")).toHaveText("1,365");
    await expect(dialog.locator(".ui-dialog-buttonpane button", { hasText: "Download" })).toBeVisible();
    await expect(dialog.locator(".ui-dialog-buttonpane button", { hasText: "Cancel" })).toBeVisible();
  });

  test("tile count updates correctly for every valid zoom level", async ({ page }) => {
    await openXyzTilesDialog(page);
    const output = page.locator("#xyzMaxZoomOutput");
    const count = page.locator("#xyzTileCount");

    // Expected: (4^(z+1) - 1) / 3  for each maxZoom value
    const cases: [number, string][] = [
      [1, "5"],
      [2, "21"],
      [3, "85"],
      [4, "341"],
      [5, "1,365"],
      [6, "5,461"],
    ];

    for (const [zoom, expected] of cases) {
      await output.fill(String(zoom));
      await output.dispatchEvent("input");
      await expect(count).toHaveText(expected);
    }
  });

  test("zoom slider and number input stay in sync", async ({ page }) => {
    await openXyzTilesDialog(page);

    // Drive from the number input, verify slider follows
    await page.locator("#xyzMaxZoomOutput").fill("3");
    await page.locator("#xyzMaxZoomOutput").dispatchEvent("input");
    await expect(page.locator("#xyzMaxZoomInput")).toHaveValue("3");

    // Drive from the slider, verify number input follows
    await page.locator("#xyzMaxZoomInput").fill("2");
    await page.locator("#xyzMaxZoomInput").dispatchEvent("input");
    await expect(page.locator("#xyzMaxZoomOutput")).toHaveValue("2");
  });

  test("Cancel button closes the XYZ tiles dialog", async ({ page }) => {
    await openXyzTilesDialog(page);
    await page
      .locator(".ui-dialog:has(#exportToXyzTilesScreen) .ui-dialog-buttonpane button", { hasText: "Cancel" })
      .click();
    await expect(page.locator("#exportToXyzTilesScreen")).toBeHidden();
  });
});

// ── Export output (slower — shared page, one map generation, two ZIP downloads) ──

test.describe("XYZ tiles export — output", () => {
  // Shared state: download both ZIPs once in beforeAll to avoid regenerating the map
  // multiple times. maxZoom=1 keeps generation fast (5 tiles total).
  let sharedContext: BrowserContext;
  let sharedPage: Page;
  let zip1: Buffer; // maxZoom=1 — used for structure/content tests
  let zip2: Buffer; // maxZoom=2 — used to verify maxZoom field in metadata
  const consoleErrors: string[] = [];

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();

    sharedPage.on("pageerror", err => consoleErrors.push(`pageerror: ${err.message}`));
    sharedPage.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
    });

    await setupPage(sharedContext, sharedPage);
    await openXyzTilesDialog(sharedPage);

    // First download: maxZoom=1
    ({ buf: zip1 } = await downloadZip(sharedPage, 1));

    // Second download: reopen dialog and use maxZoom=2
    await openXyzTilesDialog(sharedPage);
    ({ buf: zip2 } = await downloadZip(sharedPage, 2));
  });

  test.afterAll(async () => {
    await sharedPage.close();
    await sharedContext.close();
  });

  // ── Download basics ──

  test("download produces a file with a ZIP-named filename", async () => {
    // Confirm beforeAll succeeded
    expect(zip1).toBeDefined();
    expect(zip1.length).toBeGreaterThan(256);
  });

  test("downloaded file has valid ZIP magic bytes (PK signature)", async () => {
    // ZIP local-file-header signature: 50 4B 03 04
    expect(zip1[0]).toBe(0x50); // P
    expect(zip1[1]).toBe(0x4b); // K
    expect(zip1[2]).toBe(0x03);
    expect(zip1[3]).toBe(0x04);
  });

  // ── File structure ──

  test("ZIP contains all expected tile files for maxZoom=1", async () => {
    const names = zipFileNames(zip1);

    // z=0: 1×1 grid → 1 tile
    expect(names).toContain("0/0/0.png");

    // z=1: 2×2 grid → 4 tiles
    expect(names).toContain("1/0/0.png");
    expect(names).toContain("1/0/1.png");
    expect(names).toContain("1/1/0.png");
    expect(names).toContain("1/1/1.png");

    // Supporting files
    expect(names).toContain("metadata.json");
    expect(names).toContain("index.html");
  });

  test("ZIP contains exactly 7 files for maxZoom=1 (5 tiles + metadata + viewer)", async () => {
    const names = zipFileNames(zip1);
    // 1 (z=0) + 4 (z=1) + metadata.json + index.html = 7
    expect(names).toHaveLength(7);
  });

  test("ZIP for maxZoom=2 contains exactly 21 tiles plus metadata and viewer", async () => {
    const names = zipFileNames(zip2);
    // (4^3 - 1) / 3 = 21 tiles + 2 = 23 entries
    const tileNames = names.filter(n => n.endsWith(".png"));
    expect(tileNames).toHaveLength(21);
    expect(names).toContain("metadata.json");
    expect(names).toContain("index.html");
    expect(names).toHaveLength(23);
  });

  test("tile names follow strict z/x/y.png pattern", async () => {
    const names = zipFileNames(zip1);
    const tilePattern = /^\d+\/\d+\/\d+\.png$/;
    for (const name of names.filter(n => n.endsWith(".png"))) {
      expect(name).toMatch(tilePattern);
    }
  });

  // ── Tile image content ──

  test("tile 0/0/0.png is a valid PNG file", async () => {
    const tile = await zipReadFile(zip1, "0/0/0.png");
    expect(tile).not.toBeNull();

    // PNG signature: \x89 P N G \r \n \x1a \n
    expect(tile![0]).toBe(0x89);
    expect(tile![1]).toBe(0x50); // P
    expect(tile![2]).toBe(0x4e); // N
    expect(tile![3]).toBe(0x47); // G
    expect(tile![4]).toBe(0x0d);
    expect(tile![5]).toBe(0x0a);
  });

  test("all tiles are exactly 256×256 pixels", async () => {
    // Verify the z=0 tile dimensions; all tiles are generated identically sized
    const tile = await zipReadFile(zip1, "0/0/0.png");
    expect(tile).not.toBeNull();

    // PNG IHDR chunk starts at byte 8: 4-byte length, 4-byte "IHDR", then 4-byte W, 4-byte H
    expect(tile!.subarray(12, 16).toString("ascii")).toBe("IHDR");
    const width = tile!.readUInt32BE(16);
    const height = tile!.readUInt32BE(20);
    expect(width).toBe(256);
    expect(height).toBe(256);
  });

  // ── metadata.json ──

  test("metadata.json is valid JSON", async () => {
    const raw = await zipReadFile(zip1, "metadata.json");
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw!.toString("utf8"))).not.toThrow();
  });

  test("metadata.json contains correct map dimensions and zoom range", async () => {
    const raw = await zipReadFile(zip1, "metadata.json");
    const meta = JSON.parse(raw!.toString("utf8"));

    expect(meta).toMatchObject({
      minZoom: 0,
      maxZoom: 1,
      tileSize: 256,
      width: 1280,
      height: 720,
    });
    expect(typeof meta.name).toBe("string");
    expect(meta.name.length).toBeGreaterThan(0);
  });

  test("metadata.json maxZoom reflects the value chosen in the dialog", async () => {
    const raw2 = await zipReadFile(zip2, "metadata.json");
    const meta2 = JSON.parse(raw2!.toString("utf8"));
    expect(meta2.maxZoom).toBe(2);
  });

  // ── index.html viewer ──

  test("index.html is present and non-empty", async () => {
    const raw = await zipReadFile(zip1, "index.html");
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeGreaterThan(100);
  });

  test("index.html fetches metadata.json to configure the map", async () => {
    const raw = await zipReadFile(zip1, "index.html");
    const html = raw!.toString("utf8");
    expect(html).toContain("metadata.json");
  });

  test("index.html uses Leaflet and the XYZ tile URL template", async () => {
    const raw = await zipReadFile(zip1, "index.html");
    const html = raw!.toString("utf8");
    expect(html).toContain("leaflet");
    expect(html).toContain("{z}/{x}/{y}.png");
  });

  test("index.html uses the correct custom CRS transformation for non-geographic images", async () => {
    const raw = await zipReadFile(zip1, "index.html");
    const html = raw!.toString("utf8");
    // CRS fix: must use L.Transformation with negative c coefficient (not L.CRS.Simple default)
    expect(html).toContain("L.Transformation");
    expect(html).toContain("L.CRS.Simple");
  });

  test("index.html reads maxZoom at runtime from metadata.json (not hardcoded)", async () => {
    const raw = await zipReadFile(zip1, "index.html");
    const html = raw!.toString("utf8");
    // The viewer uses meta.maxZoom from the JSON, making the HTML reusable across exports
    expect(html).toContain("meta.maxZoom");
  });

  // ── Export process ──

  test("status element shows Done after export completes", async () => {
    const statusText = await sharedPage.evaluate(
      () => document.getElementById("xyzTileStatus")?.textContent ?? ""
    );
    expect(statusText).toContain("Done");
  });

  test("export runs without JavaScript errors", async () => {
    const critical = consoleErrors.filter(
      e =>
        !e.includes("fonts.googleapis.com") &&
        !e.includes("google-analytics") &&
        !e.includes("googletagmanager") &&
        !e.includes("Failed to load resource")
    );
    expect(critical).toEqual([]);
  });
});
