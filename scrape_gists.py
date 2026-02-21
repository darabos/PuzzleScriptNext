#!/usr/bin/env python3
"""Scrape GitHub Gist search results for PuzzleScript games."""

import urllib.request
import urllib.parse
import re
import csv
import time

def scrape_gist_search():
    base_url = "https://gist.github.com/search"
    query = '"editor.html?hack="'
    results = []

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }

    page = 1
    while True:
        params = {
            'q': query,
            'ref': 'searchresults',
            'p': str(page)
        }

        url = base_url + '?' + urllib.parse.urlencode(params)
        print(f"Fetching page {page}...")

        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                html = response.read().decode('utf-8')
        except Exception as e:
            print(f"Error: {e}")
            break

        # Find gist URLs - they appear as relative paths like /username/hash
        # Pattern: href="/username/gist_id" where gist_id is 32 hex chars
        url_pattern = r'href="/([^/]+)/([a-f0-9]{32})"'
        found_urls = re.findall(url_pattern, html)

        if not found_urls:
            print(f"No more results found on page {page}")
            break

        # Get unique gist URLs from this page
        seen_on_page = set()
        for username, gist_id in found_urls:
            if gist_id not in seen_on_page:
                seen_on_page.add(gist_id)

                # Build full URL
                full_url = f"https://gist.github.com/{username}/{gist_id}"

                # Find title for this gist - look in span with class "f6 color-fg-muted"
                # The title appears after the filename link (could be readme.txt, script.txt, etc.)
                # Pattern: /username/gist_id"><strong...>filename</strong></a>...</span>...<span class="f6 color-fg-muted">Title</span>

                # Look for the pattern with the gist_id and strong tag (any filename)
                search_pattern = f'href="/{username}/{gist_id}"><strong[^>]*>[^<]+</strong>'
                match = re.search(search_pattern, html)

                if match:
                    idx = match.start()
                    # Look in ~2000 chars after this pattern
                    context = html[idx:idx+2000]

                    # Look for title in span tag with class f6 color-fg-muted
                    title_match = re.search(r'<span class="f6 color-fg-muted">\s*([^<]+?)\s*</span>', context)
                    if title_match:
                        title = title_match.group(1).strip()
                    else:
                        title = f"Gist by {username}"
                else:
                    title = f"Gist by {username}"

                # Clean title - remove extra whitespace
                title = re.sub(r'\s+', ' ', title).strip()

                results.append({
                    'url': full_url,
                    'title': title
                })

        page += 1
        time.sleep(0.5)  # Be nice to the server

        # Safety check - stop after 15 pages
        if page > 15:
            break

    return results

def main():
    print("Scraping GitHub Gist search results...")
    results = scrape_gist_search()

    # Remove duplicates based on URL
    seen = set()
    unique_results = []
    for r in results:
        if r['url'] not in seen:
            seen.add(r['url'])
            unique_results.append(r)

    print(f"Found {len(unique_results)} unique gists")

    # Write to CSV
    with open('gist_results.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['url', 'title'])
        writer.writeheader()
        writer.writerows(unique_results)

    print("Results written to gist_results.csv")

if __name__ == '__main__':
    main()
