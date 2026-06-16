// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Macher USA provider (macherusa.com) -- server-side-rendered Jewish job board.
//
// macherusa.com renders job listings directly in the page HTML (no login, no JS
// required), so we can fetch category pages over plain HTTP and parse the
// `/item/<id>` anchors. Unlike the API providers, there is no JSON endpoint --
// we parse anchors out of the HTML.
//
// Scope: the board has ~1900 listings, the vast majority non-technical, and its
// `?page=N` param does NOT paginate server-side (every page returns page 1).
// So instead of scraping all listings we fetch the handful of category pages
// that hold tech / AI / engineering roles -- each fits on a single page. The
// category slugs are configurable per portals.yml entry via `macher_categories`.
//
// Each listing is an anchor of the form:
//   <a href="/<cat>/item/<id>" class="job-listing">
//     <h3 class="job-listing-title">TITLE</h3>
//     <li><i class="icon-...-location-on"></i> LOCATION </li>
//     <li>...<span>JOB TYPE</span>...</li>
//   </a>
// We pull the title from the <h3> and the location from the location <li>.

const BASE = 'https://macherusa.com';

// Tech-relevant category slugs (each is a single-page listing on the board).
const DEFAULT_CATEGORIES = ['high-tech', 'web-internet', 'engineering'];

function categoryUrls(entry) {
  const cats = Array.isArray(entry.macher_categories) && entry.macher_categories.length
    ? entry.macher_categories
    : DEFAULT_CATEGORIES;
  return cats.map(c => `${BASE}/${String(c).replace(/^\/+/, '')}`);
}

// Strip HTML tags + decode the handful of entities that appear in titles.
function cleanText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse one category page's HTML into job objects.
function parseListings(html, entry) {
  const jobs = [];
  const seen = new Set();
  // Whole job-listing anchor block: href to /item/<id> + inner markup, up to </a>
  const re = /<a\b[^>]*href=["']([^"']*\/item\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const id = m[2];
    const inner = m[3];
    if (seen.has(id)) continue;          // de-dupe within the page
    seen.add(id);

    // Title lives in the <h3 class="job-listing-title">...</h3>
    const titleMatch = inner.match(/<h3[^>]*job-listing-title[^>]*>([\s\S]*?)<\/h3>/i);
    const title = cleanText(titleMatch ? titleMatch[1] : inner);
    if (!title) continue;                // skip image-only / malformed anchors

    // Location is the text in the <li> introduced by the location-on icon.
    const locMatch = inner.match(/icon-[\w-]*location-on[^>]*><\/i>([\s\S]*?)<\/li>/i);
    const location = locMatch ? cleanText(locMatch[1]) : '';

    const url = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;

    jobs.push({
      title,
      url,
      company: entry.name,                // board name; real employer is on the item page
      location,
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'macher',

  // Opt-in only: matched when portals.yml sets `provider: macher`. We do NOT
  // auto-detect from careers_url so the generic boards don't accidentally route
  // here.
  detect() {
    return null;
  },

  async fetch(entry, ctx) {
    const urls = categoryUrls(entry);
    const all = [];
    const errs = [];
    const seenIds = new Set();
    for (const url of urls) {
      let html;
      try {
        html = await ctx.fetchText(url);
      } catch (err) {
        // One bad category should not kill the whole fetch; only throw if every
        // category fails (handled below).
        errs.push(`${url}: ${err.message}`);
        continue;
      }
      for (const job of parseListings(html, entry)) {
        const idMatch = job.url.match(/\/item\/(\d+)/);
        const id = idMatch ? idMatch[1] : job.url;
        if (seenIds.has(id)) continue;    // de-dupe same job across categories
        seenIds.add(id);
        all.push(job);
      }
    }

    if (all.length === 0 && errs.length === urls.length) {
      throw new Error(`macher: all category fetches failed: ${errs.join('; ')}`);
    }
    return all;
  },
};
