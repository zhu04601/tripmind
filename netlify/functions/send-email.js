exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { email, itinerary, destination, departure, days, budget, extraPlaces, weather, departureDate, returnDate } = JSON.parse(event.body || '{}');

  if (!email || !itinerary) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing email or itinerary.' }) };
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured.' }) };
  }

  // Parse structured JSON itinerary
  let parsed = null;
  try { parsed = JSON.parse(itinerary); } catch(e) {}

  function buildEmailHtml(data) {
    let body = '';

    if (data.summary) {
      body += `<p style="font-size:15px;color:#3a3835;line-height:1.7;margin:0 0 20px;">${data.summary}</p>`;
    }

    if (data.flights && data.flights.length) {
      body += `<h2>✈️ Flights</h2>`;
      data.flights.forEach(f => {
        body += `<div style="background:#f5f2ec;border-radius:8px;padding:12px 16px;margin-bottom:8px;">
          <strong>${f.airline}</strong> — ${f.price}<br>
          <span style="color:#6b6760;font-size:13px;">${f.duration || ''} ${f.tip ? '· ' + f.tip : ''}</span>
        </div>`;
      });
    }

    if (data.hotels && data.hotels.length) {
      body += `<h2>🏨 Hotels</h2>`;
      data.hotels.forEach(h => {
        body += `<div style="background:#f5f2ec;border-radius:8px;padding:12px 16px;margin-bottom:8px;">
          <strong>${h.name}</strong> — ${h.price}<br>
          <span style="color:#6b6760;font-size:13px;">${h.highlight || ''}</span>
        </div>`;
      });
    }

    if (data.days && data.days.length) {
      body += `<h2>📅 Day-by-Day Itinerary</h2>`;
      data.days.forEach(day => {
        body += `<div style="border:1px solid #ece8df;border-radius:8px;overflow:hidden;margin-bottom:12px;">
          <div style="background:#1a6b4a;color:#fff;padding:10px 16px;font-weight:600;">
            Day ${day.day}${day.title ? ' — ' + day.title : ''}
          </div>`;
        ['morning','afternoon','evening'].forEach(time => {
          const slot = day[time];
          if (!slot) return;
          const emoji = time === 'morning' ? '☀️' : time === 'afternoon' ? '🌤️' : '🌙';
          body += `<div style="padding:10px 16px;border-bottom:1px solid #f5f2ec;">
            <span style="font-size:11px;text-transform:uppercase;color:#6b6760;letter-spacing:0.05em;">${emoji} ${time}</span><br>
            <span style="font-size:14px;color:#0f0e0c;">${slot.activity}</span>
            ${slot.place ? `<br><span style="font-size:12px;color:#1a6b4a;">📍 ${slot.place}</span>` : ''}
          </div>`;
        });
        body += `</div>`;
      });
    }

    if (data.budget_breakdown) {
      const b = data.budget_breakdown;
      body += `<h2>💰 Budget Breakdown</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:6px 0;border-bottom:1px solid #ece8df;">Flights</td><td style="text-align:right;font-weight:500;">${b.flights || '—'}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid #ece8df;">Hotel</td><td style="text-align:right;font-weight:500;">${b.hotel || '—'}</td></tr>
          <tr><td style="padding:6px 0;border-bottom:1px solid #ece8df;">Food & Activities</td><td style="text-align:right;font-weight:500;">${b.food_activities || '—'}</td></tr>
          <tr><td style="padding:6px 0;font-weight:700;color:#1a6b4a;">Total</td><td style="text-align:right;font-weight:700;color:#1a6b4a;">${b.total || '—'}</td></tr>
        </table>`;
    }

    if (data.tips && data.tips.length) {
      body += `<h2>💡 Local Tips</h2><ul style="padding-left:20px;color:#3a3835;font-size:14px;line-height:1.8;">`;
      data.tips.forEach(tip => { body += `<li>${tip}</li>`; });
      body += `</ul>`;
    }

    return body;
  }

  function buildWeatherHtml(forecast) {
    if (!forecast || !forecast.length) return '';
    function wIcon(code) {
      if (code >= 200 && code < 300) return '⛈️';
      if (code >= 500 && code < 600) return '🌧️';
      if (code >= 600 && code < 700) return '❄️';
      if (code === 800) return '☀️';
      if (code === 801) return '🌤️';
      if (code >= 802) return '☁️';
      return '🌡️';
    }
    let html = `<h2>🌤️ Weather Forecast</h2><table style="width:100%;border-collapse:collapse;">`;
    forecast.forEach((day, i) => {
      if (i % 4 === 0) html += '<tr>';
      const date = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      html += `<td style="padding:6px;text-align:center;vertical-align:top;">
        <div style="background:#f5f2ec;border-radius:8px;padding:8px;">
          <div style="font-size:11px;color:#6b6760;">${date}</div>
          <div style="font-size:1.4rem;">${wIcon(day.weather_code)}</div>
          <div style="font-size:13px;font-weight:600;">${Math.round(day.temp_max)}°/${Math.round(day.temp_min)}°F</div>
          <div style="font-size:11px;color:#6b6760;">${day.description}</div>
        </div>
      </td>`;
      if (i % 4 === 3 || i === forecast.length - 1) html += '</tr>';
    });
    html += '</table>';
    return html;
  }

  function buildExtraPlacesHtml(places) {
    if (!places || !places.length) return '';
    let html = `<h2>🗺️ More Places to Explore</h2>
      <table style="width:100%;border-collapse:collapse;">`;
    places.forEach((p, i) => {
      if (i % 3 === 0) html += `<tr>`;
      html += `<td style="width:33%;padding:6px;vertical-align:top;">
        <div style="background:#f5f2ec;border-radius:8px;padding:10px;">
          <div style="font-size:13px;font-weight:600;color:#0f0e0c;margin-bottom:2px;">${p.name}</div>
          ${p.rating && p.rating !== 'N/A' ? `<div style="font-size:12px;color:#6b6760;">★ ${p.rating}</div>` : ''}
          ${p.maps_url ? `<a href="${p.maps_url}" style="font-size:11px;color:#1a6b4a;text-decoration:none;">View on Maps →</a>` : ''}
        </div>
      </td>`;
      if (i % 3 === 2 || i === places.length - 1) html += `</tr>`;
    });
    html += `</table>`;
    return html;
  }

  const emailBody = (parsed ? buildEmailHtml(parsed) : `<pre style="white-space:pre-wrap;font-size:14px;line-height:1.8;">${itinerary}</pre>`) + buildWeatherHtml(weather) + buildExtraPlacesHtml(extraPlaces);

  // Build a clean HTML email
  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;background:#f5f2ec;margin:0;padding:20px;color:#0f0e0c;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#1a6b4a;color:#fff;padding:28px 32px;">
      <h1 style="font-size:24px;margin:0 0 6px;letter-spacing:-0.02em;">Your TripMind Itinerary ✈️</h1>
      <p style="font-size:14px;opacity:0.85;margin:0;">${departure} → ${destination} · ${departureDate ? departureDate + ' to ' + (returnDate || '') + ' · ' : ''}${days} days · $${Number(budget).toLocaleString()} budget</p>
    </div>
    <div style="padding:28px 32px;">
      <style>h2{font-size:18px;color:#1a6b4a;margin:24px 0 10px;border-bottom:1px solid #ece8df;padding-bottom:8px;}</style>
      ${emailBody}
    </div>
    <div style="background:#f5f2ec;padding:18px 32px;font-size:12px;color:#b5b2ac;text-align:center;">
      Generated by TripMind · SEIS 666 Track B Project · Jay Zhu · Spring 2026
    </div>
  </div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'TripMind <onboarding@resend.dev>',
        to: [email],
        subject: `Your ${destination} Itinerary${departureDate ? ' · ' + departureDate : ''} — TripMind`,
        html: emailHtml
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Email send failed');
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
