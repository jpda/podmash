/**
 * Podmash: Filter podcast RSS feed to show only FULL SHOW episodes
 *
 * This Cloudflare Worker fetches a podcast RSS feed and returns a filtered
 * version containing only episodes with "FULL SHOW" in the title.
 *
 * Subscribe to the worker URL in Apple Podcasts to get a clean feed with
 * no segment episodes cluttering the queue.
 */

interface Env {
  SOURCE_RSS_URL: string;
  CACHE_TTL: string; // in seconds
  TITLE_PREFIX: string; // Prefix to add to the channel title
  EPISODE_TITLE_FILTER: string; // Filter for episode titles (e.g., "FULL SHOW")
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // The source RSS feed URL to filter
      const sourceUrl = env.SOURCE_RSS_URL;

      // Prefix to add to the channel title to distinguish from original feed
      const titlePrefix = env.TITLE_PREFIX || "* ";
      // cache TTL
      const cacheTtl = parseInt(env.CACHE_TTL || "3600", 10); // default to 1 hour
      // title filter
      const episodeTitleFilter = env.EPISODE_TITLE_FILTER || "FULL SHOW";

      console.log(`Received request for filtered feed: ${request.url}`);
      console.log(`Using source feed URL: ${sourceUrl}`);
      console.log(`Using title prefix: ${titlePrefix}`);
      console.log(`Using episode title filter: ${episodeTitleFilter}`);
      console.log(`Using cache TTL: ${cacheTtl} seconds`);
      // Fetch the original RSS feed
      console.debug(`Fetching source feed from: ${sourceUrl}`);
      const originalFeed = await fetch(sourceUrl);

      if (!originalFeed.ok) {
        console.error(`Failed to fetch source feed from: ${sourceUrl}; error: ${originalFeed.status} ${originalFeed.statusText}`);
        return new Response("Failed to fetch source feed", { status: 500 });
      }

      const xmlText = await originalFeed.text();

      // Parse the XML manually (simple regex approach)
      const filtered = filterRSSFeed(xmlText, episodeTitleFilter, titlePrefix);

      // Extract Last-Modified from source or use newest FULL SHOW date
      let lastModified = originalFeed.headers.get("last-modified");

      if (!lastModified) {
        // Fallback: extract pubDate from newest FULL SHOW episode
        console.debug(`Original feed missing Last-Modified header; extracting from newest FULL SHOW episode`);
        lastModified = extractNewestPubDate(filtered) || new Date().toUTCString();
      }

      console.debug(`Last-Modified: ${lastModified}`);

      // Generate ETag based on filtered content hash
      const etag = await generateETag(filtered);

      // Check if client has matching ETag (304 Not Modified)
      const clientETag = request.headers.get("if-none-match");
      if (clientETag === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            "Last-Modified": lastModified,
            "Cache-Control": `max-age=${cacheTtl}`,
          },
        });
      }

      // Return the filtered RSS with correct content-type and caching headers
      return new Response(filtered, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": `max-age=${cacheTtl}`,
          "Last-Modified": lastModified,
          ETag: etag,
        },
      });
    } catch (error) {
      console.error("Error processing feed:", error);
      return new Response("Internal server error", { status: 500 });
    }
  },
};

/**
 * Filter RSS feed to include only episodes with "FULL SHOW" in the title
 * Also prepends a prefix to the channel title to distinguish it visually
 */
function filterRSSFeed(xmlText: string, titleFilter: string, titlePrefix: string): string {
  // Extract the channel opening tag and attributes
  const channelMatch = xmlText.match(/<channel[^>]*>/);
  if (!channelMatch) {
    return xmlText; // Return original if we can't parse
  }

  // Extract all items from the feed
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  const fullShowItems: string[] = [];

  while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
    const itemContent = itemMatch[1];

    // Check if this item's title contains "FULL SHOW"
    const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
    if (titleMatch) {
      const title = titleMatch[1];
      if (title.toUpperCase().includes(titleFilter.toUpperCase())) {
        fullShowItems.push(itemMatch[0]); // Keep the entire <item>...</item>
      }
    }
  }

  // Extract the channel header (everything up to the first <item>)
  const headerMatch = xmlText.match(/([\s\S]*?)<item>/);
  if (!headerMatch) {
    return xmlText;
  }

  let channelHeader = headerMatch[1];

  // Prepend the title prefix to the channel title
  channelHeader = prependChannelTitle(channelHeader, titlePrefix);

  // Extract the channel closing tag
  const footerMatch = xmlText.match(/<\/channel>\s*<\/rss>\s*$/);
  const channelFooter = footerMatch ? footerMatch[0] : "</channel></rss>";

  // Reconstruct the feed with filtered items
  const filteredFeed =
    channelHeader + fullShowItems.join("\n") + "\n" + channelFooter;

  return filteredFeed;
}

/**
 * Prepend a prefix to the channel title (the first <title> tag in the channel)
 */
function prependChannelTitle(channelHeader: string, prefix: string): string {
  // Match the first <title>...</title> in the channel header
  return channelHeader.replace(
    /<title>([\s\S]*?)<\/title>/,
    (match, title) => {
      // Only prepend if it doesn't already have the prefix
      if (!title.startsWith(prefix)) {
        return `<title>${prefix}${title}</title>`;
      }
      return match;
    }
  );
}

/**
 * Extract the pubDate of the newest (first) FULL SHOW episode
 */
function extractNewestPubDate(xmlText: string): string | null {
  const pubDateMatch = xmlText.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
  if (pubDateMatch) {
    return pubDateMatch[1];
  }
  return null;
}

/**
 * Generate an ETag hash from the filtered feed content
 * Uses simple string hashing for a quick fingerprint
 */
async function generateETag(content: string): Promise<string> {
  // Use SubtleCrypto to hash the content
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  // Return as ETag (quoted per RFC 7232)
  return `"${hashHex.substring(0, 16)}"`;
}
