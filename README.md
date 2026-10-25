# RoadRanger AI

Real-map route planner: road distance, travel time by car / motorbike / bus / bicycle / walking,
weather, nearby places and a built-in AI route advisor. Plain HTML + CSS + JavaScript. No build step, no API keys.

## Run it in VS Code
1. **File → Open Folder…** and choose the `road-ranger` folder.
2. Install the recommended extension **Live Server** (VS Code will suggest it).
3. Right-click `index.html` → **Open with Live Server** (or click **Go Live** in the status bar).
4. Or, with Node installed: `npm start`.

Use Live Server or `npm start` rather than double-clicking the file. The free place-search service works best when the page is served over http.
An internet connection is required (map tiles, routing, search, weather).

## What it does
- Search any place with a live dropdown, click the map, or drag the A/B pins.
- Up to 8 stops. Reverse the route, use "My location".
- Road distance vs straight-line distance, travel time, arrival time, cost, CO2 and calories for 5 ways to travel.
- Traffic level and departure time change the estimates instantly.
- **AI route advisor**: scores every option for your priority (fastest, cheapest, greenest, healthiest, balanced), adjusts for weather and rush hour, and explains why.
- Weather at the destination, nearby fuel / food / hospital / ATM / hotel / parking.
- Turn-by-turn directions, trip simulation animation, GPX export, shareable link, recent routes, km/mi, dark mode.
- Optional "Ask Claude" box: paste your own Anthropic API key to ask questions about the trip.

## Files
- `index.html` page layout
- `css/style.css` look and feel (highway-sign theme)
- `js/app.js` all logic. Edit `CONFIG` and `MODES` at the top to change costs, speeds, currency, or the Claude model.

## How the numbers are calculated (say this in your presentation)
- Distance and car duration come from real road routing (OSRM on OpenStreetMap data).
- Car time is free-flow time times a traffic factor (light 1.0, normal 1.25, heavy 1.6). Motorbike and bus are adjusted from the car route; the bus is an estimate, not a timetable.
- Walking uses 5 km/h and cycling 15 km/h along real foot and bike paths.
- Costs, CO2 and calories are typical averages, editable in `MODES`.

## 5-minute demo script
1. Click **Present**. Search a start and destination from the dropdown.
2. Show the green sign (distance and time), then switch between the five travel modes.
3. Open **AI route advisor**; change "What matters most?" to Lowest emissions and watch the pick change.
4. Set Traffic to Heavy and show the times update.
5. Drag a pin, add a stop, then press **Simulate trip**.
6. Show weather and nearby hospitals or fuel at the destination.
7. Copy the link and open it in a new tab to show it restores the trip.

## Notes
Free public services are used (Nominatim, OSRM demo, Overpass, Open-Meteo). They are fine for demos; for a production app, host your own or use a paid provider.
