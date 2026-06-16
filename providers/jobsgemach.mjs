// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// JobsGemach provider (jobsgemach.com) -- WordPress + WP Job Manager.
//
// The public board is JS-rendered ("JavaScript must be enabled to view
// listings"), which is why site: search and a plain HTML fetch both came up
// empty. But the site exposes the standard WP REST API for the `job_listing`
// post type at /wp-json/wp/v2/job-listings -- clean JSON, no login, no JS.
//
// We pull the newest listings (date desc), trimmed to a few fields via _fields
// to keep payloads small, and let scan.mjs's title/location filters narrow to
// Bryan's targets. Location isn't a structured field on this board, so we make
// a best-effort parse of the "A <City>, <ST> company..." pattern that most
// descriptions open with; an empty location passes the location filter anyway.

const ENDPOINT = 'https://www.jobsgemach.com/wp-json/wp/v2/job-listings';
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 2; // newest ~200 postings; daily scan + dedup covers the rest

// The site's WAF returns 403 to the scanner's default UA, so send a normal
// browser UA + JSON Accept for this provider only.
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'application/json',
};

function decodeEntities(s) {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8217;|&rsquo;|&#039;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Best-effort "City, ST" from the opening of the description. Returns '' if none.
function guessLocation(contentHtml) {
  const text = decodeEntities(contentHtml || '');
  const m = text.match(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}),\s*([A-Z]{2})\b/);
  return m ? `${m[1]}, ${m[2]}` : '';
}

/** @type {Provider} */
export default {
  id: 'jobsgemach',

  // Opt-in only via `provider: jobsgemach` in portals.yml.
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const maxPages = Number.isInteger(entry.jobsgemach_max_pages) && entry.jobsgemach_max_pages > 0
      ? entry.jobsgemach_max_pages
      : DEFAULT_MAX_PAGES;

    const jobs = [];
    for (let page = 1; page <= maxPages; page++) {
      const url = `${ENDPOINT}?per_page=${PER_PAGE}&page=${page}`
        + `&orderby=date&order=desc&_fields=id,link,title,content`;
      let batch;
      try {
        batch = await ctx.fetchJson(url, { headers: REQUEST_HEADERS });
      } catch (err) {
        // WP returns 400 ("rest_post_invalid_page_number") once you page past the
        // end. Treat that as a clean stop rather than a failure.
        if (/invalid_page_number|HTTP 400/i.test(err.message)) break;
        if (page === 1) throw new Error(`jobsgemach: fetch failed: ${err.message}`);
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const post of batch) {
        const title = decodeEntities(post?.title?.rendered || '');
        const link = post?.link || '';
        if (!title || !link) continue;
        jobs.push({
          title,
          url: link,
          company: entry.name,            // board name; real employer is in the post body
          location: guessLocation(post?.content?.rendered),
        });
      }

      if (batch.length < PER_PAGE) break; // last page
    }

    return jobs;
  },
};
