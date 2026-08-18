"use strict";
/**
 * Canonical types shared by the central Supabase ingestion pipeline.
 *
 * Each portal scraper (glints, jooble, kitalulus, pintarnya, seek, ...) keeps
 * its own portal-shaped types. Before anything is pushed to the central
 * Supabase database the portal payload is mapped onto the canonical shapes
 * defined here, so the central schema stays portal agnostic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LISTING_PRIORITY = void 0;
/**
 * Listing priority buckets. Lower sorts first in talent listings.
 */
exports.LISTING_PRIORITY = {
    /** Newly scraped candidates float to the top of the talent listing. */
    scraped_new: 0,
    /** Candidates already known to IDRKOS sit below the fresh ones. */
    idrkos_verified: 100,
    /** Not cross-checked yet. */
    pending: 200,
};
