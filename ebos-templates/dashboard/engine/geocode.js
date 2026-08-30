// Turns a plain address string ("12 Allen Avenue, Ikeja") into map
// coordinates -- Chowdeck's Relay fee endpoint (delivery.js) requires real
// latitude/longitude, address text alone isn't enough.
export async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocoding request failed: ${res.status}`);
  const data = await res.json();
  const location = data?.results?.[0]?.geometry?.location;
  if (!location) throw new Error(`geocoding found no match for "${address}" (status: ${data?.status})`);
  return { latitude: location.lat, longitude: location.lng };
}
