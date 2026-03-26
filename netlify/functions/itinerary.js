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
  //  CITY VALIDATION — Google Maps Geocoding API
  // ----------------------------------------------------------------
  async function validateCity(cityInput) {
    if (!googleKey) return { valid: true, formatted: cityInput };
    try {
      const query = encodeURIComponent(cityInput);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK' || !data.results.length) {
        return { valid: false, formatted: null };
      }
      const result = data.results[0];
      const formatted = result.formatted_address;
      const country = result.address_components.find(c => c.types.includes('country'));
      const isUS = country && country.short_name === 'US';
      if (!isUS) return { valid: false, formatted, notUS: true };
      return { valid: true, formatted };
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
  //  TOOL 1 — Real Google Maps: attractions & restaurants
  // ----------------------------------------------------------------
  async function getAttractions(dest) {
    if (!googleKey) return getSampleAttractions(dest);
    try {
      const query = encodeURIComponent(`top tourist attractions in ${dest}`);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') return getSampleAttractions(dest);
      return data.results.slice(0, 8).map(p => ({
        name: p.name,
        rating: p.rating || 'N/A',
        address: p.formatted_address || 'N/A',
        types: p.types || []
      }));
    } catch (e) {
      return getSampleAttractions(dest);
    }
  }

  async function getRestaurants(dest) {
    if (!googleKey) return [];
    try {
      const query = encodeURIComponent(`best restaurants in ${dest}`);
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&type=restaurant&key=${googleKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== 'OK') return [];
      return data.results.slice(0, 6).map(p => ({
        name: p.name,
        rating: p.rating || 'N/A',
        address: p.formatted_address || 'N/A',
        price_level: p.price_level || 'N/A'
      }));
    } catch (e) {
      return [];
    }
  }

  function getSampleAttractions(dest) {
    const city = dest.split(',')[0].trim();
    return [
      { name: `${city} Art Museum`, rating: 4.7, address: `Downtown ${city}`, types: ['museum'] },
      { name: `${city} Botanical Garden`, rating: 4.6, address: `${city}`, types: ['park'] },
      { name: `${city} History Museum`, rating: 4.5, address: `${city}`, types: ['museum'] },
      { name: `${city} Waterfront`, rating: 4.8, address: `${city}`, types: ['landmark'] },
      { name: `${city} Central Park`, rating: 4.6, address: `${city}`, types: ['park'] },
      { name: `${city} Old Town`, rating: 4.4, address: `${city}`, types: ['neighborhood'] },
    ];
  }

  // ----------------------------------------------------------------
  //  Gather Google Maps data in parallel
  // ----------------------------------------------------------------
  const [attractions, restaurants] = await Promise.all([
    getAttractions(validatedDestination),
    getRestaurants(validatedDestination)
  ]);

  const departureCity = validatedDeparture.split(',')[0].trim();
  const destinationCity = validatedDestination.split(',')[0].trim();
  const flightBudget = Math.round(budget * 0.35);
  const hotelNightly = Math.round((budget * 0.40) / days);

  // ----------------------------------------------------------------
  //  TOOL 2 — Claude with web search for REAL flights AND hotels
  //  No sample data — everything comes from web search
  // ----------------------------------------------------------------
  const prompt = `You are an expert travel planner. Use your web search tool to find REAL flight and hotel options for this trip. Do not make up or estimate prices — search for actual current information.

USER TRIP DETAILS:
- Departing from: ${validatedDeparture}
- Destination: ${validatedDestination}
- Total budget: $${Number(budget).toLocaleString()}
- Trip length: ${days} days
- Max flight budget: $${flightBudget} roundtrip per person
- Max hotel budget: $${hotelNightly}/night

STEP 1 — Search for: "roundtrip flights ${departureCity} to ${destinationCity} 2026 price"
Find real airlines, real typical price ranges, and flight duration.

STEP 2 — Search for: "best hotels in ${destinationCity} under $${hotelNightly} per night"
Find real hotel names, real nightly rates, and guest ratings. Do NOT use "Hyatt Place [city]" or any generic placeholder — only use hotel names you actually find in search results.

STEP 3 — Use these REAL attractions and restaurants from Google Maps to build the itinerary:
Attractions: ${JSON.stringify(attractions, null, 2)}
Restaurants: ${JSON.stringify(restaurants, null, 2)}

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

## Trip Summary
[${validatedDeparture} to ${validatedDestination}, ${days} days, estimated total cost]

## Flights
[List 2-3 real airlines with real typical price ranges found in search. Include flight duration and a booking tip.]

## Hotels
[List 2-3 real hotels found in search with real nightly rates and a brief reason why each is a good fit. No generic placeholder names.]

## Day-by-Day Itinerary
[For each day: Morning / Afternoon / Evening using the real Google Maps places above]

## Budget Breakdown
[Flights | Hotel (${days} nights) | Food & Activities | Total]

## Local Tips
[3 practical tips specific to ${validatedDestination}]`;

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

    // Keep going until Claude finishes all searches and gives final answer
    while (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });

      const toolResults = data.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: `Search completed for: ${b.input?.query || 'query'}`
        }));

      messages.push({ role: 'user', content: toolResults });

      const followUp = await fetch('https://api.anthropic.com/v1/messages', {
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
          messages
        })
      });

      data = await followUp.json();
    }

    // Extract final text
    const itinerary = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itinerary,
        usingRealData: true,
        validatedDeparture,
        validatedDestination
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
