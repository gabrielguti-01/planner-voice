// The test copy's made-up starting data. Nothing here is real: the tasks, events, groceries and history are
// invented so the app can be tried (and broken) without touching the real list. Daily, weekly and monthly
// routines still come from definitions/, because the planner's behavior depends on them.
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const addDays = (day, n) => { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  function files(today) {
    const y = addDays(today, -1);
    return {
      'state/now.md': `# Now: live state

cycle:: ${y}
tz:: America/New_York
ready_asked:: ${y}
pin:: -
tired:: off

Test copy: every task here is made up.

## Today (${y})

## Events

## Open tasks

### School

### Visit and trip prep

### Care, household and errands

### Money and planning

### Projects

## Maintenance: last known completion

Facts, not tasks. Kept indefinitely. Unknown ≠ overdue.

| id | Task | Last done | Next check / window |
| --- | --- | --- | --- |
`,
      'state/grocery.md': `# Grocery State

Test copy: made-up stock.

## Stock

| Item | Unit | Usable stock | Basis |
| --- | --- | --- | --- |
| Steak | steaks | 2 | test data |
| Kiwi | kiwis | 6 | test data |
| Pineapple | pieces | 4 | test data |
| Avocado | avocados | 1 | test data |
| Blueberries | full bags / open bag | 1 full | test data |
| Ginger | packs | 1 pack | test data |
| Bread | pieces (6/pack) | 6 | test data |
| Cheese | slices (10/pack) | 10 | test data |

## Shopping list

### Standard food

| Item | Qty | Trip | Disposition | Note |
| --- | --- | --- | --- | --- |

### Household / personal

| Item | Qty | Trip | Disposition | Note |
| --- | --- | --- | --- | --- |

### Extras

| Item | Qty | Trip | Disposition | Note |
| --- | --- | --- | --- | --- |
`,
      'state/inbox.md': '# Inbox\n\nOne line per report or request, added at the bottom.\n',
      'definitions/projects.md': '# Projects\n\nTest copy: no real projects.\n',
      'definitions/someday.md': '# Someday\n\nTest copy: nothing here.\n',
    };
  }

  // Made-up things to plan around, dated from the test copy's "today".
  function inbox(today) {
    const d = (n) => addDays(today, n);
    return [
      `add: Read chapter 4 for History | due ${d(1)} 18:00 | est 1 | focus high | section school`,
      `add: Physics problem set 3 | due ${d(2)} 23:59 | est 1.5 | focus high | section school`,
      `add: Physics problem set 3 upload | due ${d(2)} 23:59 | size small | parent Physics problem set 3 | section school`,
      `add: Biology Exam2 cells | due ${d(3)} 10:00 | est 1 | focus high | section school`,
      `add: Return the library book | due ${d(3)} | size small | mode physical | section care`,
      `add: Call the bank about the new card | size small | mode talk | value 3 | section money`,
      `add: Clean out the car | est 0.75 | mode physical | section care`,
      `add: Sort old photos | est 1 | value 2 | section projects`,
      `event: Dentist appointment | ${d(1)} 15:00-16:00 | confirmed`,
      `event: Weekend camping trip | ${d(4)} 09:00 to ${d(5)} 18:00 | away | confirmed`,
      'grocery: paper towels; dish sponges',
    ];
  }

  // Only everyday routines come along (meals, teeth, the cat, chores, laundry, groceries, the gym); classes,
  // meetings and calls are left out, and two made-up ones take their place.
  const KEEP = /^(MEAL-FIRST|TEETH-(AM|PM)|DEODORANT-(AM|PM)|FEED-BABYMAN-(AM|PM)|LITTER-SCOOP|ROOM-RESET|MEDS-AM|WATER-GALLON|DAILY-VITAMIN-D|SWEEP-COMMON|LUNCH|SMOOTHIE|TROPICAL-DRINK|GYM|DINNER|DISHES|TRASH-(CHECK|BACK|OUT)|BABYMAN-PLAY|SHOWER-PM|GROCERY-(BLUEBERRY-CHECK|RUN)|WEEKLY-(GROCERY-PLAN|CLEAN-RAGS|CLEAN-ROOM|REVIEW)|POOL-FILTER|LAUNDRY|GROOMING|MONTHLY-(RENT|TOASTER|ALUMINUM-SPONGES|SPONGE-BUCKET|DISH-SOAP-REFILL|STOVETOP|LOOFAH)|HOUSEHOLD-[A-Z-]+)$/;
  const MADE_UP = {
    weekly: [
      '- Biology class [id:: TEST-BIO-CLASS] [every:: Mon, Wed] [window:: 10:00-11:15] [where:: campus]',
      '- General study: Physics (not tied to a deadline) [id:: TEST-STUDY-PHYSICS] [every:: 2-3 days] [on-miss:: carry] [est:: 2] [size:: large] [mode:: desk] [value:: 4] [where:: home]',
    ],
  };
  function routines(file, text) {
    const kept = text.replace(/\r\n/g, '\n').split('\n').filter((l) => { const m = l.match(/\[id::\s*([^\]\s]+)\]/); return !m || KEEP.test(m[1]); });
    return kept.join('\n').replace(/\n*$/, '\n') + (MADE_UP[file] ? '\n## Test copy\n\n' + MADE_UP[file].join('\n') + '\n' : '');
  }

  globalThis.PlannerTestSeed = { files, inbox, routines, addDays };
})();
