# TripMind — AI Travel Itinerary Agent
**SEIS 666 — Track B Agentic AI System | Jay Zhu | Spring 2026**

A user-friendly web app that generates complete day-by-day US travel itineraries. Users just enter a destination, budget, and trip length — no API keys, no setup.

---

## Deploy to Netlify (free, 5 minutes)

### Step 1 — Push to GitHub
1. Create a free account at github.com
2. Create a new repository called `tripmind`
3. Upload all files in this folder to the repo

### Step 2 — Connect to Netlify
1. Go to netlify.com and sign up free
2. Click "Add new site" → "Import an existing project"
3. Connect your GitHub account and select the `tripmind` repo
4. Leave all build settings as default — click "Deploy site"

### Step 3 — Add your API key (this keeps it secret from users)
1. In Netlify, go to Site settings → Environment variables
2. Click "Add a variable"
3. Key: `ANTHROPIC_API_KEY`
4. Value: your Claude API key (starts with `sk-ant-...`)
5. Click Save — then go to Deploys and click "Trigger deploy"

Your site is now live at a public URL like `https://tripmind-abc123.netlify.app`

---

## How It Works

```
User enters: destination + budget + days
        ↓
index.html sends POST to /api/itinerary
        ↓
netlify/functions/itinerary.js (server — API key is hidden here)
        ↓
Calls Claude API with research data
        ↓
Returns itinerary → displayed to user
```

## File Structure
```
tripmind/
├── index.html                    ← frontend (what users see)
├── netlify.toml                  ← Netlify config
├── README.md                     ← this file
└── netlify/functions/
    └── itinerary.js              ← serverless function (API key lives here)
```

## Before / After
| | Before | After |
|---|---|---|
| Time to plan | 3–5 hours | Under 2 minutes |
| Tools needed | 4+ websites | Single web form |
| Budget tracking | Manual | Automatic |
| Output | Browser tabs | Structured itinerary |
