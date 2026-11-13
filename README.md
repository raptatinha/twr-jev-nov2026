# Building with Jev and System One models

Demos for the hands-on workshop (2 hours). Playground: [DemoQA Book Store](https://demoqa.com/books).

- **Step-by-step recap:** [guide/guide.md](guide/guide.md) (or `guide/guide.html` in a browser). Hand it to your coding agent too.
- **Slides:** `../jev-training-slides.html` (next to this folder).

## Start

```bash
npm install
npx playwright install chromium
cp .env.example .env        # add your keys: Jev + at least one LLM
```

## Run

| Command | What |
|---|---|
| `npm run race` | Demo 0: the same question to every model at once (time, tokens, cost) |
| `npm run edges` | Where it breaks: numbers, double negatives, no option fits, adversarial input |
| `npm run why -- F12` | Debug one decision: the exact state, every probability, every model's answer |
| `npm run bench` | Project 1, step 1: measure every model on 48 labeled test failures |
| `npm run p1` | Project 1: before (strong model only) vs. after (`route(task)`), one Playwright test per failure |
| `npm run dashboard` | rebuild and open a run's dashboard (every run already builds its own: `reports/dashboard-<run id>.html`) |
| `npm run p2` | Project 2: assertions decide pass/fail, Jev flags pages for review (real store and API intercepted) |
| `npm run p3` | Project 3: hybrid agent (Jev + LLM fallback) vs. LLM-only agent |
| `npm run report` | open the latest Playwright report (`-- p1` for the latest Project 1, `-- --list` for all) |
| `npm run obs:up` / `obs:down` | Level 3: Grafana + Tempo + Prometheus (Docker) |
| `npm run guide` | rebuild `guide/guide.html` from `guide/guide.md` |
| `npm run typecheck` | TypeScript check |

`SAMPLE=12 npm run p1` runs a mixed subset. Every run is kept under its own id, the local time plus what ran (e.g. `2026-11-09_20-15-33_p1`): `runs/<id>/`, `playwright-report/<id>/`, `reports/dashboard-<id>.html` (all ignored by git).

## Brand fonts (optional)

Reports use the Testing With Renata theme. To get the brand fonts (Noah, Averox), copy `averox.otf`, `noah-regular.otf` and `noah-bold.otf` into `assets/fonts/`. That folder is ignored by git because the fonts are licensed; without it, reports fall back to system fonts.

## Status

All demos ran against the four real APIs on 2026-11-09 (about $0.85 in total). Before the workshop, check the model IDs and prices in `.env` and `src/prices.ts`: vendors change them.
