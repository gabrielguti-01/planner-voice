# To-Do

A single static page that shows a planner's next step and today's plan, and lets you check things off. It contains no data. Each person connects it to their own private planner repository with their own access token, which stays in their browser.

On the screen: the next step with Done and Skip, today's plan with the reason for each step, the projects, goals, notes and library, and the grocery and shopping lists.

Money (laptop view, `desk/` → Money; code in `money.js`): what you owe on pay-later plans and bills, paychecks to come, and how much is safe to use while an emergency cushion stays untouched. Its numbers live in a folder you pick on your own computer (Chrome or Edge), never in the planner repository: `money.js` makes no network requests. The only thing it can send is a planner reminder you ask for, with a name and a date and no amount. Tests: `node --test tests/money.test.mjs`.

Demo with sample data: add `?mock=1` to the address.

Test copy with made-up tasks: `test/`. It runs the planner engine inside the page (read from your repository, read-only, with the token already saved) and never writes to GitHub.
