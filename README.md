# School Sync
1. Install Node.js 18+ (nodejs.org)
2. In this folder: `npm install` then `npm start`
3. Scan the WhatsApp QR, pick the group, type the PDF name, paste your free Groq key (console.groq.com/keys) - Gemini key is an optional backup
4. Connect TickTick (developer.ticktick.com -> New app, redirect URL http://localhost:8765/callback)
5. Press "Save & run now". It then runs daily at your chosen time.
Installers: `npm run dist:win` (on Windows) / `npm run dist:mac` (on Mac)

TickTick tab (next to Activity): Today / Tomorrow / Next 7 Days / All, all your lists, search, quick add ("Buy pens tomorrow !high"), tap a task to edit notes, date, priority and subtasks, tap the circle to complete.
It uses the TickTick connection from Setup. If it asks you to reconnect, press "Connect TickTick" once more.
TickTick tab modes: Tasks (with High/Medium/Low priority filters, group by date or priority), Matrix (Eisenhower - drag tasks between the 4 boxes) and Focus (Pomodoro timer with task link, daily stats, custom durations).

## New in v6 (by Seif)
- Hello intro, then straight into the home screen with widgets and app icons (the swipe-to-unlock lock screen was removed).
- Liquid-glass time wheel and TickTick-style date picker (calendar, task sheet, daily check).
- Calendar in the Dynamic Island: press and hold the island to expand it (School Sync status + calendar + add events).
- Sync AI: the liquid ball in the corner (drag it, click it, or press Ctrl+K). It uses the same Gemini key as the PDF reader, can see your calendar and tasks, accepts images/PDFs, and can add events and TickTick tasks for you. Select any text in the app and tap "Ask AI".
- Setup > Version shows the creator line. Turn the intro or the AI ball off in Setup > App.

## AI engine (v6.1)
- Sync AI and the PDF reader use Groq first (about 1 second per answer), then Gemini, then an optional local Ollama model (no limits, works offline).
- If one provider is busy, out of free quota, or does not answer within 15 seconds, the next one is used automatically.
- Pictures and scanned PDFs need a Gemini key (Groq reads the text of normal PDFs).
- Run `npm install` again once (a new package, pdf-parse, was added).
