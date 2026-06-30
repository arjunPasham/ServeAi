const DEV_MODE = !process.env.SMARTY_AUTH_ID;

interface ValidationResult {
  valid: boolean;
  standardized?: {
    deliveryLine: string;
    city: string;
    state: string;
    zipCode: string;
  };
  lat?: number;
  lng?: number;
  error?: string;
}

export async function validateUSAddress(address: string): Promise<ValidationResult> {
  if (DEV_MODE) {
    // In dev mode accept any non-empty address and return synthetic coords
    if (!address.trim()) {
      return { valid: false, error: 'Address is required' };
    }
    return {
      valid: true,
      standardized: {
        deliveryLine: address,
        city: 'Detroit',
        state: 'MI',
        zipCode: '48201',
      },
      lat: 42.3314 + (Math.random() - 0.5) * 0.1,
      lng: -83.0458 + (Math.random() - 0.5) * 0.1,
    };
  }

  try {
    const params = new URLSearchParams({
      street: address,
      candidates: '1',
      'auth-id': process.env.SMARTY_AUTH_ID!,
      'auth-token': process.env.SMARTY_AUTH_TOKEN!,
    });

    const response = await fetch(
      `https://us-street.api.smarty.com/street-address?${params}`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      return { valid: false, error: 'SMARTY_API_ERROR' };
    }

    const data = await response.json();
    if (!data.length) {
      return { valid: false, error: 'ADDRESS_NOT_FOUND' };
    }

    const result = data[0];
    const components = result.components;
    const metadata = result.metadata;

    return {
      valid: true,
      standardized: {
        deliveryLine: result.delivery_line_1,
        city: components.city_name,
        state: components.state_abbreviation,
        zipCode: components.zipcode,
      },
      lat: metadata.latitude,
      lng: metadata.longitude,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SMARTY_ERROR';
    return { valid: false, error: message };
  }
}
