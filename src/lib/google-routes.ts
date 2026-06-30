const DEV_MODE = !process.env.GOOGLE_ROUTES_API_KEY;

const BASE_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

interface LatLng {
  latitude: number;
  longitude: number;
}

interface RouteResult {
  durationSeconds: number;
  distanceMeters: number;
  etaMinutes: number;
}

export async function computeRoute(
  origin: LatLng,
  destination: LatLng,
  travelMode: 'DRIVE' | 'TWO_WHEELER' = 'DRIVE'
): Promise<RouteResult | null> {
  if (DEV_MODE) {
    // Return a plausible synthetic ETA in dev mode
    const distanceMeters = Math.sqrt(
      Math.pow((destination.latitude - origin.latitude) * 111000, 2) +
      Math.pow((destination.longitude - origin.longitude) * 111000, 2)
    );
    return {
      durationSeconds: Math.round(distanceMeters / 8), // ~30 km/h average
      distanceMeters: Math.round(distanceMeters),
      etaMinutes: Math.round(distanceMeters / 8 / 60),
    };
  }

  try {
    const body = {
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode,
      routingPreference: 'TRAFFIC_AWARE',
    };

    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_ROUTES_API_KEY!,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const route = data.routes?.[0];
    if (!route) return null;

    const durationSeconds = parseInt(route.duration?.replace('s', '') ?? '0', 10);
    const distanceMeters = route.distanceMeters ?? 0;

    return {
      durationSeconds,
      distanceMeters,
      etaMinutes: Math.ceil(durationSeconds / 60),
    };
  } catch {
    return null;
  }
}

export async function getEtaMinutes(
  courierLat: number,
  courierLng: number,
  destLat: number,
  destLng: number
): Promise<number | null> {
  const result = await computeRoute(
    { latitude: courierLat, longitude: courierLng },
    { latitude: destLat, longitude: destLng }
  );
  return result?.etaMinutes ?? null;
}
