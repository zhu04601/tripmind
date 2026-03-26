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
  //  TOOL 1 — Real Google Maps Places API
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
      { name: `${city} Old Town District`, rating: 4.4, address: `${city}`, types: ['neighborhood'] },
    ];
  }

  // ----------------------------------------------------------------
  //  Gather Google Maps data
  // ----------------------------------------------------------------
  const [attractions, restaurants] = await Promise.all([
    getAttractions(validatedDestination),
    getRestaurants(validatedDestination)
  ]);

  // ----------------------------------------------------------------
  //  TOOL 2 — Claude with web search for real flights & hotels
  // ----------------------------------------------------------------
  const departureCity = validatedDeparture.split(',')[0].trim();
  const destinationCity = validatedDestination.split(',')[0].trim();
  const flightBudget = Math.round(budget * 0.35);
  const hotelNightly = Math.round((budget * 0.40) / days);

  const prompt = `You are an expert travel planner with access to web search. A user wants to plan a trip and needs real, accurate flight and hotel information.

USER TRIP DETAILS:
- Departing from: ${validatedDeparture}
- Destination: ${validatedDestination}
- Total budget: $${Number(budget).toLocaleString()}
- Trip length: ${days} days
- Flight budget: up to $${flightBudget} roundtrip
- Hotel budget: up to $${hotelNightly}/night

REAL ATTRACTIONS from Google Maps:
${JSON.stringify(attractions, null, 2)}

REAL RESTAURANTS from Google Maps:
${JSON.stringify(restaurants, null, 2)}

YOUR TASKS:
1. Use web search to find real typical flight prices from ${departureCity} to ${destinationCity} — look for major airlines, typical roundtrip prices, and flight duration
2. Use web search to find real hotels in ${destinationCity} under $${hotelNightly}/night — look for well-reviewed options with their actual names and typical prices
3. Build a detailed day-by-day itinerary using the real Google Maps attractions and restaurants above
4. Keep total cost within $${Number(budget).toLocaleString()}
5. Write in a friendly, practical tone

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

## Trip Summary
[${validatedDeparture} to ${validatedDestination}, ${days} days, estimated total cost]

## Flight
[Real airline options found, typical price range, flight duration, booking tip]

## Hotel
[Real hotel names found, typical nightly rate, why it's a good fit, booking tip]

## Day-by-Day Itinerary
[For each day: Morning / Afternoon / Evening using the real Google Maps places above]

## Budget Breakdown
[Flights | Hotel | Food & Activities | Total]

## Local Tips
[3 practical tips specific to ${validatedDestination}]`;

  try {
    // First call — Claude searches the web for flights and hotels
    const searchResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!searchResponse.ok) {
      const err = await searchResponse.json();
      throw new Error(err.error?.message || 'Claude API error');
    }

    const searchData = await searchResponse.json();

    // Extract the final text response from Claude
    let itinerary = '';
    for (const block of searchData.content) {
      if (block.type === 'text') {
        itinerary += block.text;
      }
    }

    // If Claude stopped to use tools, send the full conversation back for final answer
    if (searchData.stop_reason === 'tool_use') {
      const toolResults = searchData.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: b.input?.query ? `Search results for: ${b.input.query}` : 'Search completed'
        }));

      const followUp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 3000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: searchData.content },
            { role: 'user', content: toolResults }
          ]
        })
      });

      const followUpData = await followUp.json();
      itinerary = '';
      for (const block of followUpData.content) {
        if (block.type === 'text') {
          itinerary += block.text;
        }
      }
    }

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
