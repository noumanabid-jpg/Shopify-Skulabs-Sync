import crypto from "crypto";
import { getStore } from "@netlify/blobs";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const SKULABS_API_TOKEN = process.env.SKULABS_API_TOKEN;
const SKULABS_BASE_URL =
  process.env.SKULABS_BASE_URL || "https://api.skulabs.com";

const SKU_MAP_BLOB_KEY = "sku-warehouse-location-map.json";

function timingSafeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader || !SHOPIFY_WEBHOOK_SECRET) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return timingSafeEq(digest, hmacHeader);
}

// Lookup Shopify variant by inventory_item_id -> returns { sku, warehouseKey }
async function lookupVariantByInventoryItemId(inventoryItemId) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) return null;

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/variants.json?inventory_item_ids=${encodeURIComponent(
    inventoryItemId
  )}`;

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Shopify variant lookup failed", res.status, text);
    return null;
  }

  const data = await res.json();
  const variants = data.variants || [];
  if (!variants.length) return null;

  const variant = variants[0];
  const sku = (variant.sku || "").trim();
  if (!sku) return null;

  const warehouseKey =
    (variant.title || variant.option1 || "").trim() || "Default";

  return { sku, warehouseKey };
}

async function skulabsBulkUpsertSingle({ sku, warehouse, location, on_hand }) {
  const url = new URL("/item/bulk_upsert", SKULABS_BASE_URL);

  const payload = {
    items: [
      {
        sku,
        warehouse,
        location,
        on_hand,
      },
    ],
  };

  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SKULABS_API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[SKU Labs bulk_upsert] ${res.status}: ${text}`);
  }
}

export const handler = async (event) => {
  try {
    const hmac =
      event.headers["x-shopify-hmac-sha256"] ||
      event.headers["X-Shopify-Hmac-Sha256"];
    const topic =
      event.headers["x-shopify-topic"] ||
      event.headers["X-Shopify-Topic"] ||
      "";
    const rawBody = event.body || "";

    if (!verifyShopifyHmac(rawBody, hmac)) {
      return { statusCode: 401, body: "Invalid HMAC" };
    }

    if (topic !== "inventory_levels/update") {
      return { statusCode: 200, body: "Ignored topic" };
    }

    const payload = JSON.parse(rawBody);
    const inventory_item_id = String(payload.inventory_item_id ?? "");
    const available = Number(payload.available ?? 0);

    if (!inventory_item_id || !Number.isFinite(available)) {
      console.warn("Missing inventory_item_id or available", {
        inventory_item_id,
        available,
      });
      return { statusCode: 200, body: "Missing fields; skipped" };
    }

    // 1) Get variant info from Shopify
    const variantInfo = await lookupVariantByInventoryItemId(inventory_item_id);
    if (!variantInfo) {
      console.warn("No variant mapping for inventory_item_id", {
        inventory_item_id,
      });
      return { statusCode: 200, body: "No variant; skipped" };
    }

    const { sku, warehouseKey } = variantInfo;

    // 2) Load mapping from Blobs
    const store = getStore({
      name: "skulabs-sync-cache",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });

    const json = await store.get(SKU_MAP_BLOB_KEY, { type: "text" });

    if (!json) {
      console.warn("SKU map not found in Blobs");
      return { statusCode: 200, body: "No SKU map; skipped" };
    }

    /** @type {{ [sku: string]: { [warehouseName: string]: { warehouse: string, location: string } } }} */
    const map = JSON.parse(json);

    const skuEntry = map[sku];
    if (!skuEntry) {
      console.warn("No SKU entry in map", { sku });
      return { statusCode: 200, body: "No SKU entry; skipped" };
    }

    // 3) Map Shopify warehouse key (Jeddah/Riyadh/Dammam) to SKU Labs warehouse name
    const WAREHOUSE_NAME_MAP = {
      Jeddah: "Jeddah Club",
      Riyadh: "Riyadh Club",
      Dammam: "Dammam Club",
    };

    const skulabsWarehouseName =
      WAREHOUSE_NAME_MAP[warehouseKey] || warehouseKey;

    const entry = skuEntry[skulabsWarehouseName];
    if (!entry) {
      console.warn("No location entry for this warehouse", {
        sku,
        warehouseKey,
        skulabsWarehouseName,
      });
      return { statusCode: 200, body: "No location entry; skipped" };
    }

    await skulabsBulkUpsertSingle({
      sku,
      warehouse: entry.warehouse,
      location: entry.location,
      on_hand: available,
    });

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Webhook error", err);
    return { statusCode: 200, body: "Handled error" };
  }
};
