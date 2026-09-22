export async function extractLinks(page, rootDomain = 'trustee.io') {
  return await page.evaluate((domain) => {
    const allLinks = Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h);
    
    // Internal links
    const internal = [...new Set(allLinks.filter(href => {
      try {
        const url = new URL(href);
        return url.hostname === domain || url.hostname.endsWith('.' + domain);
      } catch {
        return false;
      }
    }))];

    // External store links
    const stores = [...new Set(allLinks.filter(href => {
      return href.includes('apps.apple.com') || 
             href.includes('play.google.com') || 
             href.includes('appsflyer') || 
             href.includes('branch.io') ||
             href.includes('.apk') ||
             href.includes('app.link');
    }))];

    return { internal, stores };
  }, rootDomain);
}

/**
 * Parses the URL and checks if the referral key matches the expected one.
 * Returns the actual key found, or null if none.
 */
export function extractKeyFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.searchParams.get('r');
  } catch {
    return null;
  }
}
