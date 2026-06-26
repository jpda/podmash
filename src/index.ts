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
  // Add environment variables here if needed
}

// The source RSS feed URL to filter
const SOURCE_RSS_URL =
  "https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/b0033a5f-8d6c-46a0-90bd-afb90153a86d/b71608e3-ebff-402a-8ca1-afb90153a898/podcast.rss";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      // Fetch the original RSS feed
      const originalFeed = await fetch(SOURCE_RSS_URL);

      if (!originalFeed.ok) {
        return new Response("Failed to fetch source feed", { status: 500 });
      }

      const xmlText = await originalFeed.text();

      // Parse the XML manually (simple regex approach)
      const filtered = filterRSSFeed(xmlText);

      // Extract Last-Modified from source or use newest FULL SHOW date
      let lastModified = originalFeed.headers.get("last-modified");
      if (!lastModified) {
        // Fallback: extract pubDate from newest FULL SHOW episode
        lastModified = extractNewestPubDate(filtered) || new Date().toUTCString();
      }

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
            "Cache-Control": "max-age=3600",
          },
        });
      }

      // Return the filtered RSS with correct content-type and caching headers
      return new Response(filtered, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "max-age=3600",
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
 */
function filterRSSFeed(xmlText: string): string {
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
      if (title.toUpperCase().includes("FULL SHOW")) {
        fullShowItems.push(itemMatch[0]); // Keep the entire <item>...</item>
      }
    }
  }

  // Extract the channel header (everything up to the first <item>)
  const headerMatch = xmlText.match(/([\s\S]*?)<item>/);
  if (!headerMatch) {
    return xmlText;
  }

  const channelHeader = headerMatch[1];

  // Extract the channel closing tag
  const footerMatch = xmlText.match(/<\/channel>\s*<\/rss>\s*$/);
  const channelFooter = footerMatch ? footerMatch[0] : "</channel></rss>";

  // Reconstruct the feed with filtered items
  const filteredFeed =
    channelHeader + fullShowItems.join("\n") + "\n" + channelFooter;

  return filteredFeed;
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
