const express = require("express");
const router = express.Router();

/** Max number of listings returned per page. */
const PAGE_SIZE = 20;

/**
 * GET /api/listings?city=...&page=...
 * Returns a paginated list of listings for a city, each enriched with
 * its agency and photos.
 */
router.get("/api/listings", async (req, res) => {
  const city = normalizeCity(req.query.city);
  const page = normalizePage(req.query.page);

  if (city === null) {
    return res.status(400).json({ error: "Paramètre 'city' invalide" });
  }

  try {
    const db = req.app.locals.db;
    const listings = await fetchListings(db, city, page);
    const enriched = await attachAgenciesAndPhotos(db, listings);
    res.json(enriched);
  } catch (err) {
    console.error("GET /api/listings failed:", err);
    res.status(500).json({ error: "Erreur serveur, veuillez réessayer" });
  }
});

/**
 * Fetches one page of listings for a given city, ordered by newest first.
 * @param {object} db - Database client with a `query` method.
 * @param {string} city - Normalized city name.
 * @param {number} page - 1-based page number.
 * @returns {Promise<object[]>} Matching listing rows (without agency/photos yet).
 */
async function fetchListings(db, city, page) {
  const offset = (page - 1) * PAGE_SIZE;
  const { rows } = await db.query(
    `SELECT * FROM listings WHERE city = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [city, PAGE_SIZE, offset]
  );
  return rows;
}

/**
 * Enriches each listing with its agency and photos, using 2 batched
 * queries instead of 2 queries per listing (avoids the N+1 problem).
 * @param {object} db - Database client with a `query` method.
 * @param {object[]} listings - Listing rows returned by fetchListings.
 * @returns {Promise<object[]>} Listings enriched with `agency` and `photos`.
 */
async function attachAgenciesAndPhotos(db, listings) {
  if (listings.length === 0) return [];

  const agencyIds = [...new Set(listings.map((l) => l.agency_id))];
  const listingIds = listings.map((l) => l.id);

  const [{ rows: agencies }, { rows: photos }] = await Promise.all([
    db.query("SELECT * FROM agencies WHERE id = ANY($1)", [agencyIds]),
    db.query("SELECT listing_id, url FROM photos WHERE listing_id = ANY($1)", [listingIds]),
  ]);

  const agencyById = new Map(agencies.map((a) => [a.id, a]));
  const photosByListingId = groupPhotosByListing(photos);

  return listings.map((listing) => ({
    ...listing,
    agency: agencyById.get(listing.agency_id) ?? null,
    photos: photosByListingId.get(listing.id) ?? [],
  }));
}

/**
 * Groups a flat list of photo rows into a map of listingId -> photo URLs.
 * @param {{listing_id: string, url: string}[]} photos
 * @returns {Map<string, string[]>}
 */
function groupPhotosByListing(photos) {
  const map = new Map();
  for (const photo of photos) {
    const urls = map.get(photo.listing_id) ?? [];
    urls.push(photo.url);
    map.set(photo.listing_id, urls);
  }
  return map;
}

/**
 * Validates and trims the `city` query param.
 * @param {unknown} rawCity - Raw value from req.query.city.
 * @returns {string|null} Trimmed city name, or null if invalid.
 */
function normalizeCity(rawCity) {
  if (typeof rawCity !== "string") return null;
  const trimmed = rawCity.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : null;
}

/**
 * Parses and bounds the `page` query param.
 * @param {unknown} rawPage - Raw value from req.query.page.
 * @returns {number} Valid page number, defaulting to 1 and capped at 10 000.
 */
function normalizePage(rawPage) {
  const page = parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 10_000);
}

module.exports = router;