"""SchemeFinder AI backend.

Run:
    python backend/app.py

Optional search provider configuration:
    Google:  SEARCH_PROVIDER=google, GOOGLE_API_KEY, GOOGLE_CSE_ID
    Brave:   SEARCH_PROVIDER=brave, BRAVE_API_KEY

The server uses only the Python standard library. It serves the existing
frontend and exposes POST /api/search. Search results are unverified links to
official government domains; the backend never invents scheme records.
"""

from __future__ import annotations

import json
import os
import re
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "5000"))
PROVIDER = os.environ.get("SEARCH_PROVIDER", "google").strip().lower()
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "").strip()
GOOGLE_CSE_ID = os.environ.get("GOOGLE_CSE_ID", "").strip()
BRAVE_API_KEY = os.environ.get("BRAVE_API_KEY", "").strip()
MAX_RESULTS = 8
REQUEST_LIMIT = 12_000

DISCLAIMER = (
    "These are web search results, not verified scheme records. "
    "Open the official source and confirm eligibility before applying."
)


class SearchError(Exception):
    """A safe, user-facing search error."""


class GoogleResultParser(HTMLParser):
    """Read public Google result anchors without using an API."""

    def __init__(self):
        super().__init__()
        self.results = []
        self.current_link = None
        self.current_text = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        href = attributes.get("href", "")
        if tag == "a" and href.startswith("https://"):
            self.current_link = href
            self.current_text = []

    def handle_data(self, data):
        if self.current_link:
            self.current_text.append(data.strip())

    def handle_endtag(self, tag):
        if tag == "a" and self.current_link:
            title = " ".join(" ".join(self.current_text).split())
            self.results.append(
                {"link": self.current_link, "title": title, "snippet": ""}
            )
            self.current_link = None
            self.current_text = []


def clean_text(value, limit=80):
    """Keep user input short and avoid sending unnecessary profile data."""
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def build_queries(profile):
    """Create a small number of targeted official-domain search queries."""
    state = clean_text(profile.get("state"), 40)
    occupation = clean_text(profile.get("occupation"), 40)
    education = clean_text(profile.get("education"), 40)
    age = clean_text(profile.get("age"), 3)
    income = clean_text(profile.get("income"), 12)

    location = state or "India"
    queries = []

    if occupation:
        queries.append(
            f"{location} {occupation} government scheme official application "
            "site:gov.in OR site:nic.in"
        )

    if education and education.lower() not in {"not applicable", "other"}:
        queries.append(
            f"{location} {education} student government scholarship scheme "
            "site:gov.in OR site:nic.in"
        )

    if not queries:
        queries.append(
            f"{location} government scheme official application "
            "site:gov.in OR site:nic.in"
        )

    # Age and income are used only when they add useful context.
    if age or income:
        detail = " ".join(part for part in (age and f"age {age}", income and f"family income {income}") if part)
        queries.append(
            f"{location} government scheme {detail} official "
            "site:gov.in OR site:nic.in"
        )

    # Keep API usage modest and remove duplicates.
    return list(dict.fromkeys(queries))[:2]


def is_official_url(url):
    """Only return HTTPS pages hosted on gov.in or nic.in."""
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and (
            host == "gov.in"
            or host.endswith(".gov.in")
            or host == "nic.in"
            or host.endswith(".nic.in")
        )
    except ValueError:
        return False


def normalise_result(item):
    link = item.get("link") or item.get("url") or ""
    if not is_official_url(link):
        return None
    title = clean_text(item.get("title"), 180) or "Official government page"
    snippet = clean_text(item.get("snippet") or item.get("description"), 320)
    return {
        "title": title,
        "link": link,
        "snippet": snippet,
        "source": urlparse(link).hostname or "",
        "source_department": source_department(link, title),
        "deadline": extract_deadline(f"{title} {snippet}"),
        "is_official": True,
        "is_verified_record": False,
    }


def source_department(link, title=""):
    """Provide a readable source label without claiming scheme verification."""
    host = (urlparse(link).hostname or "").lower()
    text = f"{host} {title.lower()}"
    known_sources = (
        (("pmkisan",), "Department of Agriculture & Farmers Welfare"),
        (("pmfby",), "Department of Agriculture & Farmers Welfare"),
        (("scholarships.gov.in", "scholarship"), "Ministry of Education"),
        (("skillindia", "kaushal"), "Ministry of Skill Development & Entrepreneurship"),
        (("wcd.gov.in", "pmmvy", "matru vandana"), "Ministry of Women & Child Development"),
        (("nsap", "social assistance", "old age pension"), "Ministry of Rural Development"),
        (("pmay", "housing"), "Ministry of Rural Development / Housing authorities"),
        (("pmjay", "ayushman"), "National Health Authority"),
        (("kviconline", "pmegp", "employment generation"), "Khadi and Village Industries Commission"),
    )
    for keywords, department in known_sources:
        if any(keyword in text for keyword in keywords):
            return department
    return "Official government source"


