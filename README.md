# To-Do

A single static page that shows a planner's next step and today's plan, and lets you check things off. It contains no data. Each person connects it to their own private planner repository with their own access token, which stays in their browser.

On the screen: the next step with Done and Skip, today's plan with the reason for each step, the projects, goals, notes and library, and the grocery and shopping lists.

Demo with sample data: add `?mock=1` to the address.

Test copy with made-up tasks: `test/`. It runs the planner engine inside the page (read from your repository, read-only, with the token already saved) and never writes to GitHub.

Tests (made-up data, a mocked AI helper and a stand-in for GitHub; nothing leaves the machine): `node --test --test-concurrency=1 tests/*.test.mjs`. The page tests use the Playwright and Chromium already on the machine.

What the page needs from the planner engine before it sends spelling fixes (`engine/capabilities.json`), and what it does without it: `COMPATIBILITY.md`.
