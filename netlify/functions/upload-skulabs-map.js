import { getStore } from "@netlify/blobs";

const SKU_MAP_BLOB_KEY = "sku-warehouse-location-map.json";

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  // Remove UTF-8 BOM if present
  const headerLine = lines[0].replace(/^\uFEFF/, "");
  const dataLines = lines.slice(1);

  const headers = headerLine.split(",").map((h) => h.trim());

  // helper: find index where header name contains a keyword
  const findIndex = (keyword) => {
    const kw = keyword.toLowerCase();
    return headers.findIndex((h) => h.toLowerCase().includes(kw));
  };

  const idxSKU = findIndex("sku");
  const idxWarehouse = findIndex("warehouse");
  const idxLocation = findIndex("location");

  if (idxSKU === -1 || idxWarehouse === -1 || idxLocation === -1) {
    throw new Error(
      "CSV must have at least columns containing 'SKU', 'Warehouse', and 'Location' in their names (case-insensitive)"
    );
  }

  /** @type {{ SKU: string, Warehouse: string, Location: string }[]} */
  const rows = [];

  for (const line of dataLines) {
    const cols = line.split(",");
    const sku = (cols[idxSKU] || "").trim().toUpperCase();
    const warehouse = (cols[idxWarehouse] || "").trim();
    const location = (cols[idxLocation] || "").trim();

    if (!sku || !warehouse || !location) continue;

    rows.push({ SKU: sku, Warehouse: warehouse, Location: location });
  }

  return rows;
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const adminSecret = process.env.ADMIN_UPLOAD_SECRET;
    if (!adminSecret) {
      return {
        statusCode: 500,
        body: "ADMIN_UPLOAD_SECRET not configured",
      };
    }

    const headerSecret =
      event.headers["x-admin-secret"] || event.headers["X-Admin-Secret"];
    if (headerSecret !== adminSecret) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    const body = event.body || "";
    if (!body.trim()) {
      return { statusCode: 400, body: "Empty body" };
    }

    const rows = parseCsv(body);

    /** @type {{ [sku: string]: { [warehouseName: string]: { warehouse: string, location: string } } }} */
    const map = {};

    for (const r of rows) {
      const sku = r.SKU;
      const warehouse = r.Warehouse;
      const location = r.Location;

      if (!map[sku]) map[sku] = {};
      if (!map[sku][warehouse]) {
        map[sku][warehouse] = { warehouse, location };
      }
    }

    const store = getStore({
      name: "skulabs-sync-cache",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    await store.set(SKU_MAP_BLOB_KEY, JSON.stringify(map));

    const skuCount = Object.keys(map).length;

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, skuCount }),
    };
  } catch (err) {
    console.error("upload-skulabs-map error", err);
    return { statusCode: 500, body: "Upload error" };
  }
};
