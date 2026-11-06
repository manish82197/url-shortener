# Shortly: URL Shortener with Analytics

A URL shortening service with custom aliases and click analytics, built with Node.js, Express and SQLite.

**Live demo:** https://url-shortener-6qdm.onrender.com (free tier: the first load after idle can take ~30s, and stored links reset on restart)

## Features

- **Short links:** random 7-character codes or custom aliases (3-20 chars)
- **Click analytics:** total clicks, daily trend for the last 7 days, top referrers
- **LRU cache:** hot links resolve from memory and skip the database lookup on redirect
- **Rate limiting:** per-IP token bucket (10 link creations per minute)
- **Indexed schema:** `clicks(code)` index keeps the analytics queries fast

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

## API

| Method | Route               | Description                                   |
| ------ | ------------------- | --------------------------------------------- |
| POST   | `/api/shorten`      | Body `{ "url": "...", "alias": "optional" }` |
| GET    | `/api/stats/:code`  | Click totals, daily counts, top referrers     |
| GET    | `/:code`            | Records the click and redirects (302)         |
