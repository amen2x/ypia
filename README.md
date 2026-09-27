# Y.P.I.A (Your Parent Is Aging)

**One calm place where an aging parent stays independent and their family stays close.**
Built at **TigerHacks 2026**.
**[Live Demo](https://yourparentsareaging.duckdns.org)**  
**[Devpost](PASTE-DEVPOST-LINK-HERE)**

![Family dashboard](docs/images/family-dashboard.png)

---

## Table of Contents
- [Overview](#overview)
- [Our Story](#our-story)
- [The Problem We're Solving](#the-problem-were-solving)
- [Features](#features)
- [How the Scores Work](#how-the-scores-work)
- [How to Use](#how-to-use)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Data We Use and Collect](#data-we-use-and-collect)
- [Known Limitations](#known-limitations)
- [Getting Started](#getting-started)
- [The Team](#the-team)
- [AI Acknowledgment](#ai-acknowledgment)

---

## Overview
Y.P.I.A is a web app with two sides:

- **For the parent:** a simple, large-text page with a voice assistant, document upload, and brain games.
- **For the family:** a caregiver dashboard that brings her calendar, a weekly check-in streak, a mood chart, a to-do list, documents, and a doctor-visit summary into one place.

Both sides share one database, so what the parent does shows up for the family, and what the family plans shows up for the parent.

---

## Our Story
Ten years ago, I watched my great-grandmother slowly decline, both mentally and physically. Like many families, we felt it together, especially my mother and grandmother, who carried much of her care. They kept track of her doctor's appointments, sorted through insurance paperwork and phone calls, and made sure nothing slipped through the cracks, all while managing their own jobs and lives. That experience stayed with me. Our elders deserve dignity, autonomy, and connection in the later years of their lives, and so do the children and grandchildren who care for them. That is why our team chose to build this project for TigerHacks.

---

## The Problem We're Solving
Aging often starts with small changes: a missed pill, a forgotten appointment, a word that takes longer to find. Parents tend to brush it off, and children who live far away usually find out only when something goes wrong. Y.P.I.A gives families one simple place to stay connected and notice these changes early, while the parent stays independent.

### What we built
- **For the parent:** a voice assistant that knows her schedule, medications, and background; document upload, where Gemini reads a prescription or visit summary and she confirms it before it is added to her care information; and brain games (trivia about her own life and interests, Sudoku, and Solitaire).
- **For the family:** one dashboard with her calendar and points for her activities, a weekly check-in streak, a shared to-do list, shared documents, a doctor-visit summary, and a mood chart that adds a "check in" reminder after 4 low days in a row.

### Our thought process
- **We designed for two people:** the aging parent and their adult child. The parent's side had to be simple (large text, voice, few steps). The child's side had to fit on one calm page.
- **Everyday activities instead of tests:** games she enjoys quietly record her accuracy and speed, and her calendar shows which events she attended or missed.
- **AI helps, but people decide:** the parent confirms what Gemini reads, the backend double-checks what Gemini suggests, and the points are motivational, not medical.
- **Connection, not surveillance:** the streak asks for just one check-in a week, and we chose not to track location.

| Our first idea map | How we planned to measure it |
|---|---|
| ![Idea map](docs/images/idea-map.png) | ![How we measure](docs/images/how-we-measure.png) |

### What we didn't do (future work)
- The mood chart and the family's prescriptions view use sample data; connecting them to real data is next.
- Game accuracy and speed are recorded but not yet shown as a chart for the family.
- The "Fact-check that message" tab is designed but not built.
- Ideas we planned but did not build yet: movement data from Apple Health / Google Health, photo memories described by voice, and alerts to the family when trends drop.
- Y.P.I.A is a hackathon prototype: it does not diagnose anything, and sign-in security is basic.

---

## Features

### For the parent
- **Voice assistant (ElevenLabs):** tap to talk. It can look up her schedule, next appointment, medications, recent changes, and background, and it can send a request to her family's to-do list. After a conversation, Gemini suggests facts worth remembering, and the backend checks each one before saving it.
- **Document upload:** upload a prescription, visit summary, or appointment sheet. Gemini pulls out medications and appointments, medication names are matched with RxNorm, and she reviews the result ("Does this look correct?") before it is added to her care information.
- **Brain games:** Trivia, Sudoku (6x6), and Solitaire (Klondike), with large text and simple controls.
- **Her own weekly streak:** grows each week she plays a game.

### For the family
- **Weekly check-in streak:** press "I checked on ..." at least once a week to keep the streak going.
- **Calendar:** upcoming and past events, with attended or missed status, engagement points reviewed by Gemini, and a 7-day summary ("400 of 500 points earned, 4 of 5 events attended").
- **Mood chart:** a monthly view with "Examine" and "Summary" buttons, and an automatic "check in" to-do after 4 low days in a row (sample data for now).
- **To-do list:** set urgency, drag to reorder, track progress, and add an item to Google Calendar in one click. Requests the parent makes by voice show up here.
- **Documents:** the documents the parent has uploaded, in one place.
- **Summary report:** talking points for the next doctor visit.

---

## How the Scores Work
- **Trivia:** 10 questions. Questions 1, 5, and 10 are about her own life (facts saved in her profile, or a recent event from her calendar). The other 7 are about her interests and are written by Gemini, with a backup question bank if Gemini is slow. We save her accuracy, her accuracy on the memory questions, and her average seconds per answer. A short survey after the game asks what she enjoyed.
- **Sudoku and Solitaire:** every move is timed and marked as allowed or not allowed. We save the average seconds per move, the number of wrong moves, and long pauses.
- **Trends:** the game numbers are grouped by week so changes can be followed over time (available through the API, not yet charted).
- **Calendar points:** for each day, Gemini splits 100 points across that day's events based on planning effort, social connection, and how much they matter to her routine. Attended events earn their points; missed events earn 0. These points are motivational only, not a health measure.
- **Family streak:** weeks run Sunday to Saturday. Checking in again the same week keeps the number; checking in the next week adds 1; missing a whole week starts over at 1.
- **Mood status:** the last 7 logged days give "Doing well", "Mixed", or "Needs attention".

---

## How to Use
1. **Sign up the parent** on the sign-up page.
2. **Sign up a family member** using the parent's email so the two accounts are linked.
3. **Log in as the parent** to talk to the assistant, upload documents, and play games.
4. **Log in as the family member** to see the dashboard: check in, review the calendar (press "Review points with Gemini"), follow the mood chart, and manage to-dos.

---

## Tech Stack

- **Frontend:**
  [![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
  [![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
  [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
  [![Jinja2](https://img.shields.io/badge/Jinja2-B41717?logo=jinja&logoColor=white)](https://jinja.palletsprojects.com/)

- **Backend:**
  [![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Flask](https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com/)
  [![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
  [![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)](https://expressjs.com/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

- **Database:**
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
  [![Tiger Data](https://img.shields.io/badge/Tiger_Data-FDB515)](https://www.tigerdata.com/)

- **AI and APIs:**
  [![Google Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?logo=googlegemini&logoColor=white)](https://ai.google.dev/)
  [![ElevenLabs](https://img.shields.io/badge/ElevenLabs-000000?logo=elevenlabs&logoColor=white)](https://elevenlabs.io/)
  [![RxNorm](https://img.shields.io/badge/RxNorm-205493)](https://www.nlm.nih.gov/research/umls/rxnorm/)

- **Development:**
  [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/)

---

## Architecture
```mermaid
flowchart LR
  P[Parent page] --> F[Flask web server]
  C[Family dashboard] --> F
  F -->|/api requests| A[Express + TypeScript API]
  A --> D[(PostgreSQL on Tiger Data)]
  A --> G[Google Gemini]
  A --> E[ElevenLabs voice]
  A --> R[RxNorm]
```
- **Flask** serves the pages and forwards `/api` requests to the backend.
- **Express + TypeScript** holds the app logic, validates requests, and talks to the database and AI services.
- **PostgreSQL on Tiger Data** stores everything both sides share.

---

## Data We Use and Collect
- **Accounts:** name, email, role, and a bcrypt-hashed password.
- **Parent profile:** background notes (family, interests, routine) and facts remembered from voice conversations.
- **Calendar:** events, attended or missed status, and engagement points.
- **Health documents:** uploaded files and the medications and appointments extracted from them.
- **Games:** answers, move timings, and the post-game survey.
- **Check-ins and streaks** for both the parent and the family.

**Shared with third-party services:** document contents and game prompts go to Google Gemini, voice conversations go through ElevenLabs, and medication names are looked up in RxNorm.

---

## Known Limitations
- **Sign-in is basic:** the browser keeps the logged-in user in local storage, and the API trusts the user id it receives. There are no session tokens yet, so this is not ready for real patient data.
- **Some views use sample data:** the mood chart, the prescriptions view, and "Records at a glance".
- **AI can be wrong:** that is why the parent confirms documents and the backend re-checks AI suggestions.
- **Not a medical device:** Y.P.I.A does not diagnose anything.

---

## Getting Started

**You need:** Node.js 20+, Python 3.9+, and a PostgreSQL database (we used Tiger Data).

1. **Clone the repo**
```sh
   git clone https://github.com/ttttoyahh/Tigerhacks2026.git
   cd Tigerhacks2026
```
2. **Create `backend/.env`**
```sh
   DATABASE_URL=postgres://user:password@host:port/dbname
   GEMINI_API_KEY=your-gemini-key
   ELEVENLABS_API_KEY=your-elevenlabs-key
   ELEVENLABS_AGENT_ID=your-agent-id
```
3. **Set up the database:** the SQL files are in `backend/migrations/`, and `backend/schedule_seed.sql` adds a sample calendar.
4. **Start everything**
   - Mac/Linux: `chmod +x ./setup.sh && ./setup.sh`
   - Windows: `./setup.bat`

   Or start the two servers by hand:
```sh
   # Terminal 1: backend (port 3000)
   cd backend && npm install && npm run start

   # Terminal 2: website (port 5000)
   python3 -m venv .venv && source .venv/bin/activate
   pip install flask && python app.py
```
5. **Open** http://127.0.0.1:5000. On a Mac, use `127.0.0.1` rather than `localhost`, because AirPlay can also use port 5000.

---

## The Team
- Joey
- Tiyah
- Alain
- Amen

---

## AI Acknowledgment
- **Inside the product:** Google Gemini reads documents, writes trivia questions, reviews calendar points, and suggests facts to remember. ElevenLabs powers the voice assistant.
- **While building:** our team used AI coding assistants, including Claude, to help write, debug, and test code and to edit this README. We reviewed and tested what we submitted, and we take responsibility for it.
