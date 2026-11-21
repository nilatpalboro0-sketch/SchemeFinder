# SchemeFinder 

SchemeFinder is a hackathon prototype that helps citizens explore public government schemes from a few profile details. It uses a transparent rule-based matcher, relevance scoring, and official-source links.

## Folder structure

```text
SchemeFinder/
├── index.html
├── style.css
├── script.js
├── schemes.json
├── README.md
├── assets/
│   └── logo.svg
└── backend/
    └── app.py
```

## Run locally

### Frontend only

Double-click `index.html` and open it in a modern browser. The built-in scheme library, profile matching, relevance scoring, and results display work without a server.

### Frontend with automatic web search

Run the included Python backend from the project directory:

```powershell
python backend/app.py
```

Then open `http://127.0.0.1:5000` in your browser. When the profile is complete, the app automatically searches for related official government pages.

The backend uses Python's standard library. It searches public official pages, filters results to HTTPS `gov.in` and `nic.in` URLs, and displays them as unverified pages to review. It does not scrape government pages, invent scheme details, or claim web results are verified.

## Technology

HTML5, CSS3, vanilla JavaScript, JSON and a Python standard-library backend. No framework or database is used.

## Important limitation

The included records point to public government portals. Portal-level records such as the National Scholarship Portal cover multiple schemes, so detailed eligibility is intentionally marked as Needs Verification. A potential match never guarantees eligibility or government approval. SchemeFinder is not directly connected to a government department and does not scrape undocumented APIs.
