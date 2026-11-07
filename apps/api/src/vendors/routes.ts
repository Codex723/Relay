import { Router } from "express";
import { City, type ItemSummary, type VendorSummary } from "@relay/shared";
import { z } from "zod";
import type { Database } from "../db";
import { HttpError, asyncHandler } from "../http";

const idSchema = z.string().uuid();

// Public: customers browse before they sign in.
export function vendorsRouter(db: Database): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const cityParam = req.query.city;
      const city = cityParam === undefined ? undefined : City.parse(cityParam);
      let query = db.selectFrom("vendors").select(["id", "name", "city", "address", "lat", "lng", "is_open"]);
      if (city) query = query.where("city", "=", city);
      const rows = await query.orderBy("name").execute();
      const vendors: VendorSummary[] = rows.map((v) => ({
        id: v.id,
        name: v.name,
        city: v.city,
        address: v.address,
        lat: Number(v.lat),
        lng: Number(v.lng),
        isOpen: v.is_open,
      }));
      res.json({ vendors });
    }),
  );

  router.get(
    "/:id/items",
    asyncHandler(async (req, res) => {
      const id = idSchema.safeParse(req.params.id);
      const vendor = id.success
        ? await db.selectFrom("vendors").select("id").where("id", "=", id.data).executeTakeFirst()
        : undefined;
      if (!vendor) throw new HttpError(404, "VENDOR_NOT_FOUND", "Vendor not found.");
      const rows = await db
        .selectFrom("items")
        .select(["id", "name", "description", "price_kobo", "image_url", "is_available"])
        .where("vendor_id", "=", vendor.id)
        .orderBy("name")
        .execute();
      const items: ItemSummary[] = rows.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        priceKobo: i.price_kobo,
        imageUrl: i.image_url,
        isAvailable: i.is_available,
      }));
      res.json({ items });
    }),
  );

  return router;
}
