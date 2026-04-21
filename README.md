# ACKO Motor Claims Car Video Capture

Mobile-first standalone web app for guided 360-degree car video capture during motor claims.

## What is included

- Pre-recording "How it works" and "Things to know" flow
- Rear-camera-first video capture with microphone audio
- Landscape guidance, soft warnings, and haptic feedback where supported
- Timed 360-degree coachmarks for a full car walkaround
- Flash/torch toggle attempt on supported devices
- Timestamp, geolocation, device metadata, and basic session risk signals
- Preview, delete, retake, and mocked upload submission

## Run locally

```bash
node server.js
```

Then open [http://localhost:4173](http://localhost:4173).

## Publish on GitHub Pages

This repo is set up for GitHub Pages via GitHub Actions.

1. Create a GitHub repository and push this folder to `main`
2. In GitHub, open `Settings -> Pages`
3. Under `Build and deployment`, choose `GitHub Actions`
4. Pushes to `main` will publish the site automatically

Expected project-site URL:

```text
https://divyashanmugam-svg.github.io/car-video-capture/
```

Important current GitHub Pages constraint:

- Public repositories work on GitHub Free
- Private repositories need GitHub Pro, Team, Enterprise Cloud, or Enterprise Server

If your target repository stays private and the account does not have one of those plans, GitHub Pages will not publish it.

## Files

- `index.html`: single-page app shell
- `styles.css`: mobile-first visual system
- `app.js`: capture flow, recording logic, coachmarks, preview, mock submit
- `server.js`: tiny static file server
- `docs/discovery.md`: original discovery notes

## Current assumptions

- Brand direction follows ACKO-inspired claims UX, not exact production assets
- Output is mocked locally with a simulated upload call
- Landscape is strongly encouraged but not hard-blocked
- Minimum duration is set to 90 seconds for MVP
- Coachmarks are timer-driven rather than computer-vision-driven

## GitHub repo target

- Owner: `divyashanmugam-svg`
- Visibility: `private`

GitHub creation is not completed yet because `gh` is not installed in the current shell and networked repo creation is restricted in this environment.
