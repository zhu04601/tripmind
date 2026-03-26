exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { departure, destination, budget, days } = JSON.parse(event.body || '{}');

  if (!departure || !destination || !budget || !days) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured.' }) };
  }

  // ----------------------------------------------------------------
  //  CITY VALIDATION
  // ----------------------------------------------------------------
  async function validateCity(cityInput) {
    if (!googleKey) return { valid: true, formatted: cityInput };
    try {
      const query = encodeURIComponent(cityInput);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK' || !data.results.length) return { valid: false };
      const result = data.results[0];
      const country = result.address_components.find(c => c.types.includes('country'));
      const isUS = country && country.short_name === 'US';
      if (!isUS) return { valid: false, notUS: true };
      return { valid: true, formatted: result.formatted_address };
    } catch (e) {
      return { valid: true, formatted: cityInput };
    }
  }

  const [departureCheck, destinationCheck] = await Promise.all([
    validateCity(departure),
    validateCity(destination)
  ]);

  if (!departureCheck.valid) {
    const msg = departureCheck.notUS
      ? `"${departure}" doesn't appear to be a US city. TripMind currently supports domestic US travel only.`
      : `We couldn't find "${departure}". Please check the spelling — e.g. "Minneapolis, MN".`;
    return { statusCode: 400, body: JSON.stringify({ error: msg }) };
  }

  if (!destinationCheck.valid) {
    const msg = destinationCheck.notUS
      ? `"${destination}" doesn't appear to be a US city. TripMind currently supports domestic US travel only.`
      : `We couldn't find "${destination}". Please check the spelling — e.g. "Chicago, IL".`;
    return { statusCode: 400, body: JSON.stringify({ error: msg }) };
  }

  if (departureCheck.formatted && destinationCheck.formatted &&
      departureCheck.formatted === destinationCheck.formatted) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Departure and destination appear to be the same city. Please enter different cities.' }) };
  }

  const validatedDeparture = departureCheck.formatted || departure;
  const validatedDestination = destinationCheck.formatted || destination;

  // ----------------------------------------------------------------
  //  GOOGLE MAPS — real attractions & restaurants with photos
  // ----------------------------------------------------------------
  async function getPlaces(query, maxResults = 8) {
    if (!googleKey) return [];
    try {
      const q = encodeURIComponent(query);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') return [];
      return data.results.slice(0, maxResults).map(p => {
        const photoRef = p.photos && p.photos[0] ? p.photos[0].photo_reference : null;
        const photoUrl = photoRef
          ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoRef}&key=${googleKey}`
          : null;
        return {
          name: p.name,
          rating: p.rating || 'N/A',
          address: p.formatted_address || 'N/A',
          maps_url: `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
          photo_url: photoUrl
        };
      });
    } catch (e) {
      return [];
    }
  }

  const [attractions, restaurants] = await Promise.all([
    getPlaces(`top tourist attractions in ${validatedDestination}`),
    getPlaces(`best restaurants in ${validatedDestination}`, 6)
  ]);

  const flightBudget = Math.round(budget * 0.35);
  const hotelNightly = Math.round((budget * 0.40) / days);
  const departureCity = validatedDeparture.split(',')[0].trim();
  const destinationCity = validatedDestination.split(',')[0].trim();

  // ----------------------------------------------------------------
  //  CLAUDE — uses knowledge (no web search, stays under 10s)
  //  Returns structured JSON
  // ----------------------------------------------------------------
  const prompt = `You are an expert US travel planner with deep knowledge of flights, hotels, and destinations. Generate a realistic travel plan using your knowledge — do not search the web.

TRIP:
- From: ${validatedDeparture}
- To: ${validatedDestination}
- Total budget: $${Number(budget).toLocaleString()}
- Days: ${days}
- Max flight budget: $${flightBudget} roundtrip
- Max hotel budget: $${hotelNightly}/night

REAL PLACES from Google Maps (use these exactly for the itinerary):
Attractions: ${JSON.stringify(attractions.map(a => ({ name: a.name, rating: a.rating, maps_url: a.maps_url })))}
Restaurants: ${JSON.stringify(restaurants.map(r => ({ name: r.name, rating: r.rating, maps_url: r.maps_url })))}

Using your knowledge of this specific route (${departureCity} to ${destinationCity}), provide:
1. Realistic flight options with typical prices for this route (use real airlines that serve this route)
2. Real hotel names in ${destinationCity} that fit the budget (use actual well-known hotels)
3. A day-by-day itinerary using the real Google Maps places above

Return ONLY valid JSON, no markdown, no extra text:
{
  "summary": "string",
  "flights": [
    { "airline": "string", "price": "string", "duration": "string", "tip": "string" }
  ],
  "hotels": [
    { "name": "real hotel name", "price": "string e.g. $120/night", "rating": "string", "highlight": "string" }
  ],
  "days": [
    {
      "day": 1,
      "title": "string",
      "morning": { "activity": "string", "place": "exact name from Google Maps list above", "maps_url": "exact maps_url from list" },
      "afternoon": { "activity": "string", "place": "exact name", "maps_url": "exact maps_url" },
      "evening": { "activity": "string", "place": "exact restaurant name", "maps_url": "exact maps_url" }
    }
  ],
  "budget_breakdown": {
    "flights": "string",
    "hotel": "string",
    "food_activities": "string",
    "total": "string"
  },
  "tips": ["string", "string", "string"]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API error');
    }

    const data = await response.json();
    const rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const structured = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!structured) throw new Error('Could not parse itinerary. Please try again.');

    // Build photo map keyed by place name
    const photoMap = {};
    [...attractions, ...restaurants].forEach(p => {
      if (p.photo_url) photoMap[p.name] = p.photo_url;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structured, photoMap, validatedDeparture, validatedDestination })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
