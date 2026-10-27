SCHOOL SYNC  -  WhatsApp school PDF -> TickTick (free)
=======================================================

START HERE: open SETUP-GUIDE.pdf for the full step-by-step guide.

WHAT IT DOES
Every day at the time you choose, it checks one WhatsApp group (or a community's
Announcements), downloads the school PDF, lets a free AI read it, and adds a task
to your TickTick list with the date and one checkbox per subject.

WHAT YOU NEED (all free)
1. Node.js (LTS)        -> nodejs.org
2. Git                  -> git-scm.com   (install it first, click Next on everything)
3. A Gemini API key     -> aistudio.google.com/apikey
4. A TickTick developer app -> developer.ticktick.com -> New App
      OAuth redirect URL must be exactly:  http://localhost:8765/callback
      Copy the Client ID and Client Secret.

FIRST RUN
- Windows: double-click  start.bat      (first time takes a few minutes)
- Mac:     double-click  start.command  (if blocked: right-click -> Open)

THEN, INSIDE THE APP
1. Setup -> WhatsApp: scan the QR code (WhatsApp -> Linked devices), pick the group.
   For a community, open it and choose "Announcements".
2. Setup -> AI: paste your Gemini key. Edit "About the student" and "Subject order".
3. Setup -> TickTick: paste Client ID + Secret, press Connect, then choose your list.
4. Setup -> Schedule: choose the time.
5. Home -> "Save & run now" to test.

AUTO START
Put a shortcut to start.bat in the Startup folder (Windows key + R, type shell:startup).
The computer must be on and awake at the chosen time.

GOOD TO KNOW
- It uses an unofficial WhatsApp library. This is against WhatsApp's terms and there is
  a small risk to the account. Consider using a spare number.
- Your keys and settings are stored only on your own computer, not inside this folder.
- If Gemini says "busy", it retries by itself. You can also press Run again later.
- Each person must use their OWN Gemini key and TickTick app. Do not share them.

TickTick tab (next to Activity): Today / Tomorrow / Next 7 Days / All, all your lists, search, quick add ("Buy pens tomorrow !high"), tap a task to edit notes, date, priority and subtasks, tap the circle to complete.
It uses the TickTick connection from Setup. If it asks you to reconnect, press "Connect TickTick" once more.
TickTick tab modes: Tasks (with High/Medium/Low priority filters, group by date or priority), Matrix (Eisenhower - drag tasks between the 4 boxes) and Focus (Pomodoro timer with task link, daily stats, custom durations).

NEW IN V6 (by Seif)
- Lock-screen entrance + iPhone-style home.
- Press and hold the Dynamic Island to open the calendar and add events.
- Sync AI liquid ball in the corner (Ctrl+K). Uses your Gemini key.