def extract_deadline(text):
    """Return an explicit deadline phrase when a provider includes one."""
    pattern = re.compile(
        r"(?:application\s+)?(?:deadline|last\s+date|closing\s+date| closes on)"
        r"\s*(?:is|:|-)?\s*"
        r"(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|"
        r"[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4}|"
        r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
        re.IGNORECASE,
    )
    match = pattern.search(text)
    return clean_text(match.group(1), 50) if match else None


def search_google(query):
    params = urlencode(
        {
            "key": GOOGLE_API_KEY,
            "cx": GOOGLE_CSE_ID,
            "q": query,
            "num": MAX_RESULTS,
            "safe": "active",
        }
    )
    request = Request(
        f"https://www.googleapis.com/customsearch/v1?{params}",
        headers={"Accept": "application/json"},
    )
    with urlopen(request, timeout=15) as response:
        data = json.load(response)
    return data.get("items", [])


def search_google_public(query):
    """Search Google's public HTML page without an API key or login."""
    params = urlencode({"q": query, "num": MAX_RESULTS, "hl": "en"})
    request = Request(
        f"https://www.google.com/search?{params}",
        headers={
            "Accept": "text/html",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
    )
    with urlopen(request, timeout=15) as response:
        html = response.read().decode("utf-8", "ignore")
    parser = GoogleResultParser()
    parser.feed(html)
    return parser.results


def search_brave(query):
    params = urlencode({"q": query, "count": MAX_RESULTS, "safesearch": "strict"})
    request = Request(
        f"https://api.search.brave.com/res/v1/web/search?{params}",
        headers={
            "Accept": "application/json",
            "X-Subscription-Token": BRAVE_API_KEY,
        },
    )
    with urlopen(request, timeout=15) as response:
        data = json.load(response)
    return data.get("web", {}).get("results", [])


def provider_ready():
    if PROVIDER == "google":
        return bool(GOOGLE_API_KEY and GOOGLE_CSE_ID)
    if PROVIDER == "brave":
        return bool(BRAVE_API_KEY)
    return False


def setup_message():
    if PROVIDER == "google":
        return (
            "Set GOOGLE_API_KEY and GOOGLE_CSE_ID, then restart the server. "
            "Create a Programmable Search Engine and enable the Custom Search API."
        )
    if PROVIDER == "brave":
        return "Set BRAVE_API_KEY, then restart the server."
    return "SEARCH_PROVIDER must be either 'google' or 'brave'."


def run_search(queries):
    if not provider_ready():
        collected = []
        for query in queries:
            try:
                raw_items = search_google_public(query)
            except (HTTPError, URLError, TimeoutError):
                raw_items = []
            for item in raw_items:
                result = normalise_result(item)
                if result:
                    collected.append(result)
        if collected:
            unique = {result["link"]: result for result in collected}
            return list(unique.values())[:MAX_RESULTS]
        # A bot-check or network restriction should still leave the user with
        # a working search link and never pretend the link is verified.
        return [
            {
                "title": "Open official government web search",
                "link": f"https://www.google.com/search?{urlencode({'q': query})}",
                "snippet": query,
                "source": "Google public search",
                "is_search_link": True,
                "source_department": "Google search link",
                "deadline": None,
                "is_official": False,
                "is_verified_record": False,
            }
            for query in queries
        ]

    collected = []
    for query in queries:
        try:
            if PROVIDER == "google":
                raw_items = search_google(query)
            else:
                raw_items = search_brave(query)
        except HTTPError as error:
            raise SearchError(
                f"The search provider rejected the request (HTTP {error.code}). "
                "Check the API key and quota."
            ) from error
        except URLError as error:
            raise SearchError(
                "The search provider could not be reached. Check the internet connection."
            ) from error
        except TimeoutError as error:
            raise SearchError("The search provider timed out. Try again.") from error

        for item in raw_items:
            result = normalise_result(item)
            if result:
                collected.append(result)

    # Preserve provider order while removing duplicate URLs.
    unique = {}
    for result in collected:
        unique.setdefault(result["link"], result)

    return list(unique.values())[:MAX_RESULTS]


class Handler(SimpleHTTPRequestHandler):
    """Serve the static frontend and the /api/search endpoint."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/search":
            self.send_json(404, {"error": "Not found."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > REQUEST_LIMIT:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(length))
            profile = payload.get("profile")
            if not isinstance(profile, dict):
                raise ValueError("A profile object is required.")
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Send a valid JSON profile."})
            return

        queries = build_queries(profile)
        try:
            results = run_search(queries)
        except SearchError as error:
            status = 503 if not provider_ready() else 502
            self.send_json(status, {"error": str(error)})
            return

        self.send_json(
            200,
            {
                "provider": PROVIDER,
                "queries": queries,
                "results": results,
                "disclaimer": DISCLAIMER,
                "api_configured": provider_ready(),
            },
        )

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"SchemeFinder running at http://{HOST}:{PORT}")
    print(f"Search provider: {PROVIDER}")
    if not provider_ready():
        print("INFO: No search API key configured.")
        print("INFO: Public Google HTML search mode is enabled; no login is required.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping SchemeFinder.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
