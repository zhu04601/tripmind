exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { destination, budget, days } = JSON.parse(event.body || '{}');

  if (!destination || !budget || !days) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured.' }) };
  }

  function getSampleFlights(destination, budget) {
    const city = destination.split(',')[0].trim();
    return [
      { airline: 'Delta Airlines', route: `MSP → ${city}`, price_roundtrip: Math.round(budget * 0.28), stops: 'Nonstop', departure: '7:00 AM' },
      { airline: 'United Airlines', route: `MSP → ${city}`, price_roundtrip: Math.round(budget * 0.22), stops: '1 stop', departure: '11:15 AM' },
      { airline: 'American Airlines', route: `MSP → ${city}`, price_roundtrip: Math.round(budget * 0.25), stops: 'Nonstop', departure: '6:00 PM' },
    ].filter(f => f.price_roundtrip <= budget * 0.4);
  }

  function getSampleHotels(destination, budget, days) {
    const city = destination.split(',')[0].trim();
    const nightly = Math.round((budget * 0.4) / days);
    return [
      { name: `Marriott ${city}`, stars: 4, price_per_night: Math.round(nightly * 1.1), amenities: ['Free WiFi', 'Pool', 'Gym'] },
      { name: `Hilton Garden Inn ${city}`, stars: 3, price_per_night: Math.round(nightly * 0.85), amenities: ['Free WiFi', 'Parking'] },
      { name: `Hyatt Place ${city}`, stars: 3, price_per_night: Math.round(nightly * 0.75), amenities: ['Free WiFi', 'Free Breakfast'] },
    ];
  }

  function getSampleAttractions(destination) {
    const city = destination.split(',')[0].trim();
    return [
      { name: `${city} Art Museum`, rating: 4.7 },
      { name: `${city} Botanical Garden`, rating: 4.6 },
      { name: `${city} History Museum`, rating: 4.5 },
      { name: `${city} Waterfront`, rating: 4.8 },
      { name: `${city} Central Park`, rating: 4.6 },
      { name: `${city} Old Town District`, rating: 4.4 },
    ];
  }

  const flights = getSampleFlights(destination, budget);
  const hotels = getSampleHotels(destination, budget, days);
  const attractions = getSampleAttractions(destination);

  const prompt = `You are an expert travel planner. Build a complete, practical day-by-day US travel itinerary from this research data.

USER INPUT:
- Destination: ${destination}
- Total budget: $${Number(budget).toLocaleString()}
- Trip length: ${days} days

FLIGHT OPTIONS:
${JSON.stringify(flights, null, 2)}

HOTEL OPTIONS:
${JSON.stringify(hotels, null, 2)}

TOP ATTRACTIONS:
${JSON.stringify(attractions, null, 2)}

YOUR TASK:
1. Pick the best-value flight and hotel within budget
2. Build a detailed day-by-day itinerary using the attractions
3. Track spending and stay within the $${Number(budget).toLocaleString()} budget
4. Write in a friendly, practical tone

FORMAT:
## Trip Summary
[Destination, ${days} days, estimated total cost]

## Flight
[Chosen flight, price, brief reason]

## Hotel
[Chosen hotel, nightly rate, total lodging cost, brief reason]

## Day-by-Day Itinerary
[For each day: Morning / Afternoon / Evening with specific places]

## Budget Breakdown
[Flights | Hotel | Food & Activities | Total]

## Local Tips
[3 practical tips specific to ${destination}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return { statusCode: 502, body: JSON.stringify({ error: err.error?.message || 'Claude API error' }) };
    }

    const data = await response.json();
    const itinerary = data.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
