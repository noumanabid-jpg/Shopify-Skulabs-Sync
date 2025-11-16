# Shopify → SKU Labs Inventory Sync (CSV Mapping Version)

This version uses a **CSV mapping file** to link SKUs to SKU Labs warehouses and locations.

## Overview

There are two Netlify Functions:

1. **Upload mapping** (`upload-skulabs-map`)
   - Admin-only endpoint.
   - Accepts a CSV file with columns at least:
     - `SKU`
     - `Warehouse`
     - `Location`
   - Builds a mapping:

     ```json
     {
       "PK-00061": {
         "Jeddah Club": { "warehouse": "Jeddah Club", "location": "A1" },
         "Riyadh Club": { "warehouse": "Riyadh Club", "location": "R-A1" },
         "Dammam Club": { "warehouse": "Dammam Club", "location": "DM-A1" }
       }
     }
     ```

   - Saves this JSON to **Netlify Blobs** under store `skulabs-sync-cache`
     with key `sku-warehouse-location-map.json`.

2. **Shopify inventory webhook** (`shopify-inventory-webhook`)
   - Receives Shopify `inventory_levels/update` webhooks.
   - Verifies HMAC with `SHOPIFY_WEBHOOK_SECRET`.
   - Uses Shopify Admin API to resolve `inventory_item_id` → variant:
     - `sku`
     - warehouse key: `"Jeddah"`, `"Riyadh"`, or `"Dammam"` (variant title / option1).
   - Loads the CSV-derived mapping from Netlify Blobs.
   - Converts `"Jeddah"` → `"Jeddah Club"` etc.
   - Looks up that SKU + warehouse and gets the correct **SKU Labs warehouse + location**.
   - Calls SKU Labs **`PUT /item/bulk_upsert`** to set `on_hand`.

---

## File structure

```text
netlify.toml
package.json
README.md
netlify/
  functions/
    upload-skulabs-map.js
    shopify-inventory-webhook.js
```

---

## Environment variables

Set these in your Netlify project:

### Shared

- `SKULABS_API_TOKEN`  
  Bearer token for SKU Labs API, used for `bulk_upsert`.

- `SKULABS_BASE_URL`  
  Base URL for SKU Labs API. Example:  
  `https://api.skulabs.com`

### Shopify webhook

- `SHOPIFY_WEBHOOK_SECRET`  
  Webhook secret from Shopify.

- `SHOPIFY_STORE_DOMAIN`  
  Your store domain, e.g. `your-store.myshopify.com`.

- `SHOPIFY_ADMIN_TOKEN`  
  Shopify Admin API access token with at least:
  - `read_inventory`
  - `read_products`

### Netlify Blobs

- `NETLIFY_SITE_ID`  
  The "API ID" of your Netlify site (Site settings → General → Site details).

- `NETLIFY_BLOBS_TOKEN`  
  Personal access token generated in Netlify user settings.

### Upload protection

- `ADMIN_UPLOAD_SECRET`  
  Any strong random string.  
  Required as `x-admin-secret` header when calling `upload-skulabs-map`.

---

## 1) Uploading the CSV mapping

1. Create a CSV with columns:
   - `SKU`
   - `Warehouse`
   - `Location`

   You can keep extra columns like `On Hand`, `Alert` — they will be ignored.

2. Use a tool like **Postman** or `curl` to upload:

   - Method: `POST`
   - URL:

     ```text
     https://<your-site>.netlify.app/.netlify/functions/upload-skulabs-map
     ```

   - Headers:
     - `Content-Type: text/csv`
     - `x-admin-secret: <ADMIN_UPLOAD_SECRET env value>`

   - Body: raw CSV file contents.

3. If successful, the function returns JSON like:

   ```json
   { "ok": true, "skuCount": 1572 }
   ```

   and the mapping is stored in Blobs ready for the webhook.

You can repeat this upload anytime if the mapping changes.

---

## 2) Shopify webhook configuration

In Shopify Admin:

1. Go to **Settings → Notifications → Webhooks**.
2. Create webhook:
   - Event: **Inventory level update**
   - URL:

     ```text
     https://<your-site>.netlify.app/webhooks/shopify/inventory
     ```

   - Format: JSON
   - Secret: same as `SHOPIFY_WEBHOOK_SECRET`.

---

## 3) How the webhook uses the mapping

1. Shopify calls the webhook with `inventory_levels/update` payload:
   - `inventory_item_id`
   - `available`
   - etc.

2. The function:
   - Verifies HMAC.
   - Uses Admin API:

     ```http
     GET /admin/api/2025-01/variants.json?inventory_item_ids={inventory_item_id}
     ```

     to get the variant.

   - From variant:
     - `variant.sku` → SKU key.
     - `variant.title` or `variant.option1` → `"Jeddah"`, `"Riyadh"`, `"Dammam"`.

3. Converts this warehouse key to SKU Labs warehouse name:

   ```js
   const WAREHOUSE_NAME_MAP = {
     Jeddah: "Jeddah Club",
     Riyadh: "Riyadh Club",
     Dammam: "Dammam Club",
   };
   ```

4. Loads the mapping JSON from Blobs and looks up:

   ```js
   mapping[sku]["Jeddah Club"]
   ```

5. Calls:

   ```http
   PUT /item/bulk_upsert
   Authorization: Bearer <SKULABS_API_TOKEN>
   Content-Type: application/json
   ```

   with:

   ```json
   {
     "items": [
       {
         "sku": "<variant.sku>",
         "warehouse": "Jeddah Club",
         "location": "<location-from-CSV>",
         "on_hand": <available>
       }
     ]
   }
   ```

If mapping is missing for a given SKU or warehouse, the webhook logs a warning and returns 200 (to avoid Shopify retries), but no update is sent to SKU Labs.

---

## 4) Changing mapping later

Whenever the SKU → warehouse → location mapping changes:

1. Export a fresh CSV from SKU Labs.
2. POST it again to `upload-skulabs-map` with the `x-admin-secret` header.
3. The new mapping overwrites the old one.

No code changes or redeploys needed.
