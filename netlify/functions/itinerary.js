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
  //  GOOGLE MAPS — attractions, restaurants with photos & place IDs
  // ----------------------------------------------------------------
  async function getPlaces(query, type = null) {
    if (!googleKey) return [];
    try {
      const q = encodeURIComponent(query);
      const typeParam = type ? `&type=${type}` : '';
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${q}${typeParam}&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') return [];
      return data.results.slice(0, 8).map(p => {
        const photoRef = p.photos && p.photos[0] ? p.photos[0].photo_reference : null;
        const photoUrl = photoRef
          ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoRef}&key=${googleKey}`
          : null;
        const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${p.place_id}`;
        return {
          name: p.name,
          rating: p.rating || 'N/A',
          address: p.formatted_address || 'N/A',
          place_id: p.place_id,
          photo_url: photoUrl,
          maps_url: mapsUrl,
          types: p.types || []
        };
      });
    } catch (e) {
      return [];
    }
  }

  const [attractions, restaurants] = await Promise.all([
    getPlaces(`top tourist attractions in ${validatedDestination}`),
    getPlaces(`best restaurants in ${validatedDestination}`, 'restaurant')
  ]);

  const destinationCity = validatedDestination.split(',')[0].trim();
  const departureCity = validatedDeparture.split(',')[0].trim();
  const flightBudget = Math.round(budget * 0.35);
  const hotelNightly = Math.round((budget * 0.40) / days);

  // ----------------------------------------------------------------
  //  CLAUDE with web search — returns structured JSON
  // ----------------------------------------------------------------
  const prompt = `You are an expert travel planner. Use web search to find REAL flight and hotel info. Return a structured JSON response only.

TRIP:
- From: ${validatedDeparture}
- To: ${validatedDestination}
- Budget: $${Number(budget).toLocaleString()}
- Days: ${days}
- Max flight budget: $${flightBudget} roundtrip
- Max hotel budget: $${hotelNightly}/night

STEP 1: Search "roundtrip flights ${departureCity} to ${destinationCity} 2026 price"
STEP 2: Search "best hotels ${destinationCity} under $${hotelNightly} per night reviews"

REAL PLACES from Google Maps (use these for the itinerary, include name and maps_url exactly as given):
Attractions: ${JSON.stringify(attractions.map(a => ({ name: a.name, rating: a.rating, address: a.address, maps_url: a.maps_url })))}
Restaurants: ${JSON.stringify(restaurants.map(r => ({ name: r.name, rating: r.rating, address: r.address, maps_url: r.maps_url })))}

Return ONLY valid JSON in this exact structure, no markdown, no extra text:
{
  "summary": "string describing the trip and total estimated cost",
  "flights": [
    { "airline": "string", "price": "string e.g. $97-$142 roundtrip", "duration": "string", "tip": "string" }
  ],
  "hotels": [
    { "name": "real hotel name from search", "price": "string e.g. $99/night", "rating": "string", "highlight": "string", "tip": "string" }
  ],
  "days": [
    {
      "day": 1,
      "title": "string e.g. Arrival & The Loop",
      "morning": { "activity": "string", "place": "exact place name from Google Maps list", "maps_url": "exact maps_url from Google Maps list or empty string" },
      "afternoon": { "activity": "string", "place": "exact place name", "maps_url": "exact maps_url or empty string" },
      "evening": { "activity": "string", "place": "exact restaurant name", "maps_url": "exact maps_url or empty string" }
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
        max_tokens: 5000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API error');
    }

    let data = await response.json();
    let messages = [{ role: 'user', content: prompt }];

    while (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = data.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: `Search completed for: ${b.input?.query || 'query'}` }));
      messages.push({ role: 'user', content: toolResults });

      const followUp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 5000, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages })
      });
      data = await followUp.json();
    }

    const rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const structured = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    // Build photo map from Google Maps results
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
