import { getStore } from "@netlify/blobs";

const SKU_MAP_BLOB_KEY = "sku-warehouse-location-map.json";

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];

  const [headerLine, ...dataLines] = lines;
  const headers = headerLine.split(",").map((h) => h.trim());

  const idxSKU = headers.findIndex((h) => h.toLowerCase() === "sku");
  const idxWarehouse = headers.findIndex(
    (h) => h.toLowerCase() === "warehouse"
  );
  const idxLocation = headers.findIndex(
    (h) => h.toLowerCase() === "location"
  );

  if (idxSKU === -1 || idxWarehouse === -1 || idxLocation === -1) {
    throw new Error(
      "CSV must have at least SKU, Warehouse, Location columns (case-insensitive)"
    );
  }

  /** @type {{ SKU: string, Warehouse: string, Location: string }[]} */
  const rows = [];

  for (const line of dataLines) {
    const cols = line.split(",");
    const sku = (cols[idxSKU] || "").trim();
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
      // If there are multiple locations for same SKU+warehouse, keep the first one
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
